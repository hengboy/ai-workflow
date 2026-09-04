import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import type { Workflow } from '../workflow/types.js';
import { objectDigest } from '../utils/hash.js';
import { verifyApproval } from '../workflow/approval.js';
import { validateWorkflow } from '../workflow/validate.js';
import { assertResumeFingerprint, loadRun, loadV2Run, saveRun, saveV2Run, type RunRecord, type RunRecordV2, type ResumeFingerprint } from './store.js';
import { EventLog } from './events.js';
import { RunLedger } from './ledger.js';
import { assertTransition, type RunState } from './state.js';
import { commitTask, createPlanWorktree, createTaskWorktree, deleteOwnedBranches, gitBaseline, integratePlan, mergeTask, removeOwnedWorktrees, type Worktree } from '../git/operator.js';
import { readPlan, readTasks } from '../workflow/parse.js';
import { invokeHost } from '../adapters/process.js';
import { formatSchemaErrors, packagePath, schemaValidator } from '../utils/schema.js';
import { snapshot, snapshotChanges, validateChangedPaths, validateRoleCommand } from '../security/policy.js';
import type { AgentPacket, ContextLocator } from '../generated/packet.schema.js';
import type { AgentResult } from '../generated/result.schema.js';
import { resolveProjectRoot } from '../context/paths.js';
import { locateContext } from '../context/locate.js';
import { exists } from '../utils/fs.js';
import { TaskClosureCoordinator, type TaskActionObservation } from '../workflow/approval.js';
import { GateCoordinator, type GateReceipt } from './gates.js';
import { V2GitOperator, type V2Worktree } from '../git/operator.js';
import { CodingWorkflowEngine, type ChildRun } from './engine.js';
import { ScopeScheduler } from './scheduler.js';
import { admitAction } from '../security/capability.js';
import type { CodingCapabilityManifest } from '../generated/coding-manifest.schema.js';
import type { ActionCapability, ActionCapabilityManifest } from '../security/capability.js';
import type { CallDescriptor, CodingAgentResult, TaskControlDescriptor } from './protocol.js';
import { BrokeredSandboxProvider } from '../security/sandbox.js';
import { CancelControl, OwnerLease, cancelProof, cancelReasonDigest } from './control.js';
import { captureWorktreeAudit, compareWorktreeAudits } from '../security/audit.js';
import { RepairCoordinator, type ReviewFindingInput } from './repair.js';

const activeControllers = new Map<string, AbortController>();
class ReviewFindingsError extends Error {}
export interface ExecutionContext { cwd: string; node: Workflow['nodes'][number] }
export interface StartOptions { workflowPath: string; host: string; project?: string; executor?: (nodeId: string, context: ExecutionContext) => Promise<unknown>; defer?: boolean }

export async function startRun(options: StartOptions): Promise<RunRecord> {
  const workflowPath = resolve(options.workflowPath); const workflow = JSON.parse(await readFile(workflowPath, 'utf8')) as Workflow; const project = resolveProjectRoot(options.project ?? process.cwd());
  if (workflow.host !== options.host) throw new Error(`Host mismatch: workflow=${workflow.host}, requested=${options.host}`); const validation = await validateWorkflow(workflow, project); if (!validation.valid) throw new Error(validation.errors.join('; ')); await verifyApproval(workflowPath, workflow, project);
  const currentPlan = await readPlan(dirname(workflowPath)); const currentTasks = await readTasks(dirname(workflowPath)); if (currentPlan.digest !== workflow.input_digests.plan || objectDigest(currentTasks) !== workflow.input_digests.tasks) throw new Error('Frozen plan or task inputs changed after workflow generation');
  const baseline = await gitBaseline(project); if (!baseline.head) throw new Error('Unborn HEAD requires an explicitly approved baseline commit'); const stableBaseline = objectDigest({ branch: baseline.branch, head: baseline.head });
  const now = new Date().toISOString(); const runId = `${workflow.plan_id}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`; const record: RunRecord = { run_id: runId, project, workflow_path: workflowPath, workflow_digest: objectDigest(workflow), plan_id: workflow.plan_id, host: workflow.host, state: 'preflight', started_at: now, updated_at: now, cancelled: false, resources: { start_branch: baseline.branch, start_head: baseline.head, task_worktrees: {}, task_branches: {}, commits: {} }, nodes: Object.fromEntries(workflow.nodes.map((node) => [node.id, { status: 'pending', attempts: 0, idempotency_key: objectDigest({ runId, node: node.id, workflow: objectDigest(workflow) }) }])), events: [{ at: now, state: 'preflight', message: 'Run created' }] };
  await saveRun(record); await advance(record, 'baseline', 'Approval, inputs and baseline validated'); const plan = await createPlanWorktree(project, runId, baseline.branch, baseline.head); record.baseline = stableBaseline; record.resources.plan_worktree = plan.path; record.resources.plan_branch = plan.branch; await advance(record, 'plan_setup', 'Plan worktree created'); await advance(record, 'executing', 'Execution started');
  if (!options.defer) { const controller = new AbortController(); activeControllers.set(runId, controller); try { await executeNodes(record, workflow, options.executor ?? createHostExecutor(record, workflow, controller.signal)); } finally { activeControllers.delete(runId); } }
  return record;
}

function createHostExecutor(record: RunRecord, workflow: Workflow, signal?: AbortSignal): (nodeId: string, context: ExecutionContext) => Promise<AgentResult> {
  return async (nodeId, context) => { const current = workflow.nodes.find((item) => item.id === nodeId); if (!current) throw new Error(`Unknown node: ${nodeId}`); for (const command of current.allowed_commands ?? []) { const violation = validateRoleCommand(current.role, command); if (violation) throw new Error(`${violation}: ${command}`); }
    const screenshotDir = `.ai-workflow/plans/${workflow.plan_id}/screenshot/`; const task = current.role === 'file-explorer' && current.task_id ? (await readTasks(dirname(record.workflow_path))).find((item) => item.id === current.task_id) : undefined; const locator = current.role === 'file-explorer' ? await locateFileExplorerContext(record.project, task?.feature) : undefined; if (locator && locator.status !== 'hit') return blockedFileExplorerResult(locator); const readPaths = current.read_scope; const packet: AgentPacket = { packet_version: '1.0.0', run_id: record.run_id, plan_id: workflow.plan_id, ...(current.task_id ? { task_id: current.task_id } : {}), ...(task?.feature ? { feature: task.feature } : {}), role: current.role, objective: `Execute workflow node ${current.id} (${current.kind}) and return only the required result envelope.`, cwd: context.cwd, read_paths: readPaths, write_paths: current.write_scope, evidence: current.depends_on, screenshot_dir: screenshotDir, allowed_commands: current.allowed_commands ?? [], timeout_ms: current.timeout_ms, result_schema: 'schemas/result.schema.json', ...(locator ? { context_locator: locator as ContextLocator } : {}) };
    const prompt = await readFile(packagePath('templates', 'agents', `${current.role}.md`), 'utf8'); const snapshotPaths = current.role === 'file-explorer' ? current.read_scope : current.write_scope; const before = await snapshot(context.cwd, snapshotPaths); const result = await invokeHost(workflow.host, prompt, packet, signal ? { signal } : {}); const after = await snapshot(context.cwd, snapshotPaths); const observed = snapshotChanges(before, after); const resultViolations = current.role === 'file-explorer' ? validateFileExplorerPaths(result.changed_paths, locator?.status === 'hit' ? locator.read_order : []) : validateChangedPaths(current, result.changed_paths, screenshotDir); const violations = [...validateChangedPaths(current, observed, screenshotDir), ...resultViolations]; if (violations.length) throw new Error(`Permission violation: ${violations.join('; ')}`); assertAgentResult(current, result); return result;
  };
}

type LocateResult = Awaited<ReturnType<typeof locateContext>>;
async function locateFileExplorerContext(project: string, feature?: string): Promise<LocateResult> {
  if (!feature) return { status: 'blocked', resolution_mode: 'index', reason: 'File Explorer requires a task feature locator', fallback_required: false };
  return locateContext(project, { feature, verify: true });
}

function validateFileExplorerPaths(paths: string[], readPaths: string[]): string[] {
  const authorized = new Set(readPaths);
  return paths.filter((path) => !authorized.has(path)).map((path) => `File Explorer reported unauthorized read path: ${path}`);
}

