import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { atomicWrite } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { packagePath } from '../utils/schema.js';
import { findUnfinishedRuns, type UnfinishedRunNotice } from '../execution/recovery.js';
import { synchronizeProject, type SyncReport, type SynchronizeProjectOptions } from './index.js';
import type { Host } from '../workflow/types.js';

export interface ProjectGateInput {
  host: Host;
  event: string;
  sessionId: string;
  cwd: string;
  toolName?: string;
  toolInput?: unknown;
  /** Host-mounted workspace roots, when the native payload exposes them. */
  workspacePaths?: string[];
}

export interface ProjectGateOptions extends Pick<SynchronizeProjectOptions, 'runGit'> {
  runtimeDirectory?: string;
}

/** Read-only unfinished-run notice attached to a phase-entry result. */
export interface ProjectGateExecutionNotice {
  unfinished: UnfinishedRunNotice[];
  warnings: string[];
}

/**
 * Compact fingerprint of the on-disk project contract. The gate exposes this reference
 * instead of embedding the contract body in its result context.
 */
export interface ProjectGateAuthorityRef {
  path: string;
  digest: string;
  bytes: number;
}

export interface ProjectGateResult {
  decision: 'allow' | 'deny' | 'skip';
  project: string;
  report?: SyncReport;
  context: string;
  authority_ref?: ProjectGateAuthorityRef;
  exemption?: 'sync_actor' | 'authority_read';
  execution?: ProjectGateExecutionNotice;
}

const authorityPaths = new Set([
  '.ai-workflow/AGENTS.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
]);

function doubleQuoted(path: string): string { return `"${path.replace(/["\\$`]/g, '\\$&')}"`; }

