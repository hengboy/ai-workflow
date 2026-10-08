import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { atomicWrite } from '../utils/fs.js';
import { packagePath } from '../utils/schema.js';
import { synchronizeProject, type SyncReport, type SynchronizeProjectOptions } from './index.js';

export interface ProjectGateInput {
  host: 'opencode' | 'claude' | 'codex';
  event: string;
  eventSource?: string;
  sessionId: string;
  cwd: string;
  parentSessionId?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface ProjectGateOptions extends Pick<SynchronizeProjectOptions, 'fetch' | 'env'> {
  runtimeDirectory?: string;
}

export interface ProjectGateResult {
  decision: 'allow' | 'deny' | 'skip';
  project: string;
  report?: SyncReport;
  context: string;
  authority?: string;
  exemption?: 'sync_actor' | 'authority_read';
}

const authorityPaths = new Set([
  '.ai-workflow/AGENTS.md',
  'MEMORY.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
]);

function doubleQuoted(path: string): string { return `"${path.replace(/["\\$`]/g, '\\$&')}"`; }

function operationDirectory(input: ProjectGateInput): string {
  const cwd = resolve(input.cwd);
  if (input.event === 'PhaseEntry' || input.toolInput === null || typeof input.toolInput !== 'object' || Array.isArray(input.toolInput)) return cwd;
  const args = input.toolInput as Record<string, unknown>;
  if ((input.toolName === 'Bash' || input.toolName === 'bash') && typeof args.workdir === 'string' && args.workdir !== '') return resolve(cwd, args.workdir);
  if (input.toolName === 'Read' || input.toolName === 'read') {
    const path = args.filePath ?? args.file_path;
    if (typeof path === 'string' && path !== '') return dirname(resolve(cwd, path));
  }
  return cwd;
}