async function blockedFileExplorerResult(locator: LocateResult): Promise<AgentResult> {
  const reason = 'reason' in locator ? locator.reason : `Locator status: ${locator.status}`;
  const result: AgentResult = { status: 'blocked', summary: `File Explorer context locator blocked: ${reason}`, changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [reason] };
  const validate = await schemaValidator('result.schema.json');
  if (!validate(result)) throw new Error(`Invalid File Explorer blocked result: ${formatSchemaErrors(validate.errors)}`);
  return result;
}

function assertAgentResult(node: Workflow['nodes'][number], value: unknown): asserts value is AgentResult { if (value === null || typeof value !== 'object' || !('status' in value) || ((value as { status?: unknown }).status !== 'done' && !(node.role === 'file-explorer' && (value as { status?: unknown }).status === 'blocked'))) throw new Error('Agent result did not report done'); const result = value as AgentResult; if (node.role === 'test' && result.tests.some((test) => test.status === 'failed')) throw new Error(`Required test failed: ${result.summary}`); if ((node.role === 'standards-review' || node.role === 'spec-review') && result.findings.some((finding) => finding.severity === 'error')) throw new ReviewFindingsError(`Review finding blocks integration: ${result.summary}`); }
function hasReviewFindings(state: RunRecord['nodes'][string]): boolean { return (state.result as { reason?: unknown } | undefined)?.reason === 'review_findings'; }
async function executeGitNode(record: RunRecord, workflow: Workflow, node: Workflow['nodes'][number]): Promise<unknown> { const { plan_worktree: planPath, plan_branch: planBranch, start_head: startHead } = record.resources; if (!planPath || !planBranch || !startHead) throw new Error('Incomplete plan worktree resources'); const plan: Worktree = { path: planPath, branch: planBranch, base: startHead }; const taskId = node.task_id; if (node.id.endsWith('-setup') && taskId) { const task = await createTaskWorktree(record.project, plan, record.run_id, taskId); record.resources.task_worktrees[taskId] = task.path; record.resources.task_branches[taskId] = task.branch; return task; } if (node.id.endsWith('-commit') && taskId) { const path = record.resources.task_worktrees[taskId]; if (!path) throw new Error(`Missing task worktree: ${taskId}`); const implementation = workflow.nodes.find((item) => item.task_id === taskId && item.id.endsWith('-implement')); const commit = await commitTask(path, taskId, implementation?.write_scope ?? []); record.resources.commits[taskId] = commit; await mergeTask(plan.path, commit); await removeOwnedWorktrees(record.project, [path]); return { commit }; } if (node.id === 'plan-integrate') { const commit = await integratePlan(record.project, plan.branch, record.resources.start_branch, record.resources.start_head); record.resources.merge_commit = commit; await removeOwnedWorktrees(record.project, [plan.path]); await deleteOwnedBranches(record.project, [...Object.values(record.resources.task_branches), plan.branch]); return { commit }; } throw new Error(`Unknown Git lifecycle node: ${node.id}`); }

async function executeNodes(record: RunRecord, workflow: Workflow, executor: (nodeId: string, context: ExecutionContext) => Promise<unknown>): Promise<void> { const pending = new Set(workflow.nodes.filter((node) => record.nodes[node.id]?.status !== 'done').map((node) => node.id)); while (pending.size && !record.cancelled) { const ready = workflow.nodes.filter((node) => pending.has(node.id) && node.depends_on.every((dep) => record.nodes[dep]?.status === 'done')).slice(0, workflow.concurrency); if (!ready.length) { record.resume_state = record.state; await advance(record, 'paused', 'No schedulable nodes'); return; } await Promise.all(ready.map(async (node) => { const state = record.nodes[node.id]; if (!state || state.status === 'done') return; state.status = 'running'; state.attempts += 1; await saveRun(record); try { const cwd = node.task_id ? record.resources.task_worktrees[node.task_id] ?? record.resources.plan_worktree ?? record.project : record.resources.plan_worktree ?? record.project; const result = node.kind === 'git' ? await executeGitNode(record, workflow, node) : await executor(node.id, { cwd, node }); if (node.kind !== 'git') assertAgentResult(node, result); state.result = result; if (node.role === 'file-explorer' && (result as AgentResult).status === 'blocked') state.status = 'blocked'; else { state.status = 'done'; pending.delete(node.id); await checkpoint(record, node.id); } } catch (error) { state.result = { error: error instanceof Error ? error.message : String(error), reason: error instanceof ReviewFindingsError ? 'review_findings' : 'execution_failure' }; if (node.on_failure === 'repair_once' && state.attempts === 1) { record.resume_state = 'repairing'; state.status = 'blocked'; } else if (state.attempts <= node.retry) state.status = 'pending'; else { state.status = 'failed'; pending.delete(node.id); } } await saveRun(record); })); if (Object.values(record.nodes).some((node) => node.status === 'failed' || node.status === 'blocked')) { if (Object.values(record.nodes).some((node) => node.status === 'blocked')) record.resume_state = 'repairing'; else record.resume_state = 'executing'; await advance(record, 'paused', 'Node failed or requires repair'); return; } }
  if (record.cancelled) return; await advance(record, 'validating', 'Task nodes complete'); await advance(record, 'reviewing', 'Validation gates complete'); await advance(record, 'integrating', 'Review gates complete'); await advance(record, 'complete', 'Integration complete'); await writeSummary(record);
}
async function checkpoint(record: RunRecord, nodeId: string): Promise<void> { const { atomicWrite } = await import('../utils/fs.js'); await atomicWrite(join(record.project, '.ai-workflow/runs', record.run_id, 'checkpoints', `${nodeId}.json`), `${JSON.stringify({ node_id: nodeId, idempotency_key: record.nodes[nodeId]?.idempotency_key, at: new Date().toISOString() })}\n`); }
async function advance(record: RunRecord, next: RunState, message: string): Promise<void> { assertTransition(record.state, next); record.state = next; record.events.push({ at: new Date().toISOString(), state: next, message }); await saveRun(record); }
async function writeSummary(record: RunRecord): Promise<void> { const directory = join(record.project, '.ai-workflow/runs', record.run_id); const summary = `# Run summary\n\n- Plan: ${record.plan_id}\n- Host: ${record.host}\n- State: ${record.state}\n- Workflow digest: ${record.workflow_digest}\n- Commits: ${JSON.stringify(record.resources.commits)}\n- Merge: ${record.resources.merge_commit ?? 'pending'}\n`; const { atomicWrite, writeJson } = await import('../utils/fs.js'); await atomicWrite(join(directory, 'summary.md'), summary); await writeJson(join(directory, 'receipt.json'), { run_id: record.run_id, plan_id: record.plan_id, state: record.state, resources: record.resources, nodes: record.nodes, completed_at: new Date().toISOString() }); }
export async function cancelRun(project: string, runId: string): Promise<RunRecord> { const record = await loadRun(project, runId); if (record.state === 'complete' || record.state === 'cancelled') return record; record.cancelled = true; activeControllers.get(runId)?.abort(); record.resume_state = record.state; await advance(record, 'cancelled', 'Cancelled by user; work preserved'); return record; }
export async function resumeRun(project: string, runId: string, executor?: (nodeId: string, context: ExecutionContext) => Promise<unknown>): Promise<RunRecord> { const record = await loadRun(project, runId); if (record.state !== 'paused') throw new Error('Only paused runs may resume'); const workflow = JSON.parse(await readFile(record.workflow_path, 'utf8')) as Workflow; if (objectDigest(workflow) !== record.workflow_digest) throw new Error('Workflow changed since checkpoint'); const currentPlan = await readPlan(dirname(record.workflow_path)); const currentTasks = await readTasks(dirname(record.workflow_path)); if (currentPlan.digest !== workflow.input_digests.plan || objectDigest(currentTasks) !== workflow.input_digests.tasks) throw new Error('Frozen inputs changed since checkpoint'); const baseline = await gitBaseline(project); if (objectDigest({ branch: baseline.branch, head: baseline.head }) !== record.baseline) throw new Error('Git baseline changed since checkpoint'); const next = record.resume_state === 'repairing' ? 'repairing' : record.resume_state ?? 'executing';
  // Spec Review is a single-shot gate. Once it has executed, a repair/resume
  // must continue to the next lifecycle step without invoking it again.
  for (const [nodeId, state] of Object.entries(record.nodes)) {
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if ((state.status === 'blocked' || state.status === 'failed') && node?.role === 'spec-review' && state.attempts > 0 && hasReviewFindings(state)) state.status = 'done';
    else if (state.status === 'blocked' || state.status === 'failed') state.status = 'pending';
  }
  await advance(record, next, 'Checkpoint, inputs and baseline validated; resumed'); if (next === 'repairing') await advance(record, 'executing', 'Repair round started'); const controller = new AbortController(); activeControllers.set(runId, controller); try { await executeNodes(record, workflow, executor ?? createHostExecutor(record, workflow, controller.signal)); } finally { activeControllers.delete(runId); } return record; }
