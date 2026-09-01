#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Host, Workflow } from './workflow/types.js';
import { generateWorkflow, applyAdjustments, explainWorkflow } from './workflow/generate.js';
import { validateWorkflow } from './workflow/validate.js';
import { approveWorkflow } from './workflow/approval.js';
import { activateProfile, install, uninstall, initializeProject } from './install/index.js';
import { writeJson } from './utils/fs.js';
import { formatSchemaErrors, schemaValidator } from './utils/schema.js';
import { refreshContext, validateContext, verifyNavigation } from './context/validate.js';
import { locateContext } from './context/locate.js';
import { cancelRun, cleanupRun, resumeRun, startRun } from './runtime/runner.js';
import { loadRun } from './runtime/store.js';
import { readPlan } from './workflow/parse.js';

const hosts = ['codex', 'claude', 'opencode'] as const;
function hostList(value: string): Host[] { if (value === 'all') return [...hosts]; if (!hosts.includes(value as Host)) throw new Error(`Invalid host: ${value}`); return [value as Host]; }
async function jsonFile<T>(path: string): Promise<T> { return JSON.parse(await readFile(resolve(path), 'utf8')) as T; }
function print(value: unknown): void { process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`); }

const program = new Command().name('ai-workflow').description('Self-contained native-host planning and JSON DAG coding workflow').version('0.1.0');
program.command('install').requiredOption('--host <host>').option('--home <path>').action(async ({ host, home }: { host: string; home?: string }) => print(await install(hostList(host), { ...(home ? { home } : {}) })));
program.command('uninstall').requiredOption('--host <host>').option('--home <path>').action(async ({ host, home }: { host: string; home?: string }) => print(await uninstall(hostList(host), { ...(home ? { home } : {}) })));
program.command('init').argument('<project>').action(async (project: string) => print({ created: await initializeProject(project) }));
const profile = program.command('profile');
profile.command('activate').argument('<name>').option('--home <path>').action(async (name: string, { home }: { home?: string }) => print(await activateProfile(name, { ...(home ? { home } : {}) })));

const workflow = program.command('workflow');
workflow.command('generate').requiredOption('--plan <directory>').requiredOption('--host <host>').option('--output <path>').option('--adjustments-stdin').action(async ({ plan, host, output, adjustmentsStdin }: { plan: string; host: Host; output?: string; adjustmentsStdin?: boolean }) => {
  let value = await generateWorkflow(resolve(plan), host); if (adjustmentsStdin) { const text = await new Promise<string>((done) => { let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk: string) => { data += chunk; }); process.stdin.on('end', () => done(data)); }); const adjustment = JSON.parse(text) as { operations: Array<Record<string, unknown>> }; const validator = await schemaValidator('adjustment.schema.json'); if (!validator(adjustment)) throw new Error(formatSchemaErrors(validator.errors)); value = applyAdjustments(value, adjustment.operations); const validation = await validateWorkflow(value); if (!validation.valid) throw new Error(validation.errors.join('; ')); }
  const target = resolve(output ?? join(plan, 'workflow.json')); await writeJson(target, value); print({ workflow: target, explanation: explainWorkflow(value) });
});
workflow.command('validate').argument('<workflow>').action(async (path: string) => { const result = await validateWorkflow(await jsonFile(path)); print(result); if (!result.valid) process.exitCode = 1; });
workflow.command('explain').argument('<workflow>').action(async (path: string) => print(explainWorkflow(await jsonFile<Workflow>(path))));
workflow.command('approve').argument('<workflow>').option('--project <project>', '.').action(async (path: string, { project }: { project: string }) => print(await approveWorkflow(resolve(path), resolve(project))));

const plan = program.command('plan');
plan.command('validate').requiredOption('--plan <directory>').action(async ({ plan: directory }: { plan: string }) => {
  const document = await readPlan(resolve(directory));
  print({ valid: true, plan_id: document.planId, digests: { spec: document.specDigest, plan: document.planDigest, combined: document.digest } });
});

const context = program.command('context'); context.command('validate').requiredOption('--project <project>').option('--feature <id>').option('--all').action(async ({ project, feature, all }: { project: string; feature?: string; all?: boolean }) => { if (feature && all) throw new Error('Use either --feature or --all'); const result = feature ? await verifyNavigation(resolve(project), feature) : await validateContext(resolve(project)); print(result); if (!result.valid) process.exitCode = 1; });
context.command('refresh').requiredOption('--project <project>').requiredOption('--candidate <path>').requiredOption('--write').action(async ({ project, candidate }: { project: string; candidate: string }) => print(await refreshContext(resolve(project), candidate)));
context.command('locate').requiredOption('--project <project>').option('--feature <id>').option('--symbol <symbol>').option('--task <id>').option('--depth <count>', 'follow direct relations to this depth', Number).option('--verify').action(async (options: { project: string; feature?: string; symbol?: string; task?: string; depth?: number; verify?: boolean }) => print(await locateContext(resolve(options.project), options)));
const run = program.command('run');
run.command('start').requiredOption('--workflow <path>').requiredOption('--host <host>').option('--project <project>').action(async (options: { workflow: string; host: string; project?: string }) => print(await startRun({ workflowPath: options.workflow, host: options.host, ...(options.project ? { project: options.project } : {}) })));
run.command('status').argument('<runId>').option('--project <project>', '.').action(async (runId: string, { project }: { project: string }) => print(await loadRun(resolve(project), runId)));
run.command('resume').argument('<runId>').option('--project <project>', '.').action(async (runId: string, { project }: { project: string }) => print(await resumeRun(resolve(project), runId)));
run.command('cancel').argument('<runId>').option('--project <project>', '.').action(async (runId: string, { project }: { project: string }) => print(await cancelRun(resolve(project), runId)));
run.command('cleanup').argument('<runId>').option('--project <project>', '.').action(async (runId: string, { project }: { project: string }) => { await cleanupRun(resolve(project), runId); print({ cleaned: runId }); });

program.parseAsync().catch((error: unknown) => { process.stderr.write(`ai-workflow: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
