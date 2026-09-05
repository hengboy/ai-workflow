#!/usr/bin/env node
import { Command } from 'commander';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join, relative, sep } from 'node:path';
import type { Host } from './workflow/types.js';
import { generateManifest } from './workflow/generate.js';
import { collectRawArtifacts } from './workflow/artifacts.js';
import { validateWorkflow } from './workflow/validate.js';
import { activateProfile, install, uninstall, initializeProject, updateProject } from './install/index.js';
import { exists, readJson, writeJson } from './utils/fs.js';
import { formatSchemaErrors, schemaValidator } from './utils/schema.js';
import { objectDigest, sha256, stableJson } from './utils/hash.js';
import { createNavigationCandidate, refreshContext, validateContext, verifyNavigation } from './context/validate.js';
import { locateContext } from './context/locate.js';
import { discoverFallback, type FallbackPacket } from './context/fallback.js';
import { resolveCandidatePath, resolveProjectRoot } from './context/paths.js';
import { cancelV2Run, cleanupV2Run, projectV2Run, resumeV2Run, runV2Script } from './runtime/runner.js';
import { RunVersionError } from './runtime/store.js';
import { readPlan } from './workflow/parse.js';
import { gitBaseline } from './git/operator.js';
import type { CodingCapabilityManifest } from './generated/coding-manifest.schema.js';
import type { ApprovalReceiptV2 } from './generated/receipt.schema.js';
import { BrokeredSandboxProvider, runBrokerProbe } from './security/sandbox.js';