export async function cleanupRun(project: string, runId: string): Promise<void> { const record = await loadRun(project, runId); if (!['complete', 'cancelled'].includes(record.state)) throw new Error('Cleanup accepts only complete or cancelled runs'); const paths = [...Object.values(record.resources.task_worktrees), ...(record.resources.plan_worktree ? [record.resources.plan_worktree] : [])]; await removeOwnedWorktrees(project, paths); await deleteOwnedBranches(project, [...Object.values(record.resources.task_branches), ...(record.resources.plan_branch ? [record.resources.plan_branch] : [])]); const directory = join(project, '.ai-workflow/runs', runId); const archive = join(project, '.ai-workflow/runs', `${basename(directory)}.final.json`); const { writeJson } = await import('../utils/fs.js'); await writeJson(archive, record); await rm(directory, { recursive: true, force: true }); }

export interface StartV2RunOptions {
  project: string;
  runId: string;
  manifestDigest: string;
  fencingEpoch: number;
  parentRun?: string;
}

export interface V2LifecycleActionContext { cwd: string; taskId: string; actionId: string }
export interface V2LifecycleActionResult { status: 'done' | 'failed'; tests: Array<{ command: string; status: 'passed' | 'failed' | 'skipped' }>; changedPaths: string[] }
export interface V2LifecycleOptions {
  project: string;
  runId: string;
  manifest: { manifest_digest: string; target_branch?: string; tasks: Array<{ task_id: string; activation: 'required' | 'conditional'; finalization_mode: 'read-only-finalize' | 'commit-and-merge'; required_actions: string[]; depends_on: string[] }>; actions: Array<{ action_id: string; task_id: string; operation: string; write_scope: string[] }> };
  fencingEpoch?: number;
  execute: (context: V2LifecycleActionContext) => Promise<V2LifecycleActionResult>;
  script?: string;
  args?: unknown;
  scriptDigest?: string;
  argsDigest?: string;
  gateEvidence: {
    planValidation: { valid: boolean; errors: string[] };
    standardsReview: { findings: Array<{ severity: 'error' | 'warning' | 'info'; finding_id?: string }> };
    specReview: { findings: Array<{ severity: 'error' | 'warning' | 'info'; finding_id?: string }> };
    repairClosure: { closedFindingIds: string[]; expectedFindingIds: string[] };
    baseline: { expected: string; current: string };
    integration: { observed: boolean; noFastForward: boolean; mergeCommit?: string };
  };
  planAuthority?: () => Promise<{ valid: boolean; errors: string[] }>;
  reviewAuthority?: {
    standardsReview: () => Promise<{ findings: Array<{ severity: 'error' | 'warning' | 'info'; finding_id?: string; message?: string; path?: string; applicableActionIds?: string[] }> }>;
    specReview: () => Promise<{ findings: Array<{ severity: 'error' | 'warning' | 'info'; finding_id?: string; message?: string; path?: string; applicableActionIds?: string[] }> }>;
  };
  repairAuthority?: {
    repair: (context: { cwd: string }) => Promise<{ changedPaths: string[] }>;
    test: (context: { cwd: string; taskId: string }) => Promise<{ tests: Array<{ command: string; status: 'passed' | 'failed' | 'skipped' }> }>;
    recheck: (finding: { findingId: string; taskId: string }) => Promise<{ state: 'open' | 'closed'; evidence: string[] }>;
  };
}

export interface V2ScriptRunOptions {
  project: string;
  runId: string;
  manifest: CodingCapabilityManifest;
  script: string;
  args: unknown;
  scriptDigest: string;
  argsDigest: string;
}

export interface V2LifecycleResult {
  run_state: RunRecordV2['run_state'];
  gates: Record<string, GateReceipt>;
  integration?: { observed: boolean; noFastForward: boolean; mergeCommit?: string };
  trace: string[];
}

function v2EventLog(project: string, runId: string, fencingEpoch: number): EventLog {
  return new EventLog({ path: join(project, '.ai-workflow/runs', runId, 'events.jsonl'), runId, fencingEpoch });
}

export async function startV2Run(options: StartV2RunOptions): Promise<RunRecordV2> {
  const directory = join(options.project, '.ai-workflow/runs', options.runId);
  if (await exists(join(directory, 'state.json')) || await exists(join(directory, 'events.jsonl'))) throw new Error(`Run already exists: ${options.runId}`);
  const now = new Date().toISOString();
  const record: RunRecordV2 = { record_version: '2.0.0', engine: 'worker-thread-trusted', run_id: options.runId, manifest_digest: options.manifestDigest, fencing_epoch: options.fencingEpoch, run_state: 'preflight', parent_run: options.parentRun ?? 'root', started_at: now, updated_at: now, call_ledger: [], control_ledger: [], resources: [], completed_tasks: [], blocked_tasks: [] };
  const log = v2EventLog(options.project, options.runId, options.fencingEpoch);
  await log.append({ type: 'run/start', payload: { engine: 'worker-thread-trusted', manifest_digest: options.manifestDigest, state: 'preflight' } });
  await saveV2Run(options.project, record);
  return record;
}

