import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { V2GitOperator, type GitResourceReceipt } from '../../src/git/operator.js';
import { git, gitBaseline } from '../../src/git/operator.js';
import { gitInit, temporary } from '../helpers.js';
import { RunLedger } from '../../src/runtime/ledger.js';
import { TaskClosureCoordinator, type TaskActionObservation } from '../../src/workflow/approval.js';

const manifestDigest = `sha256:${'a'.repeat(64)}`;
const execFile = promisify(execFileCallback);

describe('v2 Git lifecycle', () => {
  it('creates fixed owned resources and commits with an ownership trailer', async () => {
    const project = await temporary();
    await gitInit(project);
    const initial = (await gitBaseline(project)).head!;
    const operator = new V2GitOperator({ project, runId: 'run-v2', manifestDigest, fencingEpoch: 1 });

    const plan = await operator.createPlanWorktree({ baseBranch: 'main', expectedHead: initial });
    const task = await operator.createTaskWorktree(plan, 'task-001-example');
    expect(task.path).toBe(join(project, '.ai-workflow/runs/run-v2/worktrees/tasks/task-001-example'));
    expect(task.branch).toBe('ai-workflow/v2/run-v2/task-task-001-example');

    await writeFile(join(task.path, 'output.txt'), 'v2\n');
    const commit = await operator.commitTask(task, 'task-001-example', ['output.txt']);
    expect(await git(task.path, ['show', '-s', '--format=%B', commit.commit])).toContain('AI-Workflow-Resource:');
    await operator.mergeTask(plan, commit.commit);
    await operator.integratePlan(plan, { targetBranch: 'main', expectedHead: initial });

    const receipts = operator.resources;
    expect(receipts.some((resource) => resource.kind === 'plan-worktree' && resource.canonical_path === '.ai-workflow/runs/run-v2/worktrees/plan')).toBe(true);
    expect(receipts.some((resource) => resource.kind === 'task-worktree' && resource.canonical_path === '.ai-workflow/runs/run-v2/worktrees/tasks/task-001-example')).toBe(true);
    expect(receipts.find((resource) => resource.kind === 'task-worktree')?.committed).toBe(true);
    const taskReceipt = receipts.find((resource) => resource.kind === 'task-worktree')!;
    const persisted = JSON.parse(await readFile(join(project, '.ai-workflow/runs/run-v2/receipts/resource', `${taskReceipt.resource_id}.json`), 'utf8')) as GitResourceReceipt;
    expect(persisted.creation_transaction_id).toContain('tx-');
    expect(await readFile(join(project, 'output.txt'), 'utf8')).toBe('v2\n');
  });

  it('refuses to force-remove an owned resource that is dirty', async () => {
    const project = await temporary();
    await gitInit(project);
    const operator = new V2GitOperator({ project, runId: 'run-dirty', manifestDigest, fencingEpoch: 1 });
    const plan = await operator.createPlanWorktree({ baseBranch: 'main' });
    await writeFile(join(plan.path, 'dirty.txt'), 'do not remove\n');

    await expect(operator.cleanup()).rejects.toThrow(/dirty/);
    expect(await readFile(join(plan.path, 'dirty.txt'), 'utf8')).toContain('do not remove');
  });

  it('serializes two runs through the project Git mutex', async () => {
    const project = await temporary();
    await gitInit(project);
    const first = new V2GitOperator({ project, runId: 'run-one', manifestDigest, fencingEpoch: 1 });
    const second = new V2GitOperator({ project, runId: 'run-two', manifestDigest, fencingEpoch: 1 });

    const [one, two] = await Promise.all([
      first.createPlanWorktree({ baseBranch: 'main' }),
      second.createPlanWorktree({ baseBranch: 'main' }),
    ]);
    expect(one.branch).toBe('ai-workflow/v2/run-one/plan');
    expect(two.branch).toBe('ai-workflow/v2/run-two/plan');
    expect((await git(project, ['worktree', 'list', '--porcelain'])).match(/ai-workflow\/v2\/run-(one|two)\/plan/g)?.length).toBe(2);
  });

  it('rejects a stale expected baseline before creating a resource', async () => {
    const project = await temporary();
    await gitInit(project);
    const operator = new V2GitOperator({ project, runId: 'run-stale', manifestDigest, fencingEpoch: 1 });

    await expect(operator.createPlanWorktree({ baseBranch: 'main', expectedHead: '0'.repeat(40) })).rejects.toMatchObject({ code: 'BASELINE_DRIFT' });
  });

  it('refuses integration when the target branch drifts after approval', async () => {
    const project = await temporary();
    await gitInit(project);
    const initial = (await gitBaseline(project)).head!;
    const operator = new V2GitOperator({ project, runId: 'run-integration-drift', manifestDigest, fencingEpoch: 1 });
    const plan = await operator.createPlanWorktree({ baseBranch: 'main', expectedHead: initial });

    await execFile('git', ['commit', '--allow-empty', '-m', 'external change'], { cwd: project, env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' } });
    await expect(operator.integratePlan(plan, { targetBranch: 'main', expectedHead: initial })).rejects.toMatchObject({ code: 'BASELINE_DRIFT' });
  });

  it('dry-runs and rejects a conflicting task merge', async () => {
    const project = await temporary();
    await gitInit(project);
    const operator = new V2GitOperator({ project, runId: 'run-conflict', manifestDigest, fencingEpoch: 1 });
    const plan = await operator.createPlanWorktree({ baseBranch: 'main' });
    const first = await operator.createTaskWorktree(plan, 'task-first');
    const second = await operator.createTaskWorktree(plan, 'task-second');
    await writeFile(join(first.path, 'README.md'), 'first\n');
    await writeFile(join(second.path, 'README.md'), 'second\n');

    const firstCommit = await operator.commitTask(first, 'task-first', ['README.md']);
    const secondCommit = await operator.commitTask(second, 'task-second', ['README.md']);
    await operator.mergeTask(plan, firstCommit.commit);
    const dryRun = await operator.dryRunMerge(plan, secondCommit.commit);
    expect(dryRun.clean).toBe(false);
    await expect(operator.mergeTask(plan, secondCommit.commit)).rejects.toMatchObject({ code: 'MERGE_CONFLICT' });
  });

  it('reconciles receipts after a new operator observes a crash boundary', async () => {
    const project = await temporary();
    await gitInit(project);
    const original = new V2GitOperator({ project, runId: 'run-reconcile', manifestDigest, fencingEpoch: 1 });
    await original.createPlanWorktree({ baseBranch: 'main' });
    const recovered = new V2GitOperator({ project, runId: 'run-reconcile', manifestDigest, fencingEpoch: 1 });

    const result = await recovered.reconcile();
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ resource_id: 'resource-plan-worktree-run-reconcile', state: 'observed' })]));
  });

  it('rejects a tampered receipt during reconciliation and cleanup', async () => {
    const project = await temporary();
    await gitInit(project);
    const original = new V2GitOperator({ project, runId: 'run-tamper', manifestDigest, fencingEpoch: 1 });
    const plan = await original.createPlanWorktree({ baseBranch: 'main' });
    const receiptPath = join(project, '.ai-workflow/runs/run-tamper/receipts/resource', `${plan.resource.resource_id}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as GitResourceReceipt;
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, branch: 'other/branch' })}\n`);
    const recovered = new V2GitOperator({ project, runId: 'run-tamper', manifestDigest, fencingEpoch: 1 });

    await expect(recovered.reconcile()).rejects.toMatchObject({ code: 'RESOURCE_TAMPERED' });
    await expect(recovered.cleanup()).rejects.toMatchObject({ code: 'RESOURCE_TAMPERED' });
  });

  it('does not finalize a task when a required action is missing', async () => {
    const project = await temporary();
    await gitInit(project);
    const ledger = new RunLedger({ directory: join(project, '.ai-workflow/runs/closure-missing'), runId: 'closure-missing', fencingEpoch: 1 });
    const coordinator = new TaskClosureCoordinator({ ledger });
    const actions: TaskActionObservation[] = [{ action_id: 'task-001-explore', state: 'observed', result: { status: 'done', tests: [] } }];

    await expect(coordinator.finalizeTask({ taskId: 'task-001-example', controlId: 'finalize-missing', controlOrdinal: 1, activation: 'required', requiredActionIds: ['task-001-explore', 'task-001-test'], actions, predecessorStates: {} })).rejects.toMatchObject({ code: 'TASK_CLOSURE_INCOMPLETE' });
  });

  it('finalizes a read-only task only after successful actions and test evidence', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'closure-read-only';
    const ledger = new RunLedger({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: 1 });
    const coordinator = new TaskClosureCoordinator({ ledger });
    const actions: TaskActionObservation[] = [
      { action_id: 'task-001-explore', state: 'observed', result: { status: 'done', tests: [] } },
      { action_id: 'task-001-test', state: 'checkpointed', result: { status: 'done', tests: [{ command: 'pnpm test', status: 'passed' }] } },
    ];

    const receipt = await coordinator.finalizeTask({ taskId: 'task-001-example', controlId: 'finalize-read-only', controlOrdinal: 1, activation: 'required', requiredActionIds: actions.map((action) => action.action_id), actions, predecessorStates: {}, finalizationMode: 'read-only-finalize' });
    expect(receipt.state).toBe('finalized');
    expect(receipt.commit).toBeUndefined();
    expect((await ledger.replayControl('finalize-read-only') as { state: string }).state).toBe('finalized');
  });

  it('requires remediation and terminal predecessors before finalization', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'closure-boundaries';
    const ledger = new RunLedger({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: 1 });
    const coordinator = new TaskClosureCoordinator({ ledger });
    const failed: TaskActionObservation[] = [{ action_id: 'task-002-test', state: 'failed', result: { status: 'failed' } }];

    await expect(coordinator.finalizeTask({ taskId: 'task-002', controlId: 'finalize-failed', controlOrdinal: 1, activation: 'required', requiredActionIds: ['task-002-test'], actions: failed, predecessorStates: { 'task-001': 'finalized' }, finalizationMode: 'read-only-finalize' })).rejects.toMatchObject({ code: 'TASK_CLOSURE_INCOMPLETE' });
    await expect(coordinator.finalizeTask({ taskId: 'task-002', controlId: 'finalize-predecessor', controlOrdinal: 2, activation: 'required', requiredActionIds: ['task-002-test'], actions: [{ ...failed[0]!, remediated: true, state: 'observed', result: { status: 'done', tests: [{ command: 'pnpm test', status: 'passed' }] } }], predecessorStates: { 'task-001': 'pending' }, finalizationMode: 'read-only-finalize' })).rejects.toMatchObject({ code: 'TASK_PREDECESSOR_INCOMPLETE' });
  });

  it('finalizes a dependent task only after its predecessor closure is terminal', async () => {
    const project = await temporary();
    await gitInit(project);
    const ledger = new RunLedger({ directory: join(project, '.ai-workflow/runs/closure-dependencies'), runId: 'closure-dependencies', fencingEpoch: 1 });
    const coordinator = new TaskClosureCoordinator({ ledger });
    const action = { action_id: 'task-002-test', state: 'checkpointed' as const, result: { status: 'done' as const, tests: [] } };

    await expect(coordinator.finalizeTask({ taskId: 'task-002', controlId: 'finalize-dependent-pending', controlOrdinal: 1, activation: 'required', requiredActionIds: [action.action_id], actions: [action], predecessorStates: { 'task-001': 'pending' }, finalizationMode: 'read-only-finalize' })).rejects.toMatchObject({ code: 'TASK_PREDECESSOR_INCOMPLETE' });
    await expect(coordinator.finalizeTask({ taskId: 'task-002', controlId: 'finalize-dependent-ready', controlOrdinal: 2, activation: 'required', requiredActionIds: [action.action_id], actions: [action], predecessorStates: { 'task-001': 'finalized' }, finalizationMode: 'read-only-finalize' })).resolves.toMatchObject({ state: 'finalized' });
  });

  it('skips a conditional task only with an explicit control reason', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'closure-conditional';
    const ledger = new RunLedger({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: 1 });
    const coordinator = new TaskClosureCoordinator({ ledger });

    await expect(coordinator.skipTask({ taskId: 'task-optional', controlId: 'skip-empty', controlOrdinal: 1, activation: 'conditional', requiredActionIds: [], actions: [], predecessorStates: {}, reason: '   ' })).rejects.toMatchObject({ code: 'TASK_SKIP_REASON_REQUIRED' });
    const receipt = await coordinator.skipTask({ taskId: 'task-optional', controlId: 'skip-with-reason', controlOrdinal: 2, activation: 'conditional', requiredActionIds: [], actions: [], predecessorStates: {}, reason: 'Feature is not activated by this plan' });
    expect(receipt.state).toBe('skipped');
    expect((await ledger.replayControl('skip-with-reason') as { state: string }).state).toBe('skipped');
  });

  it('commits and merges a write task only through task finalization', async () => {
    const project = await temporary();
    await gitInit(project);
    const initial = (await gitBaseline(project)).head!;
    const runId = 'closure-write';
    const operator = new V2GitOperator({ project, runId, manifestDigest, fencingEpoch: 1 });
    const plan = await operator.createPlanWorktree({ baseBranch: 'main', expectedHead: initial });
    const task = await operator.createTaskWorktree(plan, 'task-write');
    await writeFile(join(task.path, 'output.txt'), 'committed by coordinator\n');
    const ledger = new RunLedger({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: 1 });
    const coordinator = new TaskClosureCoordinator({ ledger });
    const receipt = await coordinator.finalizeTask({ taskId: 'task-write', controlId: 'finalize-write', controlOrdinal: 1, activation: 'required', requiredActionIds: ['task-write-test'], actions: [{ action_id: 'task-write-test', state: 'checkpointed', result: { status: 'done', tests: [{ command: 'pnpm test', status: 'passed' }] } }], predecessorStates: {}, finalizationMode: 'commit-and-merge', taskWorktree: task, planWorktree: plan, writeScope: ['output.txt'], operator });

    expect(receipt.state).toBe('committed');
    expect(receipt.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(plan.path, 'output.txt'), 'utf8')).toContain('coordinator');
  });

  it('does not repeat Git side effects when a finalize control reply is lost', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'closure-lost-reply';
    const ledger = new RunLedger({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: 1 });
    const coordinator = new TaskClosureCoordinator({ ledger });
    const input = { taskId: 'task-lost', controlId: 'finalize-lost', controlOrdinal: 1, activation: 'required' as const, requiredActionIds: ['task-lost-test'], actions: [{ action_id: 'task-lost-test', state: 'checkpointed' as const, result: { status: 'done' as const, tests: [{ command: 'pnpm test', status: 'passed' as const }] } }], predecessorStates: {}, finalizationMode: 'read-only-finalize' as const };
    await ledger.prepareControl({ controlId: input.controlId, controlOrdinal: input.controlOrdinal, descriptor: { operation: 'finalize-task', task_id: input.taskId, mode: input.finalizationMode, required_action_ids: input.requiredActionIds } });
    await ledger.intentControl(input.controlId);

    await expect(coordinator.finalizeTask(input)).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
    expect((await ledger.replayControlOrder()).find((control) => control.control_id === input.controlId)?.state).toBe('intent');
  });
});