function toolExemption(input: ProjectGateInput, projectRoot: string): ProjectGateResult['exemption'] {
  if (input.event === 'PhaseEntry') return undefined;
  if (input.toolInput === null || typeof input.toolInput !== 'object' || Array.isArray(input.toolInput)) return undefined;
  const args = input.toolInput as Record<string, unknown>;
  if (input.toolName === 'Read' || input.toolName === 'read') {
    const path = args.filePath ?? args.file_path;
    if (typeof path === 'string' && resolve(input.cwd, path) === join(projectRoot, '.ai-workflow/AGENTS.md')) return 'authority_read';
  }
  if ((input.toolName === 'Bash' || input.toolName === 'bash') && typeof args.command === 'string') {
    const projectArguments = [doubleQuoted(projectRoot), `'${projectRoot.replace(/'/g, "'\\''")}'`];
    if (!/[\s"'\\`$;&|<>(){}*?]/.test(projectRoot) && !projectRoot.includes('[') && !projectRoot.includes(']')) projectArguments.push(projectRoot);
    const nativeExecutable = `${doubleQuoted(process.execPath)} ${doubleQuoted(packagePath('dist', 'cli.js'))}`;
    const executables = ['ai-workflow', nativeExecutable];
    const command = args.command.trim();
    if (command === `${nativeExecutable} sync-hook --host ${input.host}`) return 'sync_actor';
    for (const executable of executables) for (const project of projectArguments) {
      if (command === `${executable} sync ${project}` || command === `${executable} sync-hook --host ${input.host} --phase --project ${project}`) return 'sync_actor';
    }
  }
  return undefined;
}

interface ProjectGateUnit {
  version: 1;
  unit: string;
  phase?: true;
  result: ProjectGateResult;
}

async function readUnit(path: string): Promise<ProjectGateUnit | undefined> {
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as {
      version?: unknown;
      unit?: unknown;
      phase?: unknown;
      result?: ProjectGateResult | null;
    } | null;
    const result = state?.result;
    if (state?.version !== 1 || typeof state.unit !== 'string' || !result
      || (state.phase !== undefined && state.phase !== true)
      || typeof result.project !== 'string' || typeof result.context !== 'string'
      || !['allow', 'deny', 'skip'].includes(result.decision)
      || (result.authority !== undefined && typeof result.authority !== 'string')) return undefined;
    if (result.decision === 'skip') {
      if (result.report !== undefined || result.authority !== undefined) return undefined;
    } else if (!result.report || result.report.project !== result.project
      || typeof result.report.verified !== 'boolean' || result.report.proceed !== (result.decision === 'allow')
      || !['synchronized', 'unverified', 'needs_attention', 'pending', 'conflict', 'failed'].includes(result.report.status)) return undefined;
    return state as ProjectGateUnit;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function reportResult(report: SyncReport, authority?: string): ProjectGateResult {
  const context = [
    `ai-workflow sync: ${report.status}`,
    `Project: ${report.project}`,
    report.verified ? `Managed workflow artifacts are current at ${report.source.commit}.` : 'Managed workflow freshness is not verified.',
    ...(report.created.length ? [`Created: ${report.created.join(', ')}`] : []),
    ...(report.updated.length ? [`Updated: ${report.updated.join(', ')}`] : []),
    ...report.warnings.map((entry) => `Warning: ${[entry.path, entry.section, entry.reason].filter(Boolean).join(': ')}`),
    ...report.conflicts.map((entry) => `Conflict: ${[entry.path, entry.section, entry.reason].filter(Boolean).join(': ')}`),
    ...(authority === undefined ? [] : ['Read the current project contract before ordinary work continues:', authority]),
  ].join('\n');
  return { decision: report.proceed ? 'allow' : 'deny', project: report.project, report, context, ...(authority === undefined ? {} : { authority }) };
}

export async function runProjectGate(input: ProjectGateInput, options: ProjectGateOptions = {}): Promise<ProjectGateResult> {
  const operationStart = operationDirectory(input);
  let projectRoot = operationStart;
  let report: SyncReport | undefined;
  let authority: string | undefined;
  try {
    let adopted = false;
    while (true) {
      try { await stat(join(projectRoot, '.ai-workflow')); adopted = true; break; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      }
      const parent = dirname(projectRoot);
      if (parent === projectRoot) {
        projectRoot = operationStart;
        break;
      }
      projectRoot = parent;
    }
    const exemption = adopted ? toolExemption(input, projectRoot) : undefined;
    if (exemption !== undefined) {
      return {
        decision: 'allow',
        project: projectRoot,
        exemption,
        context: `ai-workflow preflight exemption: ${exemption} for ${projectRoot}. Only this synchronization actor or contract read is permitted; no synchronization or freshness verification was performed. The ordinary project decision remains unchanged.`,
      };
    }
    const runtimeDirectory = resolve(options.runtimeDirectory ?? join(tmpdir(), 'ai-workflow', 'project-gate'));
    const hostRuntimeDirectory = join(runtimeDirectory, input.host);
    const runtimeLocation = relative(projectRoot, hostRuntimeDirectory);
    if (adopted && (runtimeLocation === '' || (!isAbsolute(runtimeLocation) && runtimeLocation !== '..' && !runtimeLocation.startsWith(`..${sep}`)))) {
      throw new Error('The gate runtime directory must be outside the adopted project');
    }
    const sessionPath = (sessionId: string): string => join(hostRuntimeDirectory, `session-${Buffer.from(sessionId).toString('base64url')}.json`);
    const phasePath = (project: string): string => join(hostRuntimeDirectory, `phase-${Buffer.from(project).toString('base64url')}.json`);
    const phaseEntry = input.event === 'PhaseEntry';
    const path = phaseEntry ? phasePath(projectRoot) : sessionPath(input.sessionId);
    const ownUnit = phaseEntry ? undefined : await readUnit(path);
    const parentUnit = input.parentSessionId === undefined ? undefined : await readUnit(sessionPath(input.parentSessionId));
    const parentAtRoot = adopted && parentUnit?.result.project === projectRoot && parentUnit.result.decision !== 'skip';
    const boundary = ['SessionStart', 'UserPromptSubmit'].includes(input.event);
    const rootChanged = !parentAtRoot && ownUnit !== undefined && ownUnit.result.project !== projectRoot;
    const resetPhase = phaseEntry || (!parentAtRoot && (boundary || rootChanged));
    if (resetPhase) {
      await rm(phasePath(projectRoot), { force: true });
      if (rootChanged && ownUnit) await rm(phasePath(ownUnit.result.project), { force: true });
    }
    const phaseUnit = !resetPhase && adopted ? await readUnit(phasePath(projectRoot)) : undefined;
    const currentPhase = phaseUnit?.phase && phaseUnit.result.project === projectRoot && phaseUnit.result.decision !== 'skip' ? phaseUnit : undefined;
    const inherited = parentAtRoot && (!parentUnit.phase || parentUnit.unit === currentPhase?.unit);
    const previous = phaseEntry ? undefined : currentPhase ?? (inherited ? parentUnit : boundary || rootChanged || ownUnit?.phase ? undefined : ownUnit);
    if (previous?.result.project === projectRoot && (previous.result.decision === 'skip') === !adopted) {
      if (inherited || currentPhase) await atomicWrite(path, `${JSON.stringify(previous)}\n`);
      return previous.result;
    }
    await rm(path, { force: true });
    let result: ProjectGateResult;
    if (!adopted) {
      result = { decision: 'skip', project: projectRoot, context: `ai-workflow sync skipped: no adoption found for ${projectRoot}; no freshness claim is made.` };
    } else {
      report = await synchronizeProject({
        projectRoot,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      if (report.proceed && [...report.created, ...report.updated].some((path) => authorityPaths.has(path))) {
        authority = await readFile(join(report.project, '.ai-workflow/AGENTS.md'), 'utf8');
      }
      result = reportResult(report, authority);
    }
    const unit: ProjectGateUnit = { version: 1, unit: randomUUID(), ...(phaseEntry ? { phase: true as const } : {}), result };
    await atomicWrite(path, `${JSON.stringify(unit)}\n`);
    return result;
  } catch (error) {
    const reason = `Project synchronization gate failed: ${error instanceof Error ? error.message : String(error)}`;
    report = {
      ...(report ?? {
        project: projectRoot,
        source: { repository: 'hengboy/ai-workflow', branch: 'simplify', commit: null },
        check: false,
        created: [],
        updated: [],
        skipped: [],
        conflicts: [],
      }),
      status: 'failed',
      verified: false,
      proceed: false,
      warnings: [...(report?.warnings ?? []), { reason }],
    };
    return reportResult(report);
  }
}