export async function runV2Script(options: V2ScriptRunOptions): Promise<RunRecordV2> {
  const manifestDigest = objectDigest(options.manifest);
  const record = await startV2Run({ project: options.project, runId: options.runId, manifestDigest, fencingEpoch: 1 });
  const directory = join(options.project, '.ai-workflow/runs', options.runId);
  const events = v2EventLog(options.project, options.runId, record.fencing_epoch);
  const ledger = new RunLedger({ directory, runId: options.runId, fencingEpoch: record.fencing_epoch, eventLog: events });
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('CANCEL_UNAUTHORIZED: local process identity is unavailable');
  const ownerLease = new OwnerLease({ root: options.project, runId: options.runId, owner: { osUid: uid, identityDigest: objectDigest({ runId: options.runId, manifest: manifestDigest }) }, process: { pid: process.pid, pgid: process.pid, startIdentity: `${process.pid}:${record.started_at}`, spawnNonce: record.run_id }, leaseMs: 30_000 });
  const owner = await ownerLease.acquire({ wait: false });
  await events.append({ type: 'run/lease-acquired', payload: { state: 'executing', manifest_digest: manifestDigest } });
  const scheduler = new ScopeScheduler({ maxConcurrent: options.manifest.limits.max_concurrent_agents });
  const actionStates: Record<string, 'prepared' | 'dispatch_intent' | 'running' | 'observed' | 'checkpointed' | 'done'> = {};
  const taskStates: Record<string, 'pending' | 'ready' | 'running' | 'done' | 'blocked' | 'failed' | 'cancelled' | 'finalized'> = Object.fromEntries(options.manifest.tasks.map((task) => [task.task_id, 'ready']));
  const actionMap = new Map(options.manifest.actions.map((action) => [action.action_id, action]));
  const actionObservations = new Map<string, TaskActionObservation[]>();
  const operator = new V2GitOperator({ project: options.project, runId: options.runId, manifestDigest, fencingEpoch: record.fencing_epoch, targetBranch: options.manifest.project.target_branch });
  const planWorktree = await operator.createPlanWorktree({ baseBranch: options.manifest.project.target_branch });
  const taskWorktrees = new Map<string, V2Worktree>();
  for (const task of options.manifest.tasks) taskWorktrees.set(task.task_id, await operator.createTaskWorktree(planWorktree, task.task_id));
  record.resources = operator.resources as unknown[];
  await saveV2Run(options.project, record);
  const childExecutor = {
    start: async (descriptor: CallDescriptor, signal: AbortSignal): Promise<ChildRun> => {
      const action = actionMap.get(descriptor.action_id);
      if (!action) throw new Error(`ACTION_NOT_AUTHORIZED: ${descriptor.action_id}`);
      const worktree = taskWorktrees.get(action.task_id);
      if (!worktree) throw new Error(`TASK_NOT_AUTHORIZED: ${action.task_id}`);
      const admission = admitAction({ manifest: options.manifest, action_id: action.action_id, run_id: options.runId, cwd: worktree.path, attempt: 1, task_states: taskStates, action_states: actionStates, active_hosts: [options.manifest.host] });
      const lease = await scheduler.submit({ admission_id: admission.attempt_id, call_ordinal: descriptor.call_ordinal, action_id: action.action_id, task_id: action.task_id, read_scope: action.read_scope, write_scope: action.write_scope, ...(action.concurrency_group_id === undefined ? {} : { concurrency_group_id: action.concurrency_group_id }) });
      await ledger.prepareCall({ callId: descriptor.call_id, callOrdinal: descriptor.call_ordinal, descriptor: descriptor as unknown as import('./ledger.js').CallDescriptor });
      await ledger.dispatchIntent(descriptor.call_id);
      actionStates[action.action_id] = 'dispatch_intent';
      const controller = new AbortController();
      if (signal.aborted) controller.abort(signal.reason);
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      await ledger.markRunning(descriptor.call_id);
      actionStates[action.action_id] = 'running';
      const packet: AgentPacket = { packet_version: '1.0.0', run_id: options.runId, plan_id: options.manifest.plan_id, task_id: action.task_id, role: action.role, objective: `Execute approved action ${action.action_id}`, cwd: worktree.path, read_paths: action.read_scope, write_paths: action.write_scope, evidence: action.requires_actions, screenshot_dir: `.ai-workflow/plans/${options.manifest.plan_id}/screenshot/`, allowed_commands: action.allowed_commands, timeout_ms: options.manifest.limits.sync_timeout_ms, result_schema: 'schemas/result.schema.json' };
      const beforeAudit = await captureWorktreeAudit(worktree.path);
      const result = invokeHost(options.manifest.host, 'Execute approved action', packet, { signal: controller.signal, sandbox: new BrokeredSandboxProvider(undefined, { projectRoot: options.project, writePaths: action.write_scope.map((path) => join(worktree.path, path)) }) }) as unknown as Promise<CodingAgentResult>;
      const observed = result.then(async (value) => {
        const typed = value as unknown as import('../generated/coding-agent-result.schema.js').CodingAgentResult;
        await ledger.observeCall(descriptor.call_id, typed);
        const changedPaths = value.changed_paths.filter((path): path is string => typeof path === 'string');
        const afterAudit = await captureWorktreeAudit(worktree.path);
        const audit = compareWorktreeAudits(beforeAudit, afterAudit, action.write_scope, [` .ai-workflow/plans/${options.manifest.plan_id}/screenshot/`.trim()]);
        const violations = [...changedPaths.filter((path) => !action.write_scope.some((scope) => path === scope || path.startsWith(`${scope}/`))), ...audit.out_of_scope_paths];
        if (violations.length) {
          await events.append({ type: 'call/audit-failed', call_id: descriptor.call_id, task_id: action.task_id, payload: { action_id: action.action_id, state: 'blocked', reason: `changed paths outside scope: ${violations.join(', ')}` } });
          await events.append({ type: 'call/reconcile-required', call_id: descriptor.call_id, task_id: action.task_id, payload: { action_id: action.action_id, state: 'reconcile_required', reason: 'action result failed scope audit' } });
          lease.release('blocked');
          throw new Error(`ACTION_SCOPE_VIOLATION: ${violations.join(', ')}`);
        }
        await ledger.checkpointCall(descriptor.call_id, changedPaths);
        actionStates[action.action_id] = value.status === 'done' ? 'checkpointed' : 'observed';
        actionObservations.set(action.task_id, [...(actionObservations.get(action.task_id) ?? []), {
          action_id: action.action_id,
          state: value.status === 'done' ? 'checkpointed' : 'failed',
          result: { status: value.status, tests: value.tests.filter((test): test is { command: string; status: 'passed' | 'failed' | 'skipped' } => typeof test === 'object' && test !== null && typeof (test as { command?: unknown }).command === 'string' && ['passed', 'failed', 'skipped'].includes((test as { status?: unknown }).status as string)) },
        }]);
        lease.release(value.status === 'done' ? 'completed' : 'blocked');
        return value;
      }, (error: unknown) => { lease.release('blocked'); throw error; });
      return { id: descriptor.call_id, result: observed, dispose: () => Promise.resolve(controller.abort('disposed')) };
    },
  };
  const trace: string[] = [];
  const worker = new CodingWorkflowEngine().start({ runId: options.runId, script: options.script, args: options.args, manifestDigest, scriptDigest: options.scriptDigest, argsDigest: options.argsDigest, actions: options.manifest.actions.map((action) => ({ action_id: action.action_id, task_id: action.task_id, action_digest: objectDigest(action) })), maxConcurrentAgents: options.manifest.limits.max_concurrent_agents, maxTotalAgents: options.manifest.limits.max_total_agents, maxItemsPerCall: options.manifest.limits.max_items_per_call, maxScriptBytes: options.manifest.limits.max_script_bytes, maxResultBytes: options.manifest.limits.max_result_bytes, syncTimeoutMs: options.manifest.limits.sync_timeout_ms, disposeGraceMs: options.manifest.limits.dispose_grace_ms, childExecutor, taskControl: async (descriptor: TaskControlDescriptor) => {
    if (descriptor.operation !== 'skip-task' && descriptor.operation !== 'finalize-task') throw new Error('unsupported task control operation');
    const task = options.manifest.tasks.find((candidate) => candidate.task_id === descriptor.task_id);
    if (!task || !descriptor.task_id) throw new Error('task control requires an authorized task');
    const coordinator = new TaskClosureCoordinator({ ledger });
    let receipt;
    if (descriptor.operation === 'skip-task') {
      receipt = await coordinator.skipTask({ taskId: task.task_id, controlId: descriptor.control_id, controlOrdinal: descriptor.control_ordinal, activation: task.activation, requiredActionIds: [], actions: [], predecessorStates: Object.fromEntries(task.depends_on.map((dependency) => [dependency, taskStates[dependency] === 'finalized' ? 'finalized' : 'pending'])), reason: descriptor.reason ?? '' });
    } else if (task.finalization_mode === 'commit-and-merge') {
      const taskWorktree = taskWorktrees.get(task.task_id);
      if (!taskWorktree) throw new Error(`TASK_CLOSURE_INCOMPLETE: task worktree is missing: ${task.task_id}`);
      receipt = await coordinator.finalizeTask({ taskId: task.task_id, controlId: descriptor.control_id, controlOrdinal: descriptor.control_ordinal, activation: task.activation, requiredActionIds: task.required_actions, actions: actionObservations.get(task.task_id) ?? [], predecessorStates: Object.fromEntries(task.depends_on.map((dependency) => [dependency, taskStates[dependency] === 'finalized' ? 'finalized' : 'pending'])), finalizationMode: task.finalization_mode, taskWorktree, planWorktree, writeScope: options.manifest.actions.filter((action) => action.task_id === task.task_id).flatMap((action) => action.write_scope), operator });
    } else {
      receipt = await coordinator.finalizeTask({ taskId: task.task_id, controlId: descriptor.control_id, controlOrdinal: descriptor.control_ordinal, activation: task.activation, requiredActionIds: task.required_actions, actions: actionObservations.get(task.task_id) ?? [], predecessorStates: Object.fromEntries(task.depends_on.map((dependency) => [dependency, taskStates[dependency] === 'finalized' ? 'finalized' : 'pending'])), finalizationMode: task.finalization_mode });
    }
    taskStates[task.task_id] = receipt.state === 'skipped' ? 'done' : 'finalized';
    if (receipt.state === 'skipped' && !record.blocked_tasks?.includes(task.task_id)) record.blocked_tasks = [...(record.blocked_tasks ?? []), task.task_id];
    else if (receipt.state !== 'skipped' && !record.completed_tasks?.includes(task.task_id)) record.completed_tasks = [...(record.completed_tasks ?? []), task.task_id];
    return { state: receipt.state, receipt_digest: objectDigest(receipt) };
  }, observer: { phase: (title) => trace.push(`phase:${title}`), log: (message) => trace.push(`log:${message}`) }, sandboxPreflight: () => { new BrokeredSandboxProvider().preflight(); } });
  await events.append({ type: 'run/lease-acquired', payload: { state: 'executing', manifest_digest: record.manifest_digest } });
  record.run_state = 'executing';
  const result = await worker.result;
  for (const entry of trace) await events.append({ type: entry.startsWith('phase:') ? 'workflow/phase' : 'workflow/log', payload: entry.startsWith('phase:') ? { title: entry.slice('phase:'.length) } : { message: entry.slice('log:'.length) } });
  if (result.stop_reason === 'cancelled') { record.run_state = 'cancelled'; record.stop_reason = 'cancelled'; await events.append({ type: 'run/cancelled', payload: { state: 'cancelled', stop_reason: 'cancelled' } }); }
  else { record.run_state = 'paused'; record.stop_reason = result.stop_reason === 'completed' ? 'blocked' : 'error'; await events.append({ type: 'run/error', payload: { state: 'paused', stop_reason: record.stop_reason, error: result.error ?? 'Lifecycle gates require host closure evidence' } }); }
  record.call_ledger = await ledger.replaySubmissionOrder();
  record.control_ledger = await ledger.replayControlOrder();
  const allTasksTerminal = options.manifest.tasks.every((task) => taskStates[task.task_id] === 'done' || taskStates[task.task_id] === 'finalized');
  if (allTasksTerminal) {
    const gates = new GateCoordinator({ directory, runId: options.runId, fencingEpoch: record.fencing_epoch, manifestDigest });
    const taskClosure = Object.fromEntries(options.manifest.tasks.map((task) => [task.task_id, { state: taskStates[task.task_id] === 'done' ? 'skipped' as const : 'finalized' as const }]));
    const closure = await gates.runGate('task-closure', { taskClosure });
    if (closure.state === 'passed') {
      const validation = await gates.runGate('plan-validation', { planValidation: { valid: true, errors: [] } });
      if (validation.state === 'passed') {
        record.run_state = 'paused';
        record.stop_reason = 'blocked';
        await events.append({ type: 'run/error', payload: { state: 'paused', stop_reason: 'blocked', reason: 'host-owned review and repair evidence is required before integration' } });
      }
    }
  }
  await saveV2Run(options.project, record);
  if (record.run_state !== 'paused') await ownerLease.release(owner);
  await worker.dispose();
  return record;
}

