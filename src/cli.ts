#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Host } from './workflow/types.js';
import { activateProfile, install, uninstall, initializeProject, upgradeProject } from './install/index.js';
import { synchronizeProject } from './sync/index.js';
import { runProjectGate } from './sync/gate.js';
import { createNavigationCandidate, rebuildNavigation, refreshContext, refreshNavigationMarkdown, validateContext, verifyNavigation } from './context/validate.js';
import { locateContext } from './context/locate.js';
import { discoverFallback, type FallbackPacket } from './context/fallback.js';
import { resolveCandidatePath, resolveProjectRoot } from './context/paths.js';
import { renderReviewPacket, type ReviewAxis, type ReviewMode, type ReviewPacketRequest, type ReviewPurpose } from './workflow/review-packet.js';
import { planDispatch } from './workflow/dispatch.js';
import { planReport } from './workflow/report.js';
import { validatePlanDirectory } from './workflow/validate.js';
import { listPlanPairs, recordPlanPairs, verifyPlanPairs } from './workflow/pairing.js';
import { runDoctor } from './ops/doctor.js';
import { distributeWorkspace } from './workspace/distribute.js';
import { workspaceStatus } from './workspace/status.js';
import { auditWorkspace } from './workspace/audit.js';
import { checkpointWorkspace } from './workspace/execution.js';
import { listNotes } from './notes/index.js';
import { validateNotes } from './notes/validate.js';
import { sealArchive } from './notes/archive.js';
import { listPairs, recordPairs, verifyPairs } from './notes/pair.js';

