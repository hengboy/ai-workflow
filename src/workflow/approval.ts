import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ApprovalReceipt } from '../generated/receipt.schema.js';
import type { Workflow } from './types.js';
import { objectDigest } from '../utils/hash.js';
import { writeJson, readJson, exists } from '../utils/fs.js';
import { gitBaseline } from '../git/operator.js';
import { relative } from 'node:path';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';
import { RunLedger, type ControlLedgerEntry } from '../runtime/ledger.js';
import { V2GitOperator, type GitCommitReceipt, type V2Worktree } from '../git/operator.js';

export function receiptPath(workflowPath: string): string { return join(dirname(workflowPath), 'approval.receipt.json'); }
async function baselineDigest(project: string, receipt: string): Promise<string> {
  const baseline = await gitBaseline(project); const ignored = relative(project, receipt).replaceAll('\\', '/');
  const status = baseline.status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter((entry) => entry !== ignored && !entry.startsWith('ai-workflow/') && !entry.startsWith('.ai-workflow/')).sort();
  return objectDigest({ branch: baseline.branch, head: baseline.head, status });
}
export async function approveWorkflow(workflowPath: string, project = process.cwd()): Promise<ApprovalReceipt> {
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8')) as Workflow;
  const receipt: ApprovalReceipt = { receipt_version: '1.0.0', workflow_digest: objectDigest(workflow), baseline_digest: await baselineDigest(project, receiptPath(workflowPath)), plan_id: workflow.plan_id, host: workflow.host, approved_at: new Date().toISOString() };
  const validate = await schemaValidator('receipt.schema.json'); if (!validate(receipt)) throw new Error(formatSchemaErrors(validate.errors));
  await writeJson(receiptPath(workflowPath), receipt); return receipt;
}
export async function verifyApproval(workflowPath: string, workflow: Workflow, project = process.cwd()): Promise<ApprovalReceipt> {
  const path = receiptPath(workflowPath); if (!(await exists(path))) throw new Error('Missing approval receipt'); const receipt = await readJson<ApprovalReceipt>(path);
  const validate = await schemaValidator('receipt.schema.json'); if (!validate(receipt)) throw new Error(`Invalid approval receipt: ${formatSchemaErrors(validate.errors)}`);
  if (receipt.workflow_digest !== objectDigest(workflow) || receipt.plan_id !== workflow.plan_id || receipt.host !== workflow.host) throw new Error('Approval receipt does not match workflow'); if (receipt.baseline_digest !== await baselineDigest(project, path)) throw new Error('Approval baseline changed'); return receipt;
}

export type TaskActionState = 'observed' | 'checkpointed' | 'reconciled' | 'failed' | 'blocked' | 'cancelled' | 'skipped';

export interface TaskActionObservation {
  action_id: string;
  state: TaskActionState;
  result?: { status?: 'done' | 'blocked' | 'failed'; tests?: Array<{ command: string; status: 'passed' | 'failed' | 'skipped' }> };
  remediated?: boolean;
}

export interface TaskFinalizeInput {
  taskId: string;
  controlId: string;
  controlOrdinal: number;
  activation: 'required' | 'conditional';
  requiredActionIds: string[];
  actions: TaskActionObservation[];
  predecessorStates: Record<string, 'pending' | 'running' | 'finalized' | 'committed' | 'skipped'>;
  finalizationMode?: 'read-only-finalize' | 'commit-and-merge';
  taskWorktree?: V2Worktree;
  planWorktree?: V2Worktree;
  writeScope?: string[];
  operator?: V2GitOperator;
}

export interface TaskClosureReceipt {
  task_id: string;
  state: 'finalized' | 'committed' | 'skipped';
  control_id: string;
  required_action_ids: string[];
  predecessor_ids: string[];
  commit?: string;
  tree?: string;
  commit_receipt?: GitCommitReceipt;
}

export class TaskClosureError extends Error {
  readonly name = 'TaskClosureError';
  constructor(readonly code: 'TASK_CLOSURE_INCOMPLETE' | 'TASK_PREDECESSOR_INCOMPLETE' | 'TASK_COMMIT_UNAVAILABLE' | 'TASK_SKIP_REASON_REQUIRED', message: string) { super(message); }
}

const terminalActionStates = new Set<TaskActionState>(['observed', 'checkpointed', 'reconciled', 'failed', 'blocked', 'cancelled', 'skipped']);

function taskClosureFailure(input: TaskFinalizeInput): string | undefined {
  const actions = new Map(input.actions.map((action) => [action.action_id, action]));
  for (const actionId of input.requiredActionIds) {
    const action = actions.get(actionId);
    if (!action || !terminalActionStates.has(action.state)) return `required action is missing or unsettled: ${actionId}`;
    if (action.state !== 'failed' && action.state !== 'blocked' && action.state !== 'cancelled' && action.state !== 'skipped' && action.result?.status !== 'done') return `action did not complete successfully: ${actionId}`;
    if ((action.state === 'failed' || action.state === 'blocked' || action.state === 'cancelled') && !action.remediated) return `failed action was not remediated: ${actionId}`;
    if (action.result?.tests?.some((test) => test.status === 'failed')) return `required test failed: ${actionId}`;
  }
  for (const [taskId, state] of Object.entries(input.predecessorStates)) if (!['finalized', 'committed', 'skipped'].includes(state)) return `predecessor is not terminal: ${taskId}`;
  return undefined;
}