const hosts = ['codex', 'claude', 'opencode'] as const;
function hostList(value: string): Host[] { if (value === 'all') return [...hosts]; if (!hosts.includes(value as Host)) throw new Error(`Invalid host: ${value}`); return [value as Host]; }
async function jsonFile<T>(path: string): Promise<T> { return JSON.parse(await readFile(resolve(path), 'utf8')) as T; }
function print(value: unknown): void { process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`); }

function isV2Manifest(value: unknown): value is CodingCapabilityManifest {
  return !!value && typeof value === 'object' && (value as { schema_version?: unknown }).schema_version === '2.0.0' && (value as { engine?: unknown }).engine === 'worker-thread-trusted';
}

function requireV2Manifest(value: unknown): CodingCapabilityManifest {
  if (!isV2Manifest(value)) throw new Error('WORKFLOW_VERSION_UNSUPPORTED: only v2 manifests are supported');
  return value;
}

async function v2RunCommand<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof RunVersionError) throw new Error(`RUN_VERSION_UNSUPPORTED: ${error.message}`);
    throw error;
  }
}

function explainManifest(manifest: CodingCapabilityManifest): string {
  return [
    `Plan: ${manifest.plan_id}`,
    `Host: ${manifest.host}`,
    `Engine: ${manifest.engine}`,
    `Script: ${manifest.script.path} (${manifest.script.bytes_digest})`,
    `Args: ${manifest.args.path} (${manifest.args.bytes_digest})`,
    `Actions: ${manifest.actions.length}`,
    ...manifest.actions.map((action) => `- ${action.action_id} [${action.operation}]`),
    `Gates: ${manifest.mandatory_gates.length}`,
    ...manifest.mandatory_gates.map((gate) => `- ${gate.gate_id} [${gate.predicate}]`),
    'Trusted boundary: worker-thread-trusted script with brokered host execution and host-owned gates.',
  ].join('\n');
}

async function baselineDigest(project: string, receipt: string): Promise<string> {
  const baseline = await gitBaseline(project);
  const ignored = relative(project, receipt).replaceAll('\\', '/');
  const status = baseline.status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter((entry) => entry !== ignored && !entry.startsWith('ai-workflow/') && !entry.startsWith('.ai-workflow/')).sort();
  return objectDigest({ branch: baseline.branch, head: baseline.head, status });
}

async function currentManifestArtifacts(workflowPath: string, manifest: CodingCapabilityManifest, project: string): Promise<{ inputArtifactsDigest: string; scriptDigest: string; argsDigest: string }> {
  const planDirectory = resolve(workflowPath, '..');
  const artifacts = await collectRawArtifacts({ projectDirectory: project, planDirectory });
  return {
    inputArtifactsDigest: artifacts.inputArtifactsDigest,
    scriptDigest: sha256(await readFile(join(planDirectory, manifest.script.path))),
    argsDigest: sha256(await readFile(join(planDirectory, manifest.args.path))),
  };
}

async function approveV2Manifest(workflowPath: string, manifest: CodingCapabilityManifest, project: string): Promise<ApprovalReceiptV2> {
  const validation = await validateWorkflow(manifest, project);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  const planDirectory = resolve(workflowPath, '..');
  const artifacts = await currentManifestArtifacts(workflowPath, manifest, project);
  if (artifacts.inputArtifactsDigest !== manifest.input_artifacts_digest || artifacts.scriptDigest !== manifest.script.bytes_digest || artifacts.argsDigest !== manifest.args.bytes_digest) throw new Error('Manifest artifact digest drift');
  const current = await gitBaseline(project);
  if (!current.head) throw new Error('Cannot approve a project without a baseline commit');
  if (current.branch !== manifest.project.target_branch) throw new Error(`Target branch mismatch: expected ${manifest.project.target_branch}, got ${current.branch}`);
  const receipt: ApprovalReceiptV2 = {
    receipt_version: '2.0.0', plan_id: manifest.plan_id, host: manifest.host, engine: manifest.engine,
    manifest_digest: objectDigest(manifest), script_digest: manifest.script.bytes_digest, args_digest: manifest.args.bytes_digest,
    input_artifacts_digest: manifest.input_artifacts_digest,
    profile_route_digest: objectDigest({ host: manifest.host, adapter: manifest.host_execution.adapter, engine: manifest.engine }),
    sandbox_policy_digest: objectDigest(manifest.host_execution), baseline_digest: await baselineDigest(project, join(planDirectory, 'approval.receipt.json')),
    target_branch: current.branch, target_head: current.head,
    approval_identity: { kind: 'local-user', subject_digest: sha256(String(process.getuid?.() ?? 'unknown')) }, approved_at: new Date().toISOString(),
  };
  const validate = await schemaValidator('receipt.schema.json');
  if (!validate(receipt)) throw new Error(formatSchemaErrors(validate.errors));
  await writeJson(join(planDirectory, 'approval.receipt.json'), receipt);
  return receipt;
}

async function verifyV2Approval(workflowPath: string, manifest: CodingCapabilityManifest, project: string): Promise<void> {
  const receiptPath = join(resolve(workflowPath, '..'), 'approval.receipt.json');
  if (!(await exists(receiptPath))) throw new Error('Missing v2 approval receipt');
  const receipt = await readJson<ApprovalReceiptV2>(receiptPath);
  if (receipt.receipt_version !== '2.0.0' || receipt.engine !== 'worker-thread-trusted' || receipt.manifest_digest !== objectDigest(manifest) || receipt.plan_id !== manifest.plan_id || receipt.host !== manifest.host) throw new Error('V2 approval receipt does not match manifest');
  const current = await currentManifestArtifacts(workflowPath, manifest, project);
  if (current.inputArtifactsDigest !== receipt.input_artifacts_digest || current.scriptDigest !== receipt.script_digest || current.argsDigest !== receipt.args_digest || current.inputArtifactsDigest !== manifest.input_artifacts_digest || current.scriptDigest !== manifest.script.bytes_digest || current.argsDigest !== manifest.args.bytes_digest) throw new Error('V2 approval artifact digest drift');
  const baseline = await gitBaseline(project);
  if (!baseline.head || baseline.branch !== receipt.target_branch || baseline.head !== receipt.target_head || await baselineDigest(project, receiptPath) !== receipt.baseline_digest) throw new Error('V2 approval baseline changed');
  if (manifest.host_execution.mode !== 'brokered-sandbox' || manifest.host_execution.adapter !== manifest.host || manifest.host_execution.model_transport.owner !== 'host-native-broker' || manifest.host_execution.model_transport.project_write_allowed || manifest.host_execution.model_transport.credential_visibility !== 'broker-only' || !manifest.host_execution.action_executor.process_group || manifest.host_execution.action_executor.network_allowed || !manifest.host_execution.action_executor.project_write_enforced || manifest.host_execution.action_executor.git_metadata_write_allowed) throw new Error('ACTION_SANDBOX_UNAVAILABLE: manifest sandbox boundary is invalid');
  const provider = new BrokeredSandboxProvider();
  if (!(await runBrokerProbe(provider))) throw new Error('ACTION_SANDBOX_UNAVAILABLE: brokered action executor is unavailable');
}

async function planLocalFile(planDirectory: string, value: string, label: string): Promise<string> {
  const planRoot = await realpath(planDirectory);
  const candidate = resolve(planDirectory, value);
  const stats = await lstat(candidate).catch((error: unknown) => { throw new Error(`${label} must be a plan-local regular file: ${error instanceof Error ? error.message : String(error)}`); });
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} must be a plan-local regular file: ${value}`);
  const actual = await realpath(candidate);
  const inside = actual === planRoot || !relative(planRoot, actual).split(sep).includes('..');
  if (!inside) throw new Error(`${label} must remain inside the canonical plan directory`);
  return actual;
}