/** True when `child` is `parent` itself or lies below it after lexical resolution. */
function workspaceContains(parent: string, child: string): boolean {
  const location = relative(resolve(parent), resolve(child));
  return location === '' || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`));
}

/**
 * Antigravity subagents cannot answer an out-of-workspace approval prompt within their
 * fixed window. A pending managed-file maintenance commit for a root outside every mounted
 * workspace would therefore time out instead of committing, so the gate rejects the phase
 * immediately with the exact recovery instead of letting the Git Operator wait.
 */
function antigravityWorkspaceDenial(input: ProjectGateInput, projectRoot: string, result: ProjectGateResult): string | undefined {
  if (input.host !== 'antigravity' || input.event === 'PhaseEntry') return undefined;
  if (!Array.isArray(input.workspacePaths) || input.workspacePaths.length === 0) return undefined;
  if (result.decision !== 'allow' || result.report === undefined) return undefined;
  const changed = [...result.report.created, ...result.report.updated];
  if (changed.length === 0) return undefined;
  if (input.workspacePaths.some((workspace) => workspaceContains(workspace, projectRoot))) return undefined;
  return `The actual project root ${projectRoot} is outside the Antigravity workspace ${input.workspacePaths.join(', ')}. The synchronization preflight updated ${changed.join(', ')} there, and the required maintenance commit cannot read or run Git outside the workspace without an approval that times out. Open ${projectRoot} as the workspace or add it with /add-dir ${projectRoot}, then resend the request; alternatively, commit exactly those paths yourself. No commit was attempted.`;
}

function operationDirectory(input: ProjectGateInput): string {
  const cwd = resolve(input.cwd);
  if (input.event === 'PhaseEntry' || input.toolInput === null || typeof input.toolInput !== 'object' || Array.isArray(input.toolInput)) return cwd;
  const args = input.toolInput as Record<string, unknown>;
  if ((input.toolName === 'Bash' || input.toolName === 'bash' || input.toolName === 'shell') && typeof args.workdir === 'string' && args.workdir !== '') return resolve(cwd, args.workdir);
  if (input.toolName === 'Read' || input.toolName === 'read') {
    const path = args.path ?? args.filePath ?? args.file_path;
    if (typeof path === 'string' && path !== '') return dirname(resolve(cwd, path));
  }
  // Antigravity names the read argument `Path`.
  if (input.toolName === 'read_file' && typeof args.Path === 'string' && args.Path !== '') return dirname(resolve(cwd, args.Path));
  return cwd;
}

/** The read tool's path argument: OpenCode 2.x names it `path`, older hosts `filePath`/`file_path`. */
function readToolPath(args: Record<string, unknown>): string | undefined {
  const path = args.path ?? args.filePath ?? args.file_path;
  return typeof path === 'string' && path !== '' ? path : undefined;
}

/** A synchronization actor command runs the sync or phase hook itself, never ordinary project work. */
function syncActorCommand(command: string, host: Host, projectRoot: string): boolean {
  const projectArguments = [doubleQuoted(projectRoot), `'${projectRoot.replace(/'/g, "'\\''")}'`];
  if (!/[\s"'\\`$;&|<>(){}*?]/.test(projectRoot) && !projectRoot.includes('[') && !projectRoot.includes(']')) projectArguments.push(projectRoot);
  const nativeExecutable = `${doubleQuoted(process.execPath)} ${doubleQuoted(packagePath('dist', 'cli.js'))}`;
  const executables = ['ai-workflow', nativeExecutable];
  const trimmed = command.trim();
  if (trimmed === `${nativeExecutable} sync-hook --host ${host}`) return true;
  for (const executable of executables) for (const project of projectArguments) {
    if (trimmed === `${executable} sync ${project}` || trimmed === `${executable} sync-hook --host ${host} --phase --project ${project}`) return true;
  }
  return false;
}

function toolExemption(input: ProjectGateInput, projectRoot: string): ProjectGateResult['exemption'] {
  if (input.event === 'PhaseEntry') return undefined;
  if (input.toolInput === null || typeof input.toolInput !== 'object' || Array.isArray(input.toolInput)) return undefined;
  const args = input.toolInput as Record<string, unknown>;
  if (input.toolName === 'Read' || input.toolName === 'read') {
    const path = readToolPath(args);
    if (path !== undefined && resolve(input.cwd, path) === join(projectRoot, '.ai-workflow/AGENTS.md')) return 'authority_read';
  }
  if (input.toolName === 'read_file' && typeof args.Path === 'string' && resolve(input.cwd, args.Path) === join(projectRoot, '.ai-workflow/AGENTS.md')) return 'authority_read';
  const command = (input.toolName === 'Bash' || input.toolName === 'bash' || input.toolName === 'shell') && typeof args.command === 'string'
    ? args.command
    : input.toolName === 'run_command' && typeof args.CommandLine === 'string' ? args.CommandLine : undefined;
  if (command !== undefined && syncActorCommand(command, input.host, projectRoot)) return 'sync_actor';
  return undefined;
}

interface ProjectGateUnit {
  version: 2;
  unit: string;
  phase: true;
  result: ProjectGateResult;
}

/** Accept only the compact reference shape; any other value invalidates the whole unit. */
function validAuthorityRef(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return typeof reference.path === 'string' && reference.path !== ''
    && typeof reference.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(reference.digest)
    && typeof reference.bytes === 'number' && Number.isInteger(reference.bytes) && reference.bytes > 0;
}

async function readUnit(path: string): Promise<ProjectGateUnit | undefined> {
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as {
      version?: unknown;
      unit?: unknown;
      phase?: unknown;
      result?: (ProjectGateResult & { authority?: unknown }) | null;
    } | null;
    const result = state?.result;
    if (state?.version !== 2 || typeof state.unit !== 'string' || !result
      || state.phase !== true
      || typeof result.project !== 'string' || typeof result.context !== 'string'
      || !['allow', 'deny', 'skip'].includes(result.decision)
      || result.authority !== undefined
      || !validAuthorityRef(result.authority_ref)) return undefined;
    if (result.decision === 'skip') {
      if (result.report !== undefined || result.authority_ref !== undefined) return undefined;
    } else {
      const report = result.report;
      if (!report || report.project !== result.project
        || typeof report.verified !== 'boolean' || report.proceed !== (result.decision === 'allow')
        || !['synchronized', 'unverified', 'needs_attention', 'pending', 'conflict', 'failed'].includes(report.status)
        || typeof report.check !== 'boolean' || !report.source
        || typeof report.source.repository !== 'string' || typeof report.source.branch !== 'string'
        || (report.source.commit !== null && typeof report.source.commit !== 'string')
        || ![report.created, report.updated, report.skipped].every((paths) => Array.isArray(paths) && paths.every((path) => typeof path === 'string'))
        || ![report.warnings, report.conflicts].every((entries) => Array.isArray(entries) && entries.every((entry) => entry !== null && typeof entry === 'object'
          && typeof entry.reason === 'string' && (entry.path === undefined || typeof entry.path === 'string')
          && (entry.section === undefined || typeof entry.section === 'string')))) return undefined;
    }
    return state as ProjectGateUnit;
  } catch { return undefined; }
}

