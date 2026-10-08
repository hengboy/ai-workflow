#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Host } from './workflow/types.js';
import { activateProfile, install, uninstall, initializeProject, upgradeProject } from './install/index.js';
import { synchronizeProject } from './sync/index.js';
import { createNavigationCandidate, rebuildNavigation, refreshContext, validateContext, verifyNavigation } from './context/validate.js';
import { locateContext } from './context/locate.js';
import { discoverFallback, type FallbackPacket } from './context/fallback.js';
import { resolveCandidatePath, resolveProjectRoot } from './context/paths.js';
import { readPlan, readTasks } from './workflow/parse.js';
import { readExecutionOrder } from './workflow/order.js';
import { readWorkspaceManifest, validateWorkspaceManifest, validateWorkspaceRepositoryOrder } from './workflow/workspace.js';
import { listPlanPairs, recordPlanPairs, verifyPlanPairs } from './workflow/pairing.js';
import { distributeWorkspace } from './workspace/distribute.js';
import { workspaceStatus } from './workspace/status.js';
import { listNotes } from './notes/index.js';
import { validateNotes } from './notes/validate.js';
import { sealArchive } from './notes/archive.js';
import { listPairs, recordPairs, verifyPairs } from './notes/pair.js';

const hosts = ['codex', 'claude', 'opencode'] as const;
function hostList(value: string): Host[] { if (value === 'all') return [...hosts]; if (!hosts.includes(value as Host)) throw new Error(`Invalid host: ${value}`); return [value as Host]; }
async function jsonFile<T>(path: string): Promise<T> { return JSON.parse(await readFile(resolve(path), 'utf8')) as T; }
function print(value: unknown): void { process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`); }

const program = new Command().name('ai-workflow').description('Native-host planning and task workflow').version('0.1.0');
function opencodeVersionOption(value: string): 'v1' | 'v2' | 'auto' { if (value === 'v1' || value === 'v2' || value === 'auto') return value; throw new Error(`Invalid opencode version: ${value}`); }
program.command('install').requiredOption('--host <host>').option('--home <path>').option('--opencode-version <version>', 'opencode agent format: v1, v2 or auto (default auto)', 'auto').action(async ({ host, home, opencodeVersion }: { host: string; home?: string; opencodeVersion: string }) => print(await install(hostList(host), { ...(home ? { home } : {}), opencodeVersion: opencodeVersionOption(opencodeVersion) })));
program.command('uninstall').requiredOption('--host <host>').option('--home <path>').action(async ({ host, home }: { host: string; home?: string }) => print(await uninstall(hostList(host), { ...(home ? { home } : {}) })));
program.command('init').argument('[project]').option('--upgrade', 'patch owned workflow sections from shipped templates in an existing project').action(async (project: string | undefined, { upgrade }: { upgrade?: boolean }) => {
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
const profile = program.command('profile');
profile.command('activate').argument('<name>').option('--home <path>').option('--opencode-version <version>', 'opencode agent format: v1, v2 or auto (default auto)', 'auto').action(async (name: string, { home, opencodeVersion }: { home?: string; opencodeVersion: string }) => print(await activateProfile(name, { ...(home ? { home } : {}), opencodeVersion: opencodeVersionOption(opencodeVersion) })));

const plan = program.command('plan');
plan.command('validate').requiredOption('--plan <directory>').action(async ({ plan: directory }: { plan: string }) => {
  const document = await readPlan(directory);
  const tasks = await readTasks(directory);
  const digests = { spec: document.specDigest, plan: document.planDigest, combined: document.digest };
  const manifest = await readWorkspaceManifest(directory);
  if (!tasks.length) { print({ valid: true, plan_id: document.planId, digests }); return; }
  const schedule = await readExecutionOrder(directory, document.planId, tasks);
  if (manifest) {
    const errors = validateWorkspaceManifest(manifest, document, tasks, schedule);
    if (errors.length) throw new Error(errors.join('\n'));
  } else if (document.workspaceRepos) {
    const errors = validateWorkspaceRepositoryOrder(document.workspaceRepos.map((repository) => ({ name: repository.name, dependsOn: repository.depends_on })), tasks, schedule);
    if (errors.length) throw new Error(errors.join('\n'));
  }
  const output: { valid: boolean; plan_id: string; digests: typeof digests; execution_order: string[][]; repos?: { name: string; path: string; depends_on: string[] }[] } = {
    valid: true,
    plan_id: document.planId,
    digests,
    execution_order: schedule.phases.map((phase) => phase.parallel),
  };
  if (manifest?.role === 'workspace') output.repos = manifest.repositories.map((repository) => ({ name: repository.name, path: repository.path, depends_on: repository.dependsOn }));
  print(output);
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

const projectOption = 'project root directory path; use . or an absolute path';
const notes = program.command('notes');
notes.command('validate').option('--project <project>', projectOption, process.cwd()).action(async ({ project }: { project: string }) => {
  const result = await validateNotes(project);
  print(result);
  if (!result.valid) process.exitCode = 1;
});
notes.command('list').option('--project <project>', projectOption, process.cwd()).option('--archived').action(async ({ project, archived }: { project: string; archived?: boolean }) => {
  print({ entries: await listNotes(project, { archived: Boolean(archived) }) });
});
notes.command('archive').option('--project <project>', projectOption, process.cwd()).requiredOption('--seal').action(async ({ project }: { project: string }) => {
  print(await sealArchive(project));
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
context.command('refresh').option('--project <project>', projectOption, process.cwd()).requiredOption('--candidate <path>').requiredOption('--write').action(async ({ project, candidate }: { project: string; candidate: string }) => print(await refreshContext(resolveProjectRoot(project), candidate)));
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
program.parseAsync().catch((error: unknown) => { process.stderr.write(`ai-workflow: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