async function copyPlanLocalFile(planDirectory: string, source: string, destination: string, label: string): Promise<void> {
  const sourcePath = await planLocalFile(planDirectory, source, label);
  const destinationPath = resolve(planDirectory, destination);
  if (sourcePath === destinationPath) return;
  try {
    const destinationStats = await lstat(destinationPath);
    if (destinationStats.isSymbolicLink() || !destinationStats.isFile()) throw new Error(`${destination} must be a regular file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(destinationPath, await readFile(sourcePath));
}

const program = new Command().name('ai-workflow').description('Self-contained native-host planning and JSON DAG coding workflow').version('0.1.0');
program.command('install').requiredOption('--host <host>').option('--home <path>').action(async ({ host, home }: { host: string; home?: string }) => print(await install(hostList(host), { ...(home ? { home } : {}) })));
program.command('uninstall').requiredOption('--host <host>').option('--home <path>').action(async ({ host, home }: { host: string; home?: string }) => print(await uninstall(hostList(host), { ...(home ? { home } : {}) })));
program.command('init').argument('<project>').action(async (project: string) => print({ created: await initializeProject(project) }));
program.command('update').argument('<project>').action(async (project: string) => print(await updateProject(project)));
const profile = program.command('profile');
profile.command('activate').argument('<name>').option('--home <path>').action(async (name: string, { home }: { home?: string }) => print(await activateProfile(name, { ...(home ? { home } : {}) })));

const workflow = program.command('workflow');
workflow.command('generate').description('Generate canonical .ai-workflow/plans/<plan-id>/workflow.json').requiredOption('--plan <directory>').requiredOption('--host <host>').option('--script <plan-local-file>').option('--args <plan-local-json>').action(async ({ plan, host, script, args }: { plan: string; host: Host; script?: string; args?: string }) => {
  const directory = resolve(plan); const project = resolveProjectRoot(resolve(directory, '../../..')); const document = await readPlan(directory); const canonicalDirectory = join(project, '.ai-workflow', 'plans', document.planId); if (directory !== canonicalDirectory) throw new Error(`Workflow plan directory must be canonical: ${canonicalDirectory}`);
  if (script) await copyPlanLocalFile(directory, script, 'workflow.js', '--script');
  if (args) await copyPlanLocalFile(directory, args, 'workflow.args.json', '--args');
  const manifest = await generateManifest(directory, host); const target = join(directory, 'workflow.json'); await writeFile(target, `${stableJson(manifest)}\n`, 'utf8'); print({ workflow: target, manifest: { schema_version: manifest.schema_version, engine: manifest.engine } });
});
workflow.command('validate').argument('<workflow>').option('--project <project>', '.').action(async (path: string, { project }: { project: string }) => { const result = await validateWorkflow(requireV2Manifest(await jsonFile<unknown>(path)), resolveProjectRoot(project)); print(result); if (!result.valid) process.exitCode = 1; });
workflow.command('explain').argument('<workflow>').action(async (path: string) => {
  print(explainManifest(requireV2Manifest(await jsonFile<unknown>(path))));
});
workflow.command('approve').argument('<workflow>').option('--project <project>', '.').action(async (path: string, { project }: { project: string }) => {
  print(await approveV2Manifest(resolve(path), requireV2Manifest(await jsonFile<unknown>(path)), resolve(project)));
});

const plan = program.command('plan');
plan.command('validate').requiredOption('--plan <directory>').action(async ({ plan: directory }: { plan: string }) => {
  const document = await readPlan(resolve(directory));
  print({ valid: true, plan_id: document.planId, digests: { spec: document.specDigest, plan: document.planDigest, combined: document.digest } });
});

const projectOption = 'project root directory path; use . or an absolute path';
const context = program.command('context'); context.command('validate').requiredOption('--project <project>', projectOption).option('--feature <id>').option('--all').action(async ({ project, feature, all }: { project: string; feature?: string; all?: boolean }) => { if (feature && all) throw new Error('Use either --feature or --all'); const root = resolveProjectRoot(project); const result = feature ? await verifyNavigation(root, feature) : await validateContext(root); print(result); if (!result.valid) process.exitCode = 1; });
context.command('refresh').requiredOption('--project <project>', projectOption).requiredOption('--candidate <path>').requiredOption('--write').action(async ({ project, candidate }: { project: string; candidate: string }) => print(await refreshContext(resolveProjectRoot(project), candidate)));
context.command('candidate').requiredOption('--project <project>', projectOption).requiredOption('--output <path>').requiredOption('--task-target <id>').requiredOption('--root <path...>').requiredOption('--path <path...>').action(async ({ project, output, taskTarget, root, path }: { project: string; output: string; taskTarget: string; root: string[]; path: string[] }) => { const projectRoot = resolveProjectRoot(project); await createNavigationCandidate(projectRoot, taskTarget, root, path, output); print({ candidate: resolveCandidatePath(projectRoot, output) }); });
context.command('locate').requiredOption('--project <project>', projectOption).option('--feature <id>').option('--symbol <symbol>').option('--task <id>').option('--root <path...>').option('--maintain-index').option('--depth <count>', 'follow direct relations to this depth', Number).option('--verify').action(async (options: { project: string; feature?: string; symbol?: string; task?: string; root?: string[]; maintainIndex?: boolean; depth?: number; verify?: boolean }) => print(await locateContext(resolveProjectRoot(options.project), { ...options, ...(options.root ? { roots: options.root } : {}), ...(options.maintainIndex !== undefined ? { maintenanceAuthorized: options.maintainIndex } : {}) })));
context.command('discover').requiredOption('--project <project>', projectOption).requiredOption('--packet <path>').action(async ({ project, packet }: { project: string; packet: string }) => print(await discoverFallback(resolveProjectRoot(project), await jsonFile<FallbackPacket>(packet))));
const run = program.command('run');
run.command('start').requiredOption('--workflow <path>').requiredOption('--host <host>').requiredOption('--project <project>').action(async (options: { workflow: string; host: string; project: string }) => {
  const manifest = requireV2Manifest(await jsonFile<unknown>(options.workflow));
  if (manifest.host !== options.host) throw new Error(`Host mismatch: manifest=${manifest.host}, requested=${options.host}`);
  const project = resolveProjectRoot(options.project); const validation = await validateWorkflow(manifest, project); if (!validation.valid) throw new Error(validation.errors.join('; '));
  await verifyV2Approval(resolve(options.workflow), manifest, project);
   const planDirectory = resolve(options.workflow, '..');
   const script = await readFile(join(planDirectory, manifest.script.path), 'utf8');
   const args = JSON.parse(await readFile(join(planDirectory, manifest.args.path), 'utf8')) as unknown;
   const runId = `run-${manifest.plan_id}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
   print(await runV2Script({ project, runId, manifest, script, args, scriptDigest: manifest.script.bytes_digest, argsDigest: manifest.args.bytes_digest }));
});
run.command('status').argument('<runId>').requiredOption('--project <project>').action(async (runId: string, { project }: { project: string }) => print(await v2RunCommand(() => projectV2Run(resolveProjectRoot(project), runId))));
run.command('resume').argument('<runId>').requiredOption('--project <project>').action(async (runId: string, { project }: { project: string }) => print(await v2RunCommand(() => resumeV2Run(resolveProjectRoot(project), runId))));
run.command('cancel').argument('<runId>').requiredOption('--project <project>').action(async (runId: string, { project }: { project: string }) => print(await v2RunCommand(() => cancelV2Run(resolveProjectRoot(project), runId))));
run.command('cleanup').argument('<runId>').requiredOption('--project <project>').action(async (runId: string, { project }: { project: string }) => { await v2RunCommand(() => cleanupV2Run(resolveProjectRoot(project), runId)); print({ cleaned: runId }); });

program.parseAsync().catch((error: unknown) => { process.stderr.write(`ai-workflow: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
