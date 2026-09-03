import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { GateCoordinator } from '../../src/runtime/gates.js';
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
});
