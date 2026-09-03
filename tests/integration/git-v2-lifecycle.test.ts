import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { V2GitOperator, type GitResourceReceipt } from '../../src/git/operator.js';
import { git, gitBaseline } from '../../src/git/operator.js';
import { gitInit, temporary } from '../helpers.js';

const manifestDigest = `sha256:${'a'.repeat(64)}`;

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
});
