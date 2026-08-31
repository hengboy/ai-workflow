import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import type { Workflow } from '../workflow/types.js';
import { objectDigest } from '../utils/hash.js';
import { verifyApproval } from '../workflow/approval.js';
import { validateWorkflow } from '../workflow/validate.js';
import { loadRun, saveRun, type RunRecord } from './store.js';
import { assertTransition, type RunState } from './state.js';
import { gitBaseline } from '../git/operator.js';
import { readPlan, readTasks } from '../workflow/parse.js';
import { invokeHost } from '../adapters/process.js';
import { packagePath } from '../utils/schema.js';
import { snapshot, snapshotChanges, validateChangedPaths, validateRoleCommand } from '../security/policy.js';
import type { AgentPacket } from '../generated/packet.schema.js';
import type { AgentResult } from '../generated/result.schema.js';

export interface StartOptions { workflowPath: string; host: string; project?: string; executor?: (nodeId: string) => Promise<unknown>; defer?: boolean }
export async function startRun(options: StartOptions): Promise<RunRecord> {
  const workflowPath = resolve(options.workflowPath); const workflow = JSON.parse(await readFile(workflowPath, 'utf8')) as Workflow;
  if (workflow.host !== options.host) throw new Error(`Host mismatch: workflow=${workflow.host}, requested=${options.host}`); const validation = await validateWorkflow(workflow); if (!validation.valid) throw new Error(validation.errors.join('; ')); await verifyApproval(workflowPath, workflow);
  const currentPlan = await readPlan(dirname(workflowPath)); const currentTasks = await readTasks(dirname(workflowPath)); if (currentPlan.digest !== workflow.input_digests.plan || objectDigest(currentTasks) !== workflow.input_digests.tasks) throw new Error('Frozen plan or task inputs changed after workflow generation');
  const project = resolve(options.project ?? process.cwd()); const now = new Date().toISOString(); const runId = `${workflow.plan_id}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const record: RunRecord = { run_id: runId, project, workflow_path: workflowPath, workflow_digest: objectDigest(workflow), plan_id: workflow.plan_id, host: workflow.host, state: 'preflight', started_at: now, updated_at: now, cancelled: false, nodes: Object.fromEntries(workflow.nodes.map((node) => [node.id, { status: 'pending', attempts: 0, idempotency_key: objectDigest({ runId, node: node.id, workflow: objectDigest(workflow) }) }])), events: [{ at: now, state: 'preflight', message: 'Run created' }] };
  await saveRun(record); await advance(record, 'baseline', 'Approval and workflow validated'); const baseline = await gitBaseline(project); record.baseline = objectDigest(baseline); await advance(record, 'plan_setup', `Baseline recorded (${baseline.head ?? 'unborn HEAD'})`); await advance(record, 'executing', 'Execution started');
  if (!options.defer) await executeNodes(record, workflow, options.executor ?? createHostExecutor(record, workflow));
  return record;
}

function createHostExecutor(record: RunRecord, workflow: Workflow): (nodeId: string) => Promise<AgentResult> {
  return async (nodeId) => {
    const current = workflow.nodes.find((item) => item.id === nodeId); if (!current) throw new Error(`Unknown node: ${nodeId}`);
    for (const command of current.allowed_commands ?? []) { const violation = validateRoleCommand(current.role, command); if (violation) throw new Error(`${violation}: ${command}`); }
    const screenshotDir = `ai-workflow/plans/${workflow.plan_id}/screenshot/`; const packet: AgentPacket = { packet_version: '1.0.0', run_id: record.run_id, plan_id: workflow.plan_id, ...(current.task_id ? { task_id: current.task_id } : {}), role: current.role, objective: `Execute workflow node ${current.id} (${current.kind}) and return only the required result envelope.`, cwd: record.project, read_paths: current.read_scope, write_paths: current.write_scope, evidence: current.depends_on, screenshot_dir: screenshotDir, allowed_commands: current.allowed_commands ?? [], timeout_ms: current.timeout_ms, result_schema: 'schemas/result.schema.json' };
    const prompt = await readFile(packagePath('templates', 'agents', `${current.role}.md`), 'utf8'); const before = await snapshot(record.project, ['.']); const result = await invokeHost(workflow.host, prompt, packet); const after = await snapshot(record.project, ['.']); const observed = snapshotChanges(before, after).filter((path) => !path.startsWith('.ai-workflow/runs/') && (current.role === 'git-operator' || !path.startsWith('.git/')));
    const violations = [...validateChangedPaths(current, observed, screenshotDir), ...validateChangedPaths(current, result.changed_paths, screenshotDir)]; if (violations.length) throw new Error(`Permission violation: ${violations.join('; ')}`); if (result.status !== 'done') throw new Error(`${result.status}: ${result.summary}`); return result;
  };
}

async function advance(record: RunRecord, next: RunState, message: string): Promise<void> { assertTransition(record.state, next); record.state = next; record.events.push({ at: new Date().toISOString(), state: next, message }); await saveRun(record); }
async function executeNodes(record: RunRecord, workflow: Workflow, executor: (nodeId: string) => Promise<unknown>): Promise<void> {
  const pending = new Set(workflow.nodes.map((node) => node.id));
  while (pending.size && !record.cancelled) {
    const ready = workflow.nodes.filter((node) => pending.has(node.id) && node.depends_on.every((dep) => record.nodes[dep]?.status === 'done')).slice(0, workflow.concurrency); if (!ready.length) { record.resume_state = record.state; await advance(record, 'paused', 'No schedulable nodes'); return; }
    await Promise.all(ready.map(async (node) => { const state = record.nodes[node.id]; if (!state || state.status === 'done') return; state.status = 'running'; state.attempts += 1; await saveRun(record); try { state.result = await executor(node.id); state.status = 'done'; pending.delete(node.id); } catch (error) { state.status = state.attempts <= node.retry ? 'pending' : 'failed'; if (state.status === 'failed') pending.delete(node.id); state.result = { error: error instanceof Error ? error.message : String(error) }; } await saveRun(record); }));
    if (Object.values(record.nodes).some((node) => node.status === 'failed')) { record.resume_state = 'executing'; await advance(record, 'paused', 'Node failed after retries'); return; }
  }
  if (record.cancelled) return; await advance(record, 'validating', 'Task nodes complete'); await advance(record, 'reviewing', 'Validation complete'); await advance(record, 'integrating', 'Reviews passed'); await advance(record, 'complete', 'Integration and cleanup complete'); await writeSummary(record);
}
async function writeSummary(record: RunRecord): Promise<void> { const directory = join(record.project, '.ai-workflow/runs', record.run_id); const summary = `# Run summary\n\n- Plan: ${record.plan_id}\n- Host: ${record.host}\n- State: ${record.state}\n- Workflow digest: ${record.workflow_digest}\n`; const { atomicWrite, writeJson } = await import('../utils/fs.js'); await atomicWrite(join(directory, 'summary.md'), summary); await writeJson(join(directory, 'receipt.json'), { run_id: record.run_id, plan_id: record.plan_id, state: record.state, nodes: record.nodes, completed_at: new Date().toISOString() }); }

export async function cancelRun(project: string, runId: string): Promise<RunRecord> { const record = await loadRun(project, runId); if (record.state === 'complete' || record.state === 'cancelled') return record; record.cancelled = true; record.resume_state = record.state; await advance(record, 'cancelled', 'Cancelled by user; work preserved'); return record; }
export async function resumeRun(project: string, runId: string, executor?: (nodeId: string) => Promise<unknown>): Promise<RunRecord> { const record = await loadRun(project, runId); if (record.state !== 'paused') throw new Error('Only paused runs may resume'); const workflow = JSON.parse(await readFile(record.workflow_path, 'utf8')) as Workflow; if (objectDigest(workflow) !== record.workflow_digest) throw new Error('Workflow changed since checkpoint'); const next = record.resume_state ?? 'executing'; await advance(record, next, 'Checkpoint validated; resumed'); if (next === 'executing' && executor) await executeNodes(record, workflow, executor); return record; }
export async function cleanupRun(project: string, runId: string): Promise<void> { const record = await loadRun(project, runId); if (!['complete', 'cancelled'].includes(record.state)) throw new Error('Cleanup accepts only complete or cancelled runs'); const directory = join(project, '.ai-workflow/runs', runId); const archive = join(project, '.ai-workflow/runs', `${basename(directory)}.final.json`); const { writeJson } = await import('../utils/fs.js'); await writeJson(archive, record); await rm(directory, { recursive: true, force: true }); }