const hosts = ['codex', 'claude', 'opencode'] as const;
function hostList(value: string): Host[] { if (value === 'all') return [...hosts]; if (!hosts.includes(value as Host)) throw new Error(`Invalid host: ${value}`); return [value as Host]; }
async function jsonFile<T>(path: string): Promise<T> { return JSON.parse(await readFile(resolve(path), 'utf8')) as T; }
function print(value: unknown): void { process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`); }

interface NativeHookInput {
  cwd: string;
  session_id: string;
  hook_event_name: 'PreToolUse' | 'SessionStart' | 'UserPromptSubmit';
  source?: string;
  tool_name?: string;
  tool_input?: unknown;
}

async function nativeHookInput(): Promise<NativeHookInput> {
  process.stdin.setEncoding('utf8');
  let contents = '';
  for await (const chunk of process.stdin as AsyncIterable<string>) contents += chunk;
  const input: unknown = JSON.parse(contents);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Native hook input must be a JSON object');
  const data = input as Record<string, unknown>;
  if (typeof data.cwd !== 'string' || data.cwd === '' || typeof data.session_id !== 'string' || data.session_id === ''
    || typeof data.hook_event_name !== 'string' || !['PreToolUse', 'SessionStart', 'UserPromptSubmit'].includes(data.hook_event_name)
    || (data.source !== undefined && typeof data.source !== 'string')
    || (data.tool_name !== undefined && typeof data.tool_name !== 'string')) throw new Error('Native hook input has invalid event, cwd or session fields');
  return data as unknown as NativeHookInput;
}

/** Read the whole standard input stream, used for the single checkpoint event. */
async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let contents = '';
  for await (const chunk of process.stdin as AsyncIterable<string>) contents += chunk;
  return contents;
}

const program = new Command().name('ai-workflow').description('Native-host planning and task workflow').version('0.1.0');
function opencodeVersionOption(value: string): 'v1' | 'v2' | 'auto' { if (value === 'v1' || value === 'v2' || value === 'auto') return value; throw new Error(`Invalid opencode version: ${value}`); }
program.command('install').requiredOption('--host <host>').option('--home <path>').option('--opencode-version <version>', 'opencode agent format: v1, v2 or auto (default auto)', 'auto').action(async ({ host, home, opencodeVersion }: { host: string; home?: string; opencodeVersion: string }) => print(await install(hostList(host), { ...(home ? { home } : {}), opencodeVersion: opencodeVersionOption(opencodeVersion) })));
program.command('uninstall').requiredOption('--host <host>').option('--home <path>').action(async ({ host, home }: { host: string; home?: string }) => print(await uninstall(hostList(host), { ...(home ? { home } : {}) })));
program.command('init').argument('[project]').option('--upgrade', 'replace the generated workflow documents from shipped templates in an existing project').action(async (project: string | undefined, { upgrade }: { upgrade?: boolean }) => {
  if (!upgrade) { print({ created: await initializeProject(project ?? process.cwd()) }); return; }
  const report = await upgradeProject(project ?? process.cwd());
  print(report);
  process.exitCode = report.status === 'synchronized' ? 0 : report.status === 'unverified' || report.status === 'needs_attention' ? 2 : 1;
});
program.command('sync').argument('[project]').option('--check', 'report pending synchronization without writing').action(async (project: string | undefined, { check }: { check?: boolean }) => {
  const report = await synchronizeProject({ projectRoot: project ?? process.cwd(), check: Boolean(check) });
  print(report);
  process.exitCode = report.status === 'synchronized' ? 0 : report.status === 'unverified' || report.status === 'needs_attention' ? 2 : 1;
});
program.command('sync-hook').requiredOption('--host <host>').option('--phase', 'begin a synchronization phase for the actual project').option('--project <project>', 'actual project root for --phase').action(async ({ host, phase, project }: { host: string; phase?: boolean; project?: string }) => {
  if (!hosts.includes(host as Host)) throw new Error(`Invalid host: ${host}`);
  if (phase) {
    if (!project) throw new Error('--phase requires --project with the actual project root');
    // PhaseEntry is keyed by the project, not by a native host session.
    print(await runProjectGate({ host: host as Host, event: 'PhaseEntry', sessionId: '', cwd: project }));
    process.exitCode = 0;
    return;
  }
  if (project !== undefined) throw new Error('--project is only supported with --phase');
  const input = await nativeHookInput();
  const result = await runProjectGate({
    host: host as Host,
    event: input.hook_event_name,
    sessionId: input.session_id,
    cwd: input.cwd,
    ...(input.tool_name === undefined ? {} : { toolName: input.tool_name }),
    ...(input.tool_input === undefined ? {} : { toolInput: input.tool_input }),
  });
  if (host === 'opencode') {
    print(result);
  } else {
    const deny = result.decision === 'deny';
    const context = deny && input.hook_event_name === 'SessionStart'
      ? `${result.context}\nSessionStart supplies context only; the next project PreToolUse will deny work while this blocking result remains current.`
      : result.context;
    print({
      systemMessage: context,
      ...(deny && input.hook_event_name === 'UserPromptSubmit' ? { decision: 'block', reason: result.context } : {}),
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: context,
        ...(deny && input.hook_event_name === 'PreToolUse' ? { permissionDecision: 'deny', permissionDecisionReason: result.context } : {}),
      },
    });
  }
  process.exitCode = 0;
});
program.command('doctor')
  .option('--project <root>', 'project root directory path; use . or an absolute path', process.cwd())
  .option('--host <host>', 'limit host checks to one host')
  .option('--plan <directory>', 'plan directory to validate')
  .option('--home <path>', 'installation root; defaults to the current user home')
  .option('--json', 'print the complete report structure')
  .action(async (options: { project: string; host?: string; plan?: string; home?: string; json?: boolean }) => {
    const report = await runDoctor({
      project: options.project,
      ...(options.host === undefined ? {} : { host: options.host as Host }),
      ...(options.plan === undefined ? {} : { plan: options.plan }),
      ...(options.home === undefined ? {} : { home: options.home }),
    });
    if (options.json) {
      print(report);
    } else {
      const summary = [`project: ${report.project ?? 'none'}`, `valid: ${report.valid}`];
      for (const item of report.checks) {
        summary.push(`${item.status} ${item.id}: ${item.detail}`);
        if (item.recovery !== undefined) summary.push(`  recovery: ${item.recovery}`);
      }
      print(summary.join('\n'));
    }
    process.exitCode = report.checks.some((item) => item.status === 'fail') ? 1 : report.checks.some((item) => item.status === 'warn') ? 2 : 0;
  });
const profile = program.command('profile');
profile.command('activate').argument('<name>').option('--home <path>').option('--opencode-version <version>', 'opencode agent format: v1, v2 or auto (default auto)', 'auto').action(async (name: string, { home, opencodeVersion }: { home?: string; opencodeVersion: string }) => print(await activateProfile(name, { ...(home ? { home } : {}), opencodeVersion: opencodeVersionOption(opencodeVersion) })));

const plan = program.command('plan');
plan.command('validate').requiredOption('--plan <directory>').action(async ({ plan: directory }: { plan: string }) => {
  print(await validatePlanDirectory(directory));
});
plan.command('dispatch')
  .requiredOption('--plan <directory>')
  .option('--phase <phase>', 'one-based phase number')
  .option('--task <id>', 'exactly one task id from the selected phase')
  .option('--verbose', 'include the text packet skeleton')
  .action(async ({ plan: directory, phase, task, verbose }: { plan: string; phase?: string; task?: string; verbose?: boolean }) => {
    const selectedPhase = phase === undefined ? undefined : Number(phase);
    const result = await planDispatch({
      planDirectory: directory,
      ...(selectedPhase === undefined ? {} : { phase: selectedPhase }),
      ...(task === undefined ? {} : { task }),
      ...(verbose ? { verbose: true } : {}),
    });
    print(result);
  });
plan.command('report').requiredOption('--plan <directory>').action(async ({ plan: directory }: { plan: string }) => {
  print(await planReport(directory));
});
plan.command('pairing')
  .requiredOption('--plan <directory>')
  .option('--list', 'report the pairing state of every plan document without failing')
  .option('--write', 'record the current English and Chinese bytes as the confirmed pair')
  .option('--all', 'with --write, re-record every complete pair')
  .argument('[documents...]', 'plan documents naming the pairs to check or record')
  .action(async (documents: string[], { plan: directory, list, write, all }: { plan: string; list?: boolean; write?: boolean; all?: boolean }) => {
    const target = directory;
    if (list && (write || all || documents.length > 0)) throw new Error('--list takes no other flags or documents');
    if (all && !write) throw new Error('--all only applies to --write');
    if (write) {
      if (documents.length > 0 && all) throw new Error('--write takes either plan documents or --all, not both');
      if (documents.length === 0 && !all) throw new Error('--write requires the plan documents you confirmed, or --all');
      print(await recordPlanPairs(target, documents, Boolean(all)));
      return;
    }
    if (list) {
      print(await listPlanPairs(target));
      return;
    }
    const result = await verifyPlanPairs(target, documents);
    print(result);
    if (!result.valid) process.exitCode = 1;
  });

interface ReviewPacketOptions {
  axis: string;
  mode: string;
  purpose: string;
  repository: string;
  contract: string;
  base: string;
  head: string;
  previousHead?: string;
  requirements?: string[];
  requirementScope?: string[];
  rawDiff?: string;
  repairDiff?: string;
  repairScope?: string[];
  sourceBlobs?: string[];
  committedTests?: string[];
  changedPaths?: string[];
  testReports?: string[];
  memory?: string;
  noteStandards?: string[];
  originalFindings?: string[];
  evidenceDir?: string;
}

const review = program.command('review');
review.command('packet')
  .requiredOption('--axis <axis>', 'review axis: spec or standards')
  .requiredOption('--mode <mode>', 'review mode: initial or recheck')
  .requiredOption('--purpose <purpose>', 'packet purpose: delivery or repository-local-finalization')
  .requiredOption('--repository <path>', 'absolute repository path')
  .requiredOption('--contract <path>', 'absolute project contract path')
  .requiredOption('--base <sha>', 'full delivery-base SHA')
  .requiredOption('--head <sha>', 'full checked-head SHA')
  .option('--previous-head <sha>', 'full immediately preceding reviewed-head SHA')
  .option('--requirements <path...>', 'absolute frozen requirement paths')
  .option('--requirement-scope <id...>', 'assigned requirement and AC references')
  .option('--raw-diff <path>', 'complete delivery diff path')
  .option('--repair-diff <path>', 'previous-head-to-head repair diff path')
  .option('--repair-scope <path...>', 'repaired paths, symbols and affected caller paths')
  .option('--source-blobs <path...>', 'immutable source-context paths')
  .option('--committed-tests <path...>', 'immutable test-source paths')
  .option('--changed-paths <path...>', 'exact authorized changed paths')
  .option('--test-reports <path...>', 'fresh test report paths')
  .option('--memory <path>', 'absolute MEMORY path')
  .option('--note-standards <path...>', 'applicable note-governance paths')
  .option('--original-findings <text...>', 'original finding labels and evidence references')
  .option('--evidence-dir <path>', 'base directory for relative evidence paths')
  .action(async (options: ReviewPacketOptions) => {
    const request: ReviewPacketRequest = {
      axis: options.axis as ReviewAxis,
      mode: options.mode as ReviewMode,
      purpose: options.purpose as ReviewPurpose,
      repository: options.repository,
      contract: options.contract,
      base: options.base,
      head: options.head,
      ...(options.previousHead === undefined ? {} : { previousHead: options.previousHead }),
      ...(options.requirements === undefined ? {} : { requirements: options.requirements }),
      ...(options.requirementScope === undefined ? {} : { requirementScope: options.requirementScope }),
      ...(options.rawDiff === undefined ? {} : { rawDiff: options.rawDiff }),
      ...(options.repairDiff === undefined ? {} : { repairDiff: options.repairDiff }),
      ...(options.repairScope === undefined ? {} : { repairScope: options.repairScope }),
      ...(options.sourceBlobs === undefined ? {} : { sourceBlobs: options.sourceBlobs }),
      ...(options.committedTests === undefined ? {} : { committedTests: options.committedTests }),
      ...(options.changedPaths === undefined ? {} : { changedPaths: options.changedPaths }),
      ...(options.testReports === undefined ? {} : { testReports: options.testReports }),
      ...(options.memory === undefined ? {} : { memory: options.memory }),
      ...(options.noteStandards === undefined ? {} : { noteStandards: options.noteStandards }),
      ...(options.originalFindings === undefined ? {} : { originalFindings: options.originalFindings }),
      ...(options.evidenceDir === undefined ? {} : { evidenceDir: options.evidenceDir }),
    };
    const { packet } = await renderReviewPacket(request);
    print(packet);
  });

const projectOption = 'project root directory path; use . or an absolute path';
const notes = program.command('notes');
notes.command('validate')
  .option('--project <project>', projectOption, process.cwd())
  .option('--base <commit>', 'compare the archive manifest at this pre-change commit')
  .action(async ({ project, base }: { project: string; base?: string }) => {
    const result = await validateNotes(project, base);
    print(result);
    if (!result.valid) process.exitCode = 1;
  });
notes.command('list').option('--project <project>', projectOption, process.cwd()).option('--archived').action(async ({ project, archived }: { project: string; archived?: boolean }) => {
  print({ entries: await listNotes(project, { archived: Boolean(archived) }) });
});
notes.command('archive')
  .option('--project <project>', projectOption, process.cwd())
  .requiredOption('--seal')
  .option('--base <commit>', 'reject any archive manifest entry changed since this pre-change commit')
  .action(async ({ project, base }: { project: string; base?: string }) => {
    print(await sealArchive(project, base));
  });
notes.command('pairing')
  .option('--project <project>', projectOption, process.cwd())
  .option('--list', 'report the pairing state of every note without failing')
  .option('--write', 'record the current English and Chinese bytes as the confirmed pair')
  .option('--all', 'with --write, re-record every complete pair')
  .argument('[paths...]', 'note paths naming the pairs to check or record')
  .action(async (paths: string[], { project, list, write, all }: { project: string; list?: boolean; write?: boolean; all?: boolean }) => {
    if (list && (write || all || paths.length > 0)) throw new Error('--list takes no other flags or paths');
    if (all && !write) throw new Error('--all only applies to --write');
    if (write) {
      if (paths.length > 0 && all) throw new Error('--write takes either pair paths or --all, not both');
      if (paths.length === 0 && !all) throw new Error('--write requires the pair paths you confirmed, or --all');
      print(await recordPairs(project, paths, Boolean(all)));
      return;
    }
    if (list) {
      print(await listPairs(project));
      return;
    }
    const result = await verifyPairs(project, paths);
    print(result);
    if (!result.valid) process.exitCode = 1;
  });
const context = program.command('context'); context.command('validate').option('--project <project>', projectOption, process.cwd()).option('--feature <id>').option('--all').action(async ({ project, feature, all }: { project: string; feature?: string; all?: boolean }) => { if (feature && all) throw new Error('Use either --feature or --all'); const root = resolveProjectRoot(project); const result = feature ? await verifyNavigation(root, feature) : await validateContext(root); print(result); if (!result.valid) process.exitCode = 1; });
context.command('rebuild').option('--project <project>', projectOption, process.cwd()).option('--write', 'replace the navigation pair with the rebuilt index').action(async ({ project, write }: { project: string; write?: boolean }) => { const result = await rebuildNavigation(resolveProjectRoot(project), Boolean(write)); print(result); if (!result.valid) process.exitCode = 1; });
context.command('refresh').option('--project <project>', projectOption, process.cwd()).option('--candidate <path>').option('--render-only', 'redraw navigation.md from the authoritative navigation.json without a candidate').requiredOption('--write').action(async ({ project, candidate, renderOnly }: { project: string; candidate?: string; renderOnly?: boolean }) => { if (renderOnly && candidate) throw new Error('Use either --candidate or --render-only'); const root = resolveProjectRoot(project); if (renderOnly) { print(await refreshNavigationMarkdown(root)); return; } if (!candidate) throw new Error('context refresh requires --candidate or --render-only'); print(await refreshContext(root, candidate)); });
context.command('candidate').option('--project <project>', projectOption, process.cwd()).requiredOption('--output <path>').requiredOption('--task-target <id>').requiredOption('--root <path...>').requiredOption('--path <path...>').action(async ({ project, output, taskTarget, root, path }: { project: string; output: string; taskTarget: string; root: string[]; path: string[] }) => { const projectRoot = resolveProjectRoot(project); await createNavigationCandidate(projectRoot, taskTarget, root, path, output); print({ candidate: resolveCandidatePath(projectRoot, output) }); });
context.command('locate').option('--project <project>', projectOption, process.cwd()).option('--feature <id>').option('--symbol <symbol>').option('--task <id>').option('--root <path...>').option('--maintain-index').option('--depth <count>', 'follow direct relations to this depth', Number).option('--verify').action(async (options: { project: string; feature?: string; symbol?: string; task?: string; root?: string[]; maintainIndex?: boolean; depth?: number; verify?: boolean }) => print(await locateContext(resolveProjectRoot(options.project), { ...options, ...(options.root ? { roots: options.root } : {}), ...(options.maintainIndex !== undefined ? { maintenanceAuthorized: options.maintainIndex } : {}) })));
context.command('discover').option('--project <project>', projectOption, process.cwd()).requiredOption('--packet <path>').action(async ({ project, packet }: { project: string; packet: string }) => print(await discoverFallback(resolveProjectRoot(project), await jsonFile<FallbackPacket>(packet))));
const workspace = program.command('workspace');
workspace.command('distribute').requiredOption('--plan <directory>').action(async ({ plan: directory }: { plan: string }) => {
  const result = await distributeWorkspace(directory);
  print(result);
  if (!result.valid) process.exitCode = 1;
});
workspace.command('status').requiredOption('--plan <directory>').action(async ({ plan: directory }: { plan: string }) => {
  const result = await workspaceStatus(directory);
  print(result);
  if (!result.valid) process.exitCode = 1;
});
workspace.command('audit').requiredOption('--plan <directory>').action(async ({ plan: directory }: { plan: string }) => {
  const result = await auditWorkspace(directory);
  print(result);
  if (!result.valid) process.exitCode = 1;
});
workspace.command('checkpoint').requiredOption('--plan <directory>').requiredOption('--repo <name>').action(async ({ plan: directory, repo }: { plan: string; repo: string }) => {
  const result = await checkpointWorkspace(directory, repo, await readStdin());
  print(result);
  if (!result.valid) process.exitCode = 1;
});
program.parseAsync().catch((error: unknown) => { process.stderr.write(`ai-workflow: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