function reportResult(report: SyncReport, reference?: ProjectGateAuthorityRef): ProjectGateResult {
  const context = [
    `ai-workflow sync: ${report.status}`,
    `Project: ${report.project}`,
    report.verified ? `Managed workflow artifacts are current at ${report.source.commit}.` : 'Managed workflow freshness is not verified.',
    ...(report.created.length ? [`Created: ${report.created.join(', ')}`] : []),
    ...(report.updated.length ? [`Updated: ${report.updated.join(', ')}`] : []),
    ...report.warnings.map((entry) => `Warning: ${[entry.path, entry.section, entry.reason].filter(Boolean).join(': ')}`),
    ...report.conflicts.map((entry) => `Conflict: ${[entry.path, entry.section, entry.reason].filter(Boolean).join(': ')}`),
    ...(reference === undefined ? [] : [
      `Project contract: ${reference.path}`,
      `Read the current project contract before ordinary work continues: ${reference.path}`,
    ]),
  ].join('\n');
  return { decision: report.proceed ? 'allow' : 'deny', project: report.project, report, context, ...(reference === undefined ? {} : { authority_ref: reference }) };
}

function lockDescription(lock: UnfinishedRunNotice['lock']): string {
  if (lock === 'stale') return 'lock is stale';
  if (lock === 'held') return 'lock is held by a live process';
  if (lock === 'other-host') return 'lock is held by another host';
  if (lock === 'unreadable') return 'lock is unreadable';
  return 'lock is not held';
}

function executionContextLine(run: UnfinishedRunNotice): string {
  return `Execution run ${run.plan_id} (run ${run.run_id}) is ${run.status}; ${lockDescription(run.lock)}; resume with ai-workflow execution resume --plan ${run.plan_directory}.`;
}

