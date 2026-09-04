import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { GateCoordinator } from '../../src/runtime/gates.js';
import { RepairCoordinator, type ReviewFindingInput } from '../../src/runtime/repair.js';
import { V2GitOperator } from '../../src/git/operator.js';
import { gitBaseline } from '../../src/git/operator.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { startV2Run, runV2Lifecycle, cancelV2Run, projectV2Run, cleanupV2Run } from '../../src/runtime/runner.js';
import { loadV2Run } from '../../src/runtime/store.js';
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
    await operator.createPlanWorktree({ baseBranch: 'main', expectedHead: initial });
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
    await operator.createPlanWorktree({ baseBranch: 'main', expectedHead: initial });
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
    await operator.createPlanWorktree({ baseBranch: 'main', expectedHead: initial });
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

  it('runs the complete v2 task, gate, and integration lifecycle in a temporary Git repository', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-complete';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'commit-and-merge' as const, required_actions: ['task-001-test'], depends_on: [] }],
      actions: [{ action_id: 'task-001-test', task_id: 'task-001', operation: 'test', write_scope: ['output.txt'] }],
    };

    const baseline = (await gitBaseline(project)).head!;
    const result = await runV2Lifecycle({ project, runId, manifest, execute: async ({ cwd }) => { await writeFile(join(cwd, 'output.txt'), 'runner lifecycle\n'); return { status: 'done', tests: [{ command: 'pnpm test', status: 'passed' }], changedPaths: ['output.txt'] }; }, gateEvidence: { planValidation: { valid: true, errors: [] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: true, noFastForward: true } } });
    expect(result.run_state).toBe('complete');
    expect(result.integration?.observed).toBe(true);
    expect(result.gates.integration?.state).toBe('passed');
    expect(result.trace).toEqual(expect.arrayContaining(['task-task-001:committed', 'gate:integration:passed', 'run:complete']));
    expect(await readFile(join(project, 'output.txt'), 'utf8')).toContain('runner lifecycle');
  });

  it('keeps the lifecycle paused when host-owned gate evidence is missing', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-missing-evidence';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'read-only-finalize' as const, required_actions: ['task-001-test'], depends_on: [] }],
      actions: [{ action_id: 'task-001-test', task_id: 'task-001', operation: 'test', write_scope: [] }],
    };

    const baseline = (await gitBaseline(project)).head!;
    const result = await runV2Lifecycle({ project, runId, manifest, execute: async () => ({ status: 'done', tests: [{ command: 'pnpm test', status: 'passed' }], changedPaths: [] }), gateEvidence: { planValidation: { valid: false, errors: ['host validation evidence missing'] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: false, noFastForward: false } } });

    expect(result.run_state).toBe('paused');
    expect(result.integration).toBeUndefined();
    expect(result.gates['standards-review']).toBeUndefined();
    await expect(loadV2Run(project, runId)).resolves.toMatchObject({ run_state: 'paused', stop_reason: 'blocked' });
  });

  it('does not invent baseline or integration evidence when lifecycle authority is incomplete', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-missing-integration-evidence';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'read-only-finalize' as const, required_actions: ['task-001-test'], depends_on: [] }],
      actions: [{ action_id: 'task-001-test', task_id: 'task-001', operation: 'test', write_scope: [] }],
    };
    const initial = (await gitBaseline(project)).head!;

    const result = await runV2Lifecycle({ project, runId, manifest, execute: async () => ({ status: 'done', tests: [{ command: 'pnpm test', status: 'passed' }], changedPaths: [] }), gateEvidence: { planValidation: { valid: true, errors: [] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: initial, current: initial }, integration: { observed: false, noFastForward: false } } });

    expect(result.run_state).toBe('paused');
    expect(result.integration).toBeUndefined();
    expect(result.gates['baseline-stable']?.state).toBe('passed');
    expect((await gitBaseline(project)).head).toBe(initial);
    await expect(loadV2Run(project, runId)).resolves.toMatchObject({ run_state: 'paused', stop_reason: 'blocked' });
  });

  it('executes the approved lifecycle script through the Worker engine', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-script-engine';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [],
      actions: [],
    };
    const baseline = (await gitBaseline(project)).head!;

    const result = await runV2Lifecycle({
      project,
      runId,
      manifest,
      script: "phase('script-phase'); log('script-log'); return { executed: true };",
      execute: async () => { throw new Error('direct execute callback must not be used'); },
      gateEvidence: { planValidation: { valid: true, errors: [] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: false, noFastForward: false } },
    });

    expect(result.run_state).toBe('paused');
    expect(result.trace).toEqual(expect.arrayContaining(['phase:script-phase', 'log:script-log']));
  });

  it('does not bypass the lifecycle Worker with a direct execute callback', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-no-direct-execute';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'read-only-finalize' as const, required_actions: ['task-001-test'], depends_on: [] }],
      actions: [{ action_id: 'task-001-test', task_id: 'task-001', operation: 'test', write_scope: [] }],
    };
    const baseline = (await gitBaseline(project)).head!;

    const result = await runV2Lifecycle({
      project,
      runId,
      manifest,
      script: "phase('worker-only'); return { executed: true };",
      execute: async () => { throw new Error('direct execute callback must not be used'); },
      gateEvidence: { planValidation: { valid: true, errors: [] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: false, noFastForward: false } },
    });

    expect(result.run_state).toBe('paused');
    expect(result.trace).toEqual(expect.arrayContaining(['phase:worker-only']));
  });

  it('runs the generated lifecycle script when no custom script is supplied', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-generated-script';
    const manifest = { manifest_digest: digest, target_branch: 'main', tasks: [], actions: [] };
    const baseline = (await gitBaseline(project)).head!;

    const result = await runV2Lifecycle({
      project,
      runId,
      manifest,
      execute: async () => { throw new Error('generated script has no action'); },
      gateEvidence: { planValidation: { valid: false, errors: ['no task closure'] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: false, noFastForward: false } },
    });

    expect(result.run_state).toBe('paused');
    expect(result.trace).toEqual(expect.arrayContaining(['phase:generated-lifecycle']));
  });

  it('routes approved lifecycle script actions through host execution and task closure', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-script-action-closure';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'commit-and-merge' as const, required_actions: ['task-001-test'], depends_on: [] }],
      actions: [{ action_id: 'task-001-test', task_id: 'task-001', operation: 'test', write_scope: ['output.txt'] }],
    };
    const baseline = (await gitBaseline(project)).head!;

    const result = await runV2Lifecycle({
      project,
      runId,
      manifest,
      script: 'await agent("test", { actionId: "task-001-test", callId: "script/test" });',
      execute: async ({ cwd }) => { await writeFile(join(cwd, 'output.txt'), 'script action\n'); return { status: 'done', tests: [{ command: 'pnpm test', status: 'passed' }], changedPaths: ['output.txt'] }; },
      gateEvidence: { planValidation: { valid: true, errors: [] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: true, noFastForward: true } },
    });

    expect(result.run_state).toBe('complete');
    expect(result.gates.integration?.state).toBe('passed');
    await expect(readFile(join(project, 'output.txt'), 'utf8')).resolves.toBe('script action\n');
  });

  it('acquires a durable owner lease before lifecycle actions execute', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-owner-lease';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'read-only-finalize' as const, required_actions: ['task-001-test'], depends_on: [] }],
      actions: [{ action_id: 'task-001-test', task_id: 'task-001', operation: 'test', write_scope: [] }],
    };
    const baseline = (await gitBaseline(project)).head!;

    const result = await runV2Lifecycle({
      project,
      runId,
      manifest,
      execute: async () => {
        const owner = JSON.parse(await readFile(join(project, '.ai-workflow/runs', runId, 'control', 'owner.json'), 'utf8')) as { runId?: string; status?: string };
        expect(owner).toMatchObject({ runId, status: 'active' });
        return { status: 'done', tests: [{ command: 'pnpm test', status: 'passed' }], changedPaths: [] };
      },
      gateEvidence: { planValidation: { valid: true, errors: [] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: false, noFastForward: false } },
    });

    expect(result.run_state).toBe('paused');
    await expect(readFile(join(project, '.ai-workflow/runs', runId, 'control', 'owner.json'), 'utf8')).resolves.toMatch(/"status":"active"/);
  });

  it('cancels a deferred v2 run and reconciles its durable projection without deleting resources', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-cancel';
    await startV2Run({ project, runId, manifestDigest: digest, fencingEpoch: 1 });
    const cancelled = await cancelV2Run(project, runId);
    expect(cancelled.run_state).toBe('cancelled');
    const projected = await projectV2Run(project, runId);
    expect(projected.run_state).toBe('cancelled');
    expect(await readFile(join(project, '.ai-workflow/runs', runId, 'events.jsonl'), 'utf8')).toContain('run/cancelled');
  });

  it('cleans a completed v2 run only through its owned resource receipts', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-cleanup';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'commit-and-merge' as const, required_actions: ['task-001-test'], depends_on: [] }],
      actions: [{ action_id: 'task-001-test', task_id: 'task-001', operation: 'test', write_scope: ['output.txt'] }],
    };
    const baseline = (await gitBaseline(project)).head!;
    const result = await runV2Lifecycle({ project, runId, manifest, execute: async ({ cwd }) => { await writeFile(join(cwd, 'output.txt'), 'cleanup\n'); return { status: 'done', tests: [{ command: 'pnpm test', status: 'passed' }], changedPaths: ['output.txt'] }; }, gateEvidence: { planValidation: { valid: true, errors: [] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: true, noFastForward: true } } });
    expect(result.run_state).toBe('complete');
    const cleaned = await cleanupV2Run(project, runId);
    expect(cleaned.run_state).toBe('complete');
    expect(await readFile(join(project, 'output.txt'), 'utf8')).toBe('cleanup\n');
  });
});