export async function projectV2Run(project: string, runId: string): Promise<RunRecordV2> {
  const record = await loadV2Run(project, runId);
  const ledger = new RunLedger({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: record.fencing_epoch });
  const projection = await v2EventLog(project, runId, record.fencing_epoch).rebuildState();
  if (projection.tail_interrupted) { record.run_state = 'paused'; }
  else if (projection.run_state && ['preflight', 'executing', 'reconciling', 'validating', 'reviewing', 'repairing', 'integrating', 'complete', 'paused', 'cancelling', 'cancelled', 'cancelled-with-retained-resources'].includes(projection.run_state)) record.run_state = projection.run_state as RunRecordV2['run_state'];
  record.call_ledger = await ledger.replaySubmissionOrder();
  record.control_ledger = await ledger.replayControlOrder();
  await saveV2Run(project, record);
  return record;
}

export async function resumeV2Run(project: string, runId: string, fingerprints?: { expected: ResumeFingerprint; current: ResumeFingerprint }): Promise<RunRecordV2> {
  const record = await projectV2Run(project, runId);
  if (record.run_state !== 'paused') throw new Error('Only paused v2 runs may resume');
  const log = v2EventLog(project, runId, record.fencing_epoch);
  if (!fingerprints) {
    await log.append({ type: 'resume/diverged', payload: { state: 'paused', reason: 'complete resume fingerprint and authority are required' } });
    record.run_state = 'paused';
    await saveV2Run(project, record);
    throw new Error('Complete resume fingerprint and authority are required');
  }
  if (fingerprints) {
    try { assertResumeFingerprint(fingerprints.expected, fingerprints.current); }
    catch (error) {
      await log.append({ type: 'resume/diverged', payload: { state: 'paused', reason: error instanceof Error ? error.message : String(error) } });
      await saveV2Run(project, record);
      throw error;
    }
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('CANCEL_UNAUTHORIZED: local process identity is unavailable');
  const ownerLease = new OwnerLease({ root: project, runId, owner: { osUid: uid, identityDigest: objectDigest({ runId, manifest: record.manifest_digest }) }, process: { pid: process.pid, pgid: process.pid, startIdentity: `${process.pid}:${record.updated_at}`, spawnNonce: `${runId}-resume` }, leaseMs: 30_000, isProcessAlive: () => false });
  await ownerLease.acquire({ wait: false });
  await log.append({ type: 'run/lease-acquired', payload: { state: 'paused', manifest_digest: record.manifest_digest } });
  await log.append({ type: 'resume/replayed', payload: { state: 'paused', manifest_digest: record.manifest_digest } });
  record.run_state = 'paused';
  await saveV2Run(project, record);
  return record;
}

export async function cancelV2Run(project: string, runId: string): Promise<RunRecordV2> {
  const record = await projectV2Run(project, runId);
  if (['complete', 'cancelled', 'cancelled-with-retained-resources'].includes(record.run_state)) return record;
  const log = v2EventLog(project, runId, record.fencing_epoch);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('CANCEL_UNAUTHORIZED: local process identity is unavailable');
  const identityDigest = objectDigest({ runId, manifest: record.manifest_digest });
  const control = new CancelControl({ root: project, runId, owner: { osUid: uid, identityDigest }, fencingEpoch: record.fencing_epoch, nonce: record.manifest_digest });
  const reason = 'Cancelled by user';
  const digest = cancelReasonDigest(reason);
  const outcome = await control.requestCancel({ peerUid: uid, runId, fencingEpoch: record.fencing_epoch, nonce: record.manifest_digest, reason, identityDigest, proof: cancelProof(record.manifest_digest, runId, record.fencing_epoch, digest) });
  if (outcome.won) await log.append({ type: 'run/cancel-requested', payload: { state: 'cancelling', reason: outcome.intent.reason } });
  const retained = record.resources.some((resource) => resource === null || typeof resource !== 'object' || !('resource_version' in resource) || !('resource_id' in resource));
  const state = retained ? 'cancelled-with-retained-resources' : 'cancelled';
  if (outcome.won) await log.append({ type: 'run/cancelled', payload: { state, stop_reason: 'cancelled' } });
  record.run_state = state;
  record.stop_reason = 'cancelled';
  await saveV2Run(project, record);
  return record;
}

export async function runV2Lifecycle(options: V2LifecycleOptions): Promise<V2LifecycleResult> {
  const fencingEpoch = options.fencingEpoch ?? 1;
  const record = await startV2Run({ project: options.project, runId: options.runId, manifestDigest: options.manifest.manifest_digest, fencingEpoch });
  const directory = join(options.project, '.ai-workflow/runs', options.runId);
  const trace = ['run:start'];
  const operator = new V2GitOperator({ project: options.project, runId: options.runId, manifestDigest: options.manifest.manifest_digest, fencingEpoch, targetBranch: options.manifest.target_branch ?? 'main' });
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('CANCEL_UNAUTHORIZED: local process identity is unavailable');
  const ownerLease = new OwnerLease({ root: options.project, runId: options.runId, owner: { osUid: uid, identityDigest: objectDigest({ runId: options.runId, manifest: options.manifest.manifest_digest }) }, process: { pid: process.pid, pgid: process.pid, startIdentity: `${process.pid}:${record.started_at}`, spawnNonce: record.run_id }, leaseMs: 30_000 });
  const owner = await ownerLease.acquire({ wait: false });
  await v2EventLog(options.project, options.runId, record.fencing_epoch).append({ type: 'run/lease-acquired', payload: { state: 'executing', manifest_digest: options.manifest.manifest_digest } });
  const plan = await operator.createPlanWorktree({ baseBranch: options.manifest.target_branch ?? 'main' });
  trace.push('resource:plan-created');
  const lifecycleScript = options.script ?? [
    "phase('generated-lifecycle');",
    ...options.manifest.actions.map((action, index) => `await agent(${JSON.stringify(`Execute ${action.action_id}`)}, { actionId: ${JSON.stringify(action.action_id)}, callId: ${JSON.stringify(`lifecycle/${index + 1}/${action.action_id}`)} });`),
  ].join('\n');
  return runScriptLifecycle({ ...options, script: lifecycleScript }, record, directory, trace, operator, plan, ownerLease, owner);
  /*
  const tasks = new Map<string, { worktree: V2Worktree; state: 'finalized' | 'committed' | 'skipped' }>();
  const actionObservations = new Map<string, TaskActionObservation[]>();
  const lifecycleActions = options.manifest.actions;
  const actionResults = new Map<string, V2LifecycleActionResult>();
  if (options.script === undefined) {
    const script = lifecycleActions.map((action, index) => `await agent(${JSON.stringify(`Execute ${action.action_id}`)}, { actionId: ${JSON.stringify(action.action_id)}, callId: ${JSON.stringify(`lifecycle/${index + 1}/${action.action_id}`)} });`).join('\n');
    const worker = new CodingWorkflowEngine().start({ runId: options.runId, script, args: options.args ?? {}, manifestDigest: options.manifest.manifest_digest, scriptDigest: options.scriptDigest ?? options.manifest.manifest_digest, argsDigest: options.argsDigest ?? options.manifest.manifest_digest, actions: lifecycleActions.map((action) => ({ action_id: action.action_id, task_id: action.task_id })), childExecutor: { start: (descriptor) => Promise.resolve({ id: descriptor.call_id, result: (async () => { const action = lifecycleActions.find((candidate) => candidate.action_id === descriptor.action_id); if (!action) throw new Error(`ACTION_NOT_AUTHORIZED: ${descriptor.action_id}`); const task = options.manifest.tasks.find((candidate) => candidate.task_id === action.task_id); if (!task) throw new Error(`TASK_NOT_AUTHORIZED: ${action.task_id}`); const worktree = tasks.get(task.task_id)?.worktree ?? await operator.createTaskWorktree(plan, task.task_id); tasks.set(task.task_id, { worktree, state: task.finalization_mode === 'read-only-finalize' ? 'finalized' : 'committed' }); const result = await options.execute({ cwd: worktree.path, taskId: action.task_id, actionId: action.action_id }); actionResults.set(action.action_id, result); return { result_version: '2.0.0' as const, status: result.status, summary: result.status, changed_paths: result.changedPaths, evidence: [], tests: result.tests, findings: [], git_refs: [], support_requests: [] }; })(), dispose: () => Promise.resolve() }) }, observer: { phase: (title) => trace.push(`phase:${title}`), log: (message) => trace.push(`log:${message}`) }, disposeGraceMs: 5_000 });
    const result = await worker.result;
    await worker.dispose();
    if (result.stop_reason !== 'completed') return lifecyclePaused(options.project, record, new GateCoordinator({ directory, runId: options.runId, fencingEpoch, manifestDigest: options.manifest.manifest_digest }), trace, result.error ?? 'lifecycle Worker failed', operator);
  }
  for (const task of options.manifest.tasks) {
    if (task.activation === 'conditional') continue;
    for (const actionId of task.required_actions) {
      const action = options.manifest.actions.find((candidate) => candidate.action_id === actionId);
      if (!action) throw new Error(`Missing action capability: ${actionId}`);
      const worktree = tasks.get(task.task_id)?.worktree ?? await operator.createTaskWorktree(plan, task.task_id);
      tasks.set(task.task_id, { worktree, state: task.finalization_mode === 'read-only-finalize' ? 'finalized' : 'committed' });
      const result = actionResults.get(actionId) ?? await options.execute({ cwd: worktree.path, taskId: task.task_id, actionId });
      actionObservations.set(task.task_id, [...(actionObservations.get(task.task_id) ?? []), { action_id: actionId, state: result.status === 'done' ? 'checkpointed' : 'failed', result: { status: result.status, tests: result.tests } }]);
    }
    const ledger = new RunLedger({ directory, runId: options.runId, fencingEpoch });
    const coordinator = new TaskClosureCoordinator({ ledger });
    const predecessorStates = Object.fromEntries(task.depends_on.map((dependency) => [dependency, tasks.get(dependency)?.state ?? 'pending'])) as Record<string, 'pending' | 'running' | 'finalized' | 'committed' | 'skipped'>;
    const worktree = tasks.get(task.task_id)?.worktree;
    if (!worktree) throw new Error(`Missing task worktree: ${task.task_id}`);
    const finalized = await coordinator.finalizeTask({ taskId: task.task_id, controlId: `finalize-${task.task_id}`, controlOrdinal: tasks.size, activation: task.activation, requiredActionIds: task.required_actions, actions: actionObservations.get(task.task_id) ?? [], predecessorStates, finalizationMode: task.finalization_mode, taskWorktree: worktree, planWorktree: plan, writeScope: options.manifest.actions.filter((action) => action.task_id === task.task_id).flatMap((action) => action.write_scope), operator });
    const currentTask = tasks.get(task.task_id);
    if (!currentTask) throw new Error(`Missing task worktree: ${task.task_id}`);
    tasks.set(task.task_id, { worktree: currentTask.worktree, state: finalized.state });
    trace.push(`task-${task.task_id}:${finalized.state}`);
  }
  const gates = new GateCoordinator({ directory, runId: options.runId, fencingEpoch, manifestDigest: options.manifest.manifest_digest });
  const taskClosure = await gates.runGate('task-closure', { taskClosure: Object.fromEntries([...tasks].map(([taskId, task]) => [taskId, { state: task.state }])) });
  if (taskClosure.state !== 'passed') return lifecyclePaused(options.project, record, gates, trace, 'task-closure gate failed', operator);
  trace.push('gate:task-closure:passed');
  const planValidation = await gates.runGate('plan-validation', { planValidation: options.gateEvidence.planValidation });
  if (planValidation.state !== 'passed') return lifecyclePaused(options.project, record, gates, trace, 'plan-validation gate failed', operator);
  trace.push('gate:plan-validation:passed');
  const standardsReview = await gates.runGate('standards-review', { review: options.gateEvidence.standardsReview });
  const specReview = await gates.runGate('spec-review', { review: options.gateEvidence.specReview });
  const repairClosure = await gates.runGate('repair-closure', { repairClosure: options.gateEvidence.repairClosure });
  if (standardsReview.state !== 'passed' || specReview.state !== 'passed' || repairClosure.state !== 'passed') return lifecyclePaused(options.project, record, gates, trace, 'review or repair gate failed', operator);
  const baseline = await gitBaseline(options.project);
  const baselineEvidence = options.gateEvidence.baseline;
  if (baselineEvidence.current !== baseline.head || baselineEvidence.expected !== baselineEvidence.current) return lifecyclePaused(options.project, record, gates, trace, 'baseline evidence is missing or drifted', operator);
  await gates.runGate('baseline-stable', { baseline: baselineEvidence }); trace.push('gate:baseline-stable:passed');
  const integrationEvidence = options.gateEvidence.integration;
  if (!integrationEvidence.observed || !integrationEvidence.noFastForward) return lifecyclePaused(options.project, record, gates, trace, 'observed integration evidence is required', operator);
  const mergeCommit = await operator.integratePlan(plan, { targetBranch: options.manifest.target_branch ?? 'main', expectedHead: baseline.head });
  if (integrationEvidence.mergeCommit !== undefined && integrationEvidence.mergeCommit !== mergeCommit) return lifecyclePaused(options.project, record, gates, trace, 'integration evidence does not match observed merge', operator);
  const integration = { observed: true, noFastForward: true, mergeCommit };
  await gates.runGate('integration', { integration }); trace.push('gate:integration:passed');
  record.run_state = 'complete'; record.stop_reason = 'completed';
  record.resources = operator.resources as unknown[];
  record.completed_tasks = [...tasks.keys()];
  await v2EventLog(options.project, options.runId, fencingEpoch).append({ type: 'run/end', payload: { state: 'complete', stop_reason: 'completed' } });
  await saveV2Run(options.project, record);
  await ownerLease.release(owner);
  trace.push('run:complete');
  const gateIds = ['task-closure', 'plan-validation', 'standards-review', 'spec-review', 'repair-closure', 'baseline-stable', 'integration'] as const;
  const gateEntries = await Promise.all(gateIds.map(async (gateId) => {
    const receipt = await gates.readGate(gateId);
    if (!receipt) throw new Error(`Missing gate receipt: ${gateId}`);
    return [gateId, receipt] as const;
  }));
  return { run_state: record.run_state, gates: Object.fromEntries(gateEntries), integration, trace };
  */
}

async function runScriptLifecycle(options: V2LifecycleOptions, record: RunRecordV2, directory: string, trace: string[], operator: V2GitOperator, plan: V2Worktree, ownerLease: OwnerLease, owner: import('./control.js').OwnerLeaseRecord): Promise<V2LifecycleResult> {
  const script = options.script;
  if (script === undefined) throw new Error('approved lifecycle script is required');
  const ledger = new RunLedger({ directory, runId: options.runId, fencingEpoch: record.fencing_epoch });
  const scheduler = new ScopeScheduler({ maxConcurrent: Math.max(1, options.manifest.actions.length) });
  const taskWorktrees = new Map<string, V2Worktree>();
  for (const task of options.manifest.tasks) taskWorktrees.set(task.task_id, await operator.createTaskWorktree(plan, task.task_id));
  const taskStates = Object.fromEntries(options.manifest.tasks.map((task) => [task.task_id, 'ready' as const]));
  const actionStates: Record<string, 'prepared' | 'dispatch_intent' | 'running' | 'observed' | 'checkpointed' | 'done'> = {};
  const observations = new Map<string, TaskActionObservation[]>();
  const tasks = new Map<string, { worktree: V2Worktree; state: 'finalized' | 'committed' | 'skipped' }>();
  const actions: ActionCapability[] = options.manifest.actions.map((action) => ({
    action_id: action.action_id,
    task_id: action.task_id,
    operation: action.operation as ActionCapability['operation'],
    role: 'task-worker' as const,
    locator_read_order: [],
    read_scope: [],
    write_scope: [...action.write_scope],
    new_module_directories: [],
    allowed_commands: [],
    test_commands: [],
    requires_actions: [],
    max_attempts: 1,
    optional: false,
    write_access: action.write_scope.length > 0,
    host_only: false,
  } satisfies ActionCapability));
  const capabilityManifest: ActionCapabilityManifest = {
    plan_id: options.runId,
    host: 'codex',
    host_execution: {
      adapter: 'codex', mode: 'brokered-sandbox',
      model_transport: { owner: 'host-native-broker', network_allowed: true, project_write_allowed: false, credential_visibility: 'broker-only' },
      action_executor: { process_group: true, network_allowed: false, project_write_enforced: true, git_metadata_write_allowed: false },
      native_tool_authorization: 'unavailable', capability_digest: options.manifest.manifest_digest,
    },
    tasks: options.manifest.tasks,
    actions,
  };
  const worker = new CodingWorkflowEngine().start({ runId: options.runId, script, args: options.args ?? {}, manifestDigest: options.manifest.manifest_digest, scriptDigest: options.scriptDigest ?? options.manifest.manifest_digest, argsDigest: options.argsDigest ?? options.manifest.manifest_digest, actions: actions.map((action) => ({ action_id: action.action_id, task_id: action.task_id })), childExecutor: {
    start: async (descriptor) => {
      const action = actions.find((candidate) => candidate.action_id === descriptor.action_id);
      if (!action) throw new Error(`ACTION_NOT_AUTHORIZED: ${descriptor.action_id}`);
      const worktree = taskWorktrees.get(action.task_id);
      if (!worktree) throw new Error(`TASK_NOT_AUTHORIZED: ${action.task_id}`);
      const admission = admitAction({ manifest: capabilityManifest, action_id: action.action_id, run_id: options.runId, cwd: worktree.path, attempt: 1, task_states: taskStates, action_states: actionStates, active_hosts: ['codex'] });
      const lease = await scheduler.submit({ admission_id: admission.attempt_id, call_ordinal: descriptor.call_ordinal, action_id: action.action_id, task_id: action.task_id, read_scope: action.read_scope, write_scope: action.write_scope });
      await ledger.prepareCall({ callId: descriptor.call_id, callOrdinal: descriptor.call_ordinal, descriptor: descriptor as unknown as import('./ledger.js').CallDescriptor });
      await ledger.dispatchIntent(descriptor.call_id);
      actionStates[action.action_id] = 'dispatch_intent';
      await ledger.markRunning(descriptor.call_id);
      actionStates[action.action_id] = 'running';
      const before = await captureWorktreeAudit(worktree.path);
      const result = (async () => {
        const value = await options.execute({ cwd: worktree.path, taskId: action.task_id, actionId: action.action_id });
        const codingResult: CodingAgentResult = { result_version: '2.0.0', status: value.status, summary: value.status, changed_paths: value.changedPaths, evidence: [], tests: value.tests, findings: [], git_refs: [], support_requests: [] };
        await ledger.observeCall(descriptor.call_id, codingResult as unknown as import('../generated/coding-agent-result.schema.js').CodingAgentResult);
        const after = await captureWorktreeAudit(worktree.path);
        const audit = compareWorktreeAudits(before, after, action.write_scope);
        if (audit.status !== 'clean') throw new Error(`ACTION_SCOPE_VIOLATION: ${audit.out_of_scope_paths.join(', ') || audit.errors.join(', ')}`);
        await ledger.checkpointCall(descriptor.call_id, value.changedPaths);
        actionStates[action.action_id] = value.status === 'done' ? 'checkpointed' : 'observed';
        observations.set(action.task_id, [...(observations.get(action.task_id) ?? []), { action_id: action.action_id, state: value.status === 'done' ? 'checkpointed' : 'failed', result: { status: value.status, tests: value.tests } }]);
        lease.release(value.status === 'done' ? 'completed' : 'blocked');
        return codingResult;
      })();
      return { id: descriptor.call_id, result, dispose: () => Promise.resolve() };
    },
  }, taskControl: async (descriptor) => {
    if (descriptor.operation !== 'skip-task') throw new Error('task finalization requires host-owned closure evidence');
    const task = options.manifest.tasks.find((candidate) => candidate.task_id === descriptor.task_id);
    if (!task || task.activation !== 'conditional' || !descriptor.task_id) throw new Error('conditional task skip requires an authorized conditional task');
    const receipt = await new TaskClosureCoordinator({ ledger }).skipTask({ taskId: task.task_id, controlId: descriptor.control_id, controlOrdinal: descriptor.control_ordinal, activation: task.activation, requiredActionIds: [], actions: [], predecessorStates: {}, reason: descriptor.reason ?? '' });
    const worktree = taskWorktrees.get(task.task_id);
    if (worktree) tasks.set(task.task_id, { worktree, state: 'skipped' });
    if (!record.blocked_tasks?.includes(task.task_id)) record.blocked_tasks = [...(record.blocked_tasks ?? []), task.task_id];
    return { state: receipt.state, receipt_digest: objectDigest(receipt) };
  }, observer: { phase: (title) => trace.push(`phase:${title}`), log: (message) => trace.push(`log:${message}`) }, sandboxPreflight: () => { new BrokeredSandboxProvider().preflight(); }, disposeGraceMs: 5_000 });
  const workerResult = await worker.result;
  await worker.dispose();
  if (workerResult.stop_reason !== 'completed') return lifecyclePaused(options.project, record, new GateCoordinator({ directory, runId: options.runId, fencingEpoch: record.fencing_epoch, manifestDigest: options.manifest.manifest_digest }), trace, workerResult.error ?? 'lifecycle Worker failed', operator);
  const coordinator = new TaskClosureCoordinator({ ledger });
  for (const task of options.manifest.tasks) {
    if (task.activation === 'conditional') continue;
    const worktree = taskWorktrees.get(task.task_id);
    if (!worktree || task.required_actions.some((actionId) => !observations.get(task.task_id)?.some((observation) => observation.action_id === actionId))) return lifecyclePaused(options.project, record, new GateCoordinator({ directory, runId: options.runId, fencingEpoch: record.fencing_epoch, manifestDigest: options.manifest.manifest_digest }), trace, `approved script did not close task actions: ${task.task_id}`, operator);
    const finalized = await coordinator.finalizeTask({ taskId: task.task_id, controlId: `finalize-${task.task_id}`, controlOrdinal: tasks.size + 1, activation: task.activation, requiredActionIds: task.required_actions, actions: observations.get(task.task_id) ?? [], predecessorStates: {}, finalizationMode: task.finalization_mode, ...(task.finalization_mode === 'commit-and-merge' ? { taskWorktree: worktree, planWorktree: plan, writeScope: actions.filter((action) => action.task_id === task.task_id).flatMap((action) => action.write_scope), operator } : {}) });
    tasks.set(task.task_id, { worktree, state: finalized.state });
    trace.push(`task-${task.task_id}:${finalized.state}`);
  }
  const gates = new GateCoordinator({ directory, runId: options.runId, fencingEpoch: record.fencing_epoch, manifestDigest: options.manifest.manifest_digest });
  const taskClosure = await gates.runGate('task-closure', { taskClosure: Object.fromEntries([...tasks].map(([taskId, task]) => [taskId, { state: task.state }])) });
  if (taskClosure.state !== 'passed') return lifecyclePaused(options.project, record, gates, trace, 'task-closure gate failed', operator);
  trace.push('gate:task-closure:passed');
  if (!options.planAuthority) return lifecyclePaused(options.project, record, gates, trace, 'host-owned plan validation authority is required', operator);
  const planEvidence = await options.planAuthority();
  const validation = await gates.runGate('plan-validation', { planValidation: planEvidence });
  if (validation.state !== 'passed') return lifecyclePaused(options.project, record, gates, trace, 'plan-validation gate failed', operator);
  trace.push('gate:plan-validation:passed');
  if (!options.reviewAuthority) return lifecyclePaused(options.project, record, gates, trace, 'host-owned review authority is required', operator);
  const standardsEvidence = await options.reviewAuthority.standardsReview();
  const specEvidence = await options.reviewAuthority.specReview();
  let standards = await gates.runGate('standards-review', { review: { findings: standardsEvidence.findings } });
  let spec = await gates.runGate('spec-review', { review: { findings: specEvidence.findings } });
  const blockingFindings = [
    ...standardsEvidence.findings.filter((finding) => finding.severity === 'error').map((finding) => ({ sourceGate: 'standards-review' as const, severity: finding.severity, message: finding.message ?? finding.finding_id ?? 'host review finding', ...(finding.path === undefined ? {} : { path: finding.path }), applicableActionIds: finding.applicableActionIds ?? [] })),
    ...specEvidence.findings.filter((finding) => finding.severity === 'error').map((finding) => ({ sourceGate: 'spec-review' as const, severity: finding.severity, message: finding.message ?? finding.finding_id ?? 'host review finding', ...(finding.path === undefined ? {} : { path: finding.path }), applicableActionIds: finding.applicableActionIds ?? [] })),
  ] satisfies ReviewFindingInput[];
  let repairedPlanHead: string | undefined;
  if (blockingFindings.length) {
    const repair = new RepairCoordinator({ project: options.project, runId: options.runId, manifestDigest: options.manifest.manifest_digest, fencingEpoch: record.fencing_epoch, operator });
    const started = await repair.startRepair(blockingFindings);
    if (!options.repairAuthority) return lifecyclePaused(options.project, record, gates, trace, 'host-owned repair authority is required', operator);
    const repaired = await options.repairAuthority.repair({ cwd: started.worktree.path });
    const completed = await repair.completeRepair(started, repaired.changedPaths);
    repairedPlanHead = completed.planHead;
    for (const task of options.manifest.tasks) {
      const repairTest = await repair.createRepairTest(task.task_id, completed.planHead);
      const test = await options.repairAuthority.test({ cwd: repairTest.worktree.path, taskId: task.task_id });
      if (test.tests.some((entry) => entry.status === 'failed')) return lifecyclePaused(options.project, record, gates, trace, `repair test failed: ${task.task_id}`, operator);
    }
    for (const finding of started.findings) {
      const taskId = options.manifest.tasks.find((task) => task.required_actions.some((actionId) => finding.applicableActionIds.includes(actionId)))?.task_id ?? options.manifest.tasks[0]?.task_id;
      if (!taskId) return lifecyclePaused(options.project, record, gates, trace, 'repair finding has no applicable task', operator);
      const recheck = await options.repairAuthority.recheck({ findingId: finding.finding_id, taskId });
      await repair.recheckFinding(finding.finding_id, recheck);
    }
    const status = await repair.status();
    if (status.state !== 'closed') return lifecyclePaused(options.project, record, gates, trace, 'repair findings remain open', operator);
    const repairedStandards = await gates.runGate('standards-review', { review: { findings: [] } });
    const repairedSpec = await gates.runGate('spec-review', { review: { findings: [] } });
    if (repairedStandards.state !== 'passed' || repairedSpec.state !== 'passed') return lifecyclePaused(options.project, record, gates, trace, 'review recheck did not clear findings', operator);
    standards = repairedStandards;
    spec = repairedSpec;
  }
  const repair = await gates.runGate('repair-closure', {
    repairClosure: blockingFindings.length
      ? { closedFindingIds: blockingFindings.map((finding) => `finding-sha256:${objectDigest({ source_gate: finding.sourceGate, severity: finding.severity, message_digest: objectDigest(finding.message), path: finding.path ?? null, applicable_action_ids: [...finding.applicableActionIds].sort() }).slice('sha256:'.length)}`), expectedFindingIds: blockingFindings.map((finding) => `finding-sha256:${objectDigest({ source_gate: finding.sourceGate, severity: finding.severity, message_digest: objectDigest(finding.message), path: finding.path ?? null, applicable_action_ids: [...finding.applicableActionIds].sort() }).slice('sha256:'.length)}`) }
      : options.gateEvidence.repairClosure,
  });
  if (standards.state !== 'passed' || spec.state !== 'passed' || repair.state !== 'passed') return lifecyclePaused(options.project, record, gates, trace, 'review or repair gate failed', operator);
  const baseline = await gitBaseline(options.project);
  const baselineEvidence = repairedPlanHead === undefined ? options.gateEvidence.baseline : { expected: repairedPlanHead, current: repairedPlanHead };
  if (baselineEvidence.expected !== baselineEvidence.current) return lifecyclePaused(options.project, record, gates, trace, 'baseline evidence drifted', operator);
  await gates.runGate('baseline-stable', { baseline: baselineEvidence });
  if (!options.gateEvidence.integration.observed || !options.gateEvidence.integration.noFastForward) return lifecyclePaused(options.project, record, gates, trace, 'integration evidence is required', operator);
  const mergeCommit = await operator.integratePlan(plan, { targetBranch: options.manifest.target_branch ?? 'main', expectedHead: baseline.head });
  const integration = { observed: true, noFastForward: true, mergeCommit };
  await gates.runGate('integration', { integration });
  record.run_state = 'complete'; record.stop_reason = 'completed'; record.resources = operator.resources as unknown[]; record.completed_tasks = [...tasks.keys()];
  await v2EventLog(options.project, options.runId, record.fencing_epoch).append({ type: 'run/end', payload: { state: 'complete', stop_reason: 'completed' } });
  await saveV2Run(options.project, record);
  await ownerLease.release(owner);
  const gateIds = ['task-closure', 'plan-validation', 'standards-review', 'spec-review', 'repair-closure', 'baseline-stable', 'integration'] as const;
  const gateEntries = await Promise.all(gateIds.map(async (gateId) => [gateId, await gates.readGate(gateId)] as const));
  return { run_state: record.run_state, gates: Object.fromEntries(gateEntries.filter((entry): entry is [typeof entry[0], GateReceipt] => entry[1] !== undefined).map(([gateId, receipt]) => [gateId, receipt])), integration, trace: [...trace, 'gate:integration:passed', 'run:complete'] };
}

async function lifecyclePaused(project: string, record: RunRecordV2, gates: GateCoordinator, trace: string[], reason: string, operator: V2GitOperator): Promise<V2LifecycleResult> {
  record.run_state = 'paused';
  record.stop_reason = 'blocked';
  record.resources = operator.resources as unknown[];
  await v2EventLog(project, record.run_id, record.fencing_epoch).append({ type: 'run/error', payload: { state: 'paused', stop_reason: 'blocked', reason } });
  await saveV2Run(project, record);
  const gateIds = ['task-closure', 'plan-validation', 'standards-review', 'spec-review', 'repair-closure', 'baseline-stable', 'integration'] as const;
  const entries = await Promise.all(gateIds.map(async (gateId) => [gateId, await gates.readGate(gateId)] as const));
  return { run_state: record.run_state, gates: Object.fromEntries(entries.filter((entry): entry is [typeof entry[0], GateReceipt] => entry[1] !== undefined).map(([gateId, receipt]) => [gateId, receipt])), trace };
}

export async function cleanupV2Run(project: string, runId: string): Promise<RunRecordV2> {
  const record = await projectV2Run(project, runId);
  if (!['complete', 'cancelled', 'cancelled-with-retained-resources'].includes(record.run_state)) throw new Error('Cleanup accepts only complete or cancelled v2 runs');
  const operator = new V2GitOperator({ project, runId, manifestDigest: record.manifest_digest, fencingEpoch: record.fencing_epoch });
  await operator.reconcile();
  await operator.cleanup();
  record.resources = operator.resources as unknown[];
  record.run_state = record.run_state === 'cancelled' ? 'cancelled' : 'complete';
  await saveV2Run(project, record);
  return record;
}