/** Discover the phase-entry execution notice without ever letting discovery fail the gate. */
async function executionNotice(projectRoot: string): Promise<ProjectGateExecutionNotice> {
  try {
    const discovery = await findUnfinishedRuns(projectRoot);
    return { unfinished: discovery.runs, warnings: discovery.warnings };
  } catch (error) {
    return {
      unfinished: [],
      warnings: [`Unable to discover unfinished execution runs: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function resolveAdoptedRoot(start: string): Promise<{ root: string; adopted: boolean }> {
  let projectRoot = start;
  while (true) {
    try {
      await stat(join(projectRoot, '.ai-workflow'));
      return { root: projectRoot, adopted: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(projectRoot);
    if (parent === projectRoot) return { root: start, adopted: false };
    projectRoot = parent;
  }
}

export interface StoredProjectGateInput {
  host: ProjectGateInput['host'];
  project: string;
  runtimeDirectory?: string;
}

/**
 * Read the stored phase result for an actual adopted root without running synchronization,
 * writing a unit or requesting the network. An absent, unreadable or mismatched unit is
 * reported as `undefined`.
 */
export async function readStoredProjectGate(input: StoredProjectGateInput): Promise<ProjectGateResult | undefined> {
  const resolved = await resolveAdoptedRoot(resolve(input.project));
  if (!resolved.adopted) return undefined;
  const runtimeDirectory = resolve(input.runtimeDirectory ?? join(tmpdir(), 'ai-workflow', 'project-gate'));
  const path = join(runtimeDirectory, input.host, `phase-${Buffer.from(resolved.root).toString('base64url')}.json`);
  const unit = await readUnit(path);
  return unit?.result.project === resolved.root ? unit.result : undefined;
}

export async function runProjectGate(input: ProjectGateInput, options: ProjectGateOptions = {}): Promise<ProjectGateResult> {
  const operationStart = operationDirectory(input);
  let projectRoot = operationStart;
  let report: SyncReport | undefined;
  let authorityRef: ProjectGateAuthorityRef | undefined;
  try {
    const resolved = await resolveAdoptedRoot(operationStart);
    projectRoot = resolved.root;
    if (!resolved.adopted) {
      return { decision: 'skip', project: projectRoot, context: `ai-workflow sync skipped: no adoption found for ${projectRoot}; no freshness claim is made.` };
    }
    const runtimeDirectory = resolve(options.runtimeDirectory ?? join(tmpdir(), 'ai-workflow', 'project-gate'));
    const hostRuntimeDirectory = join(runtimeDirectory, input.host);
    const runtimeLocation = relative(projectRoot, hostRuntimeDirectory);
    if (runtimeLocation === '' || (!isAbsolute(runtimeLocation) && runtimeLocation !== '..' && !runtimeLocation.startsWith(`..${sep}`))) {
      throw new Error('The gate runtime directory must be outside the adopted project');
    }
    const exemption = toolExemption(input, projectRoot);
    if (exemption === 'sync_actor') {
      return {
        decision: 'allow',
        project: projectRoot,
        exemption,
        context: `ai-workflow preflight exemption: ${exemption} for ${projectRoot}. Only this synchronization actor or contract read is permitted; no synchronization or freshness verification was performed. The ordinary project decision remains unchanged.`,
      };
    }
    const path = join(hostRuntimeDirectory, `phase-${Buffer.from(projectRoot).toString('base64url')}.json`);
    const previous = input.event === 'PhaseEntry' ? undefined : await readUnit(path);
    if (previous?.result.project === projectRoot) {
      const workspaceDenial = antigravityWorkspaceDenial(input, projectRoot, previous.result);
      if (workspaceDenial !== undefined) return { decision: 'deny', project: projectRoot, context: workspaceDenial };
    }
    if (exemption !== undefined) {
      return {
        decision: 'allow',
        project: projectRoot,
        exemption,
        context: `ai-workflow preflight exemption: ${exemption} for ${projectRoot}. Only this synchronization actor or contract read is permitted; no synchronization or freshness verification was performed. The ordinary project decision remains unchanged.`,
      };
    }
    if (input.event !== 'PhaseEntry') {
      if (previous?.result.project === projectRoot) return previous.result;
      return {
        decision: 'allow',
        project: projectRoot,
        context: `ai-workflow sync: no synchronization check has run for ${projectRoot}. Managed workflow freshness is not verified. A check runs when planning, coding or plan-to-tasks starts via ai-workflow sync-hook --host ${input.host} --phase --project ${doubleQuoted(projectRoot)}.`,
      };
    }
    report = await synchronizeProject({
      projectRoot,
      ...(options.runGit === undefined ? {} : { runGit: options.runGit }),
    });
    if (report.proceed && [...report.created, ...report.updated].some((path) => authorityPaths.has(path))) {
      const authorityPath = join(report.project, '.ai-workflow/AGENTS.md');
      const content = await readFile(authorityPath);
      authorityRef = { path: authorityPath, digest: sha256(content), bytes: Buffer.byteLength(content) };
    }
    const base = reportResult(report, authorityRef);
    const execution = await executionNotice(projectRoot);
    const noticeLines = execution.unfinished.map(executionContextLine).join('\n');
    const result: ProjectGateResult = {
      ...base,
      context: noticeLines.length === 0 ? base.context : `${base.context}\n${noticeLines}`,
      execution,
    };
    const unit: ProjectGateUnit = { version: 2, unit: randomUUID(), phase: true, result };
    await atomicWrite(path, `${JSON.stringify(unit)}\n`);
    return result;
  } catch (error) {
    const reason = `Project synchronization gate failed: ${error instanceof Error ? error.message : String(error)}`;
    report = {
      ...(report ?? {
        project: projectRoot,
        source: { repository: 'hengboy/ai-workflow', branch: 'main', commit: null },
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