export class TaskClosureCoordinator {
  constructor(private readonly options: { ledger: RunLedger; eventLog?: RunLedger['eventLog'] }) {}

  async finalizeTask(input: TaskFinalizeInput): Promise<TaskClosureReceipt> {
    const failure = taskClosureFailure(input);
    if (failure) throw new TaskClosureError(failure.includes('predecessor') ? 'TASK_PREDECESSOR_INCOMPLETE' : 'TASK_CLOSURE_INCOMPLETE', failure);
    if (input.activation === 'conditional') throw new TaskClosureError('TASK_CLOSURE_INCOMPLETE', 'conditional task must be skipped with a control receipt');
    const mode = input.finalizationMode ?? (input.writeScope?.length ? 'commit-and-merge' : 'read-only-finalize');
    const descriptor = { operation: 'finalize-task' as const, task_id: input.taskId, mode, required_action_ids: [...input.requiredActionIds] };
    const result = await this.options.ledger.executeControl({ controlId: input.controlId, controlOrdinal: input.controlOrdinal, descriptor }, async () => {
      await this.options.ledger.eventLog.append({ type: 'task/finalize-intent', task_id: input.taskId, transaction_id: input.controlId, payload: { control_id: input.controlId, action_id: input.taskId, state: 'finalizing' } });
      if (mode === 'read-only-finalize') {
        const receipt: TaskClosureReceipt = { task_id: input.taskId, state: 'finalized', control_id: input.controlId, required_action_ids: [...input.requiredActionIds], predecessor_ids: Object.keys(input.predecessorStates) };
        await this.options.ledger.eventLog.append({ type: 'task/finalized', task_id: input.taskId, transaction_id: input.controlId, payload: { control_id: input.controlId, action_id: input.taskId, state: receipt.state, receipt_digest: objectDigest(receipt) } });
        return receipt;
      }
      if (!input.operator || !input.taskWorktree || !input.planWorktree || !input.writeScope?.length) throw new TaskClosureError('TASK_COMMIT_UNAVAILABLE', 'commit-and-merge requires operator, task worktree, plan worktree and write scope');
      const commit = await input.operator.commitTask(input.taskWorktree, input.taskId, input.writeScope);
      await input.operator.mergeTask(input.planWorktree, commit.commit);
      const receipt: TaskClosureReceipt = { task_id: input.taskId, state: 'committed', control_id: input.controlId, required_action_ids: [...input.requiredActionIds], predecessor_ids: Object.keys(input.predecessorStates), commit: commit.commit, tree: commit.tree, commit_receipt: commit };
      await this.options.ledger.eventLog.append({ type: 'task/committed', task_id: input.taskId, transaction_id: input.controlId, payload: { control_id: input.controlId, action_id: input.taskId, state: receipt.state, commit: commit.commit, tree: commit.tree, receipt_digest: objectDigest(receipt) } });
      return receipt;
    });
    return result as TaskClosureReceipt;
  }

  async skipTask(input: Omit<TaskFinalizeInput, 'finalizationMode' | 'operator' | 'taskWorktree' | 'planWorktree' | 'writeScope'> & { reason: string }): Promise<TaskClosureReceipt> {
    if (!input.reason.trim()) throw new TaskClosureError('TASK_SKIP_REASON_REQUIRED', 'conditional task skip requires a reason');
    if (input.activation !== 'conditional') throw new TaskClosureError('TASK_CLOSURE_INCOMPLETE', 'required tasks cannot be skipped');
    const descriptor = { operation: 'skip-task' as const, task_id: input.taskId, reason: input.reason };
    const result = await this.options.ledger.executeControl({ controlId: input.controlId, controlOrdinal: input.controlOrdinal, descriptor }, async () => {
      const receipt: TaskClosureReceipt = { task_id: input.taskId, state: 'skipped', control_id: input.controlId, required_action_ids: [], predecessor_ids: Object.keys(input.predecessorStates) };
      await this.options.ledger.eventLog.append({ type: 'task/skipped', task_id: input.taskId, transaction_id: input.controlId, payload: { control_id: input.controlId, action_id: input.taskId, state: receipt.state, reason: input.reason, receipt_digest: objectDigest(receipt) } });
      return receipt;
    });
    return result as TaskClosureReceipt;
  }

  async replayFinalize(controlId: string): Promise<ControlLedgerEntry> { return this.options.ledger.controls.get(controlId) ?? await this.options.ledger.replayControl(controlId).then(() => this.options.ledger.controls.get(controlId)!); }
}
