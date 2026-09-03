import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { GateCoordinator } from '../../src/runtime/gates.js';
import { RepairCoordinator, type ReviewFindingInput } from '../../src/runtime/repair.js';
import { V2GitOperator } from '../../src/git/operator.js';
import { gitBaseline } from '../../src/git/operator.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { gitInit, temporary } from '../helpers.js';

const digest = `sha256:${'b'.repeat(64)}`;

describe('v2 mandatory gates', () => {
  it('does not validate or integrate before host task closure', async () => {
    const project = await temporary();
    await gitInit(project);
    const coordinator = new GateCoordinator({ directory: join(project, '.ai-workflow/runs/gates-missing'), runId: 'gates-missing', fencingEpoch: 1, manifestDigest: digest });

    await expect(coordinator.runGate('plan-validation', { taskClosure: {} })).rejects.toMatchObject({ code: 'GATE_DEPENDENCY_BLOCKED' });
    await expect(coordinator.runGate('integration', { taskClosure: {}, integration: { observed: true, noFastForward: true } })).rejects.toMatchObject({ code: 'GATE_DEPENDENCY_BLOCKED' });
  });

  it('writes only host-owned gate receipts after predicates pass', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'gates-pass';
    const coordinator = new GateCoordinator({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: 1, manifestDigest: digest });

    const closure = await coordinator.runGate('task-closure', { taskClosure: { 'task-001': { state: 'committed' }, 'task-002': { state: 'skipped' } } });
    expect(closure.state).toBe('passed');
    const validation = await coordinator.runGate('plan-validation', { planValidation: { valid: true, errors: [] } });
    expect(validation.state).toBe('passed');
    await coordinator.runGate('standards-review', { review: { findings: [] } });
    await coordinator.runGate('spec-review', { review: { findings: [] } });
    await coordinator.runGate('repair-closure', { repairClosure: { closedFindingIds: [] } });
    await coordinator.runGate('baseline-stable', { baseline: { expected: digest, current: digest } });
    const integration = await coordinator.runGate('integration', { integration: { observed: true, noFastForward: true, mergeCommit: 'merge-001' } });

    expect(integration.state).toBe('passed');
    expect(await readFile(join(project, '.ai-workflow/runs', runId, 'receipts/gate/integration.json'), 'utf8')).toContain('passed');
  });

  it('rejects script gate writes and records failed host predicates', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'gates-failures';
    const coordinator = new GateCoordinator({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: 1, manifestDigest: digest });

    expect(() => coordinator.recordScriptGateState('integration', 'passed')).toThrow(/host gate coordinator/);
    await coordinator.runGate('task-closure', { taskClosure: { 'task-001': { state: 'finalized' } } });
    const validation = await coordinator.runGate('plan-validation', { planValidation: { valid: false, errors: ['missing acceptance evidence'] } });
    expect(validation.state).toBe('failed');
    await expect(coordinator.runGate('standards-review', { review: { findings: [] } })).rejects.toMatchObject({ code: 'GATE_DEPENDENCY_BLOCKED' });
  });

  it('blocks review failures and baseline drift from integration', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'gates-drift';
    const coordinator = new GateCoordinator({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: 1, manifestDigest: digest });

    await coordinator.runGate('task-closure', { taskClosure: { 'task-001': { state: 'committed' } } });
    await coordinator.runGate('plan-validation', { planValidation: { valid: true, errors: [] } });
    const review = await coordinator.runGate('standards-review', { review: { findings: [{ severity: 'error', finding_id: 'finding-1' }] } });
    expect(review.state).toBe('failed');
    await expect(coordinator.runGate('baseline-stable', { baseline: { expected: 'head-a', current: 'head-b' } })).rejects.toMatchObject({ code: 'GATE_DEPENDENCY_BLOCKED' });
  });

  it('does not pass integration without an observed no-ff merge', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'gates-no-ff';
    const coordinator = new GateCoordinator({ directory: join(project, '.ai-workflow/runs', runId), runId, fencingEpoch: 1, manifestDigest: digest });

    await coordinator.runGate('task-closure', { taskClosure: { 'task-001': { state: 'committed' } } });
    await coordinator.runGate('plan-validation', { planValidation: { valid: true, errors: [] } });
    await coordinator.runGate('standards-review', { review: { findings: [] } });
    await coordinator.runGate('spec-review', { review: { findings: [] } });
    await coordinator.runGate('repair-closure', { repairClosure: { closedFindingIds: [] } });
    await coordinator.runGate('baseline-stable', { baseline: { expected: 'head-a', current: 'head-a' } });
    const integration = await coordinator.runGate('integration', { integration: { observed: true, noFastForward: false, mergeCommit: 'merge-ff' } });
    expect(integration.state).toBe('failed');
  });

  it('normalizes findings, repairs once, and closes every finding with targeted rechecks', async () => {
    const project = await temporary();
    await gitInit(project);
    const initial = (await gitBaseline(project)).head!;
    const runId = 'repair-once';
    const operator = new V2GitOperator({ project, runId, manifestDigest: digest, fencingEpoch: 1 });
    const plan = await operator.createPlanWorktree({ baseBranch: 'main', expectedHead: initial });
    const repair = new RepairCoordinator({ project, runId, manifestDigest: digest, fencingEpoch: 1, operator });
    const findings: ReviewFindingInput[] = [{ sourceGate: 'standards-review', severity: 'error', message: 'missing validation', path: 'src/output.ts', applicableActionIds: ['task-001-test'] }];

    const started = await repair.startRepair(findings);
    expect(started.findings[0]?.finding_id).toMatch(/^finding-sha256:/);
    expect(started.worktree.path).toContain(`/worktrees/repair`);
    await mkdir(join(started.worktree.path, 'src'), { recursive: true });
    await writeFile(join(started.worktree.path, 'src/output.ts'), 'repaired\n');
    const completed = await repair.completeRepair(started, ['src/output.ts']);
    expect(completed.planHead).not.toBe(initial);
    const test = await repair.createRepairTest('task-001', completed.planHead);
    expect(test.worktree.path).toContain(`/worktrees/repair-tests/task-001`);
    expect(test.worktree.path).not.toBe(join(project, '.ai-workflow/runs', runId, 'worktrees', 'repair'));
    expect(await repair.recheckFinding(started.findings[0]!.finding_id, { state: 'closed', evidence: ['src/output.ts'] })).toMatchObject({ state: 'closed' });
    expect((await repair.status()).state).toBe('closed');
  });

  it('rejects a second repair and keeps the review gate blocked until all findings close', async () => {
    const project = await temporary();
    await gitInit(project);
    const initial = (await gitBaseline(project)).head!;
    const runId = 'repair-budget';
    const operator = new V2GitOperator({ project, runId, manifestDigest: digest, fencingEpoch: 1 });
    const plan = await operator.createPlanWorktree({ baseBranch: 'main', expectedHead: initial });
    const repair = new RepairCoordinator({ project, runId, manifestDigest: digest, fencingEpoch: 1, operator });
    const started = await repair.startRepair([
      { sourceGate: 'standards-review', severity: 'error', message: 'one', applicableActionIds: ['a'] },
      { sourceGate: 'spec-review', severity: 'error', message: 'two', applicableActionIds: ['b'] },
    ]);
    await expect(repair.startRepair(started.findings)).rejects.toMatchObject({ code: 'REPAIR_BUDGET_EXHAUSTED' });
    await expect(repair.recheckFinding(started.findings[0]!.finding_id, { state: 'open', evidence: [] })).rejects.toMatchObject({ code: 'FINDING_RECHECK_OPEN' });
    expect((await repair.status()).state).toBe('paused');
  });

  it('replays completed repair state and preserves the observed repaired plan HEAD', async () => {
    const project = await temporary();
    await gitInit(project);
    const initial = (await gitBaseline(project)).head!;
    const runId = 'repair-replay';
    const operator = new V2GitOperator({ project, runId, manifestDigest: digest, fencingEpoch: 1 });
    const plan = await operator.createPlanWorktree({ baseBranch: 'main', expectedHead: initial });
    const repair = new RepairCoordinator({ project, runId, manifestDigest: digest, fencingEpoch: 1, operator });
    const started = await repair.startRepair([{ sourceGate: 'standards-review', severity: 'error', message: 'replay me', path: 'output.txt', applicableActionIds: ['task-001-test'] }]);
    await writeFile(join(started.worktree.path, 'output.txt'), 'replayed repair\n');
    const completed = await repair.completeRepair(started, ['output.txt']);

    const recovered = new RepairCoordinator({ project, runId, manifestDigest: digest, fencingEpoch: 1, operator: new V2GitOperator({ project, runId, manifestDigest: digest, fencingEpoch: 1 }) });
    expect((await recovered.status()).state).toBe('awaiting-rechecks');
    const repairTest = await recovered.createRepairTest('task-001', completed.planHead);
    expect(repairTest.base_head).toBe(completed.planHead);
    await recovered.recheckFinding(started.findings[0]!.finding_id, { state: 'closed', evidence: ['output.txt'] });
    expect((await recovered.status()).state).toBe('closed');
  });
});
