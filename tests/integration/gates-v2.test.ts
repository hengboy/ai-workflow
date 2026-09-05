import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { GateCoordinator } from '../../src/runtime/gates.js';
import { RepairCoordinator, type ReviewFindingInput } from '../../src/runtime/repair.js';
import { V2GitOperator } from '../../src/git/operator.js';
import { gitBaseline } from '../../src/git/operator.js';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startV2Run, runV2Script, runV2Lifecycle, cancelV2Run, projectV2Run, cleanupV2Run } from '../../src/runtime/runner.js';
import { loadV2Run } from '../../src/runtime/store.js';
import { frozenPlan, gitInit, temporary } from '../helpers.js';
import { generateManifest } from '../../src/workflow/generate.js';
import { parseMarkdown, renderMarkdown } from '../../src/utils/frontmatter.js';

const digest = `sha256:${'b'.repeat(64)}`;
const exec = promisify(execFile);

type HostBehavior = 'pass' | 'review-finding' | 'authority-invalid' | 'plan-invalid' | 'repair-test-failed' | 'conditional-skip';

const completeTaskScript = `await agent('explore', { actionId: 'task-001-example-explore', callId: 'call/explore' });
await agent('implement', { actionId: 'task-001-example-implement', callId: 'call/implement' });
await agent('test', { actionId: 'task-001-example-test', callId: 'call/test' });
await finalizeTask('task-001-example', 'control/finalize');`;

async function runWithHost(project: string, runId: string, script: string, behavior: HostBehavior = 'pass', withTasks = true): Promise<Awaited<ReturnType<typeof runV2Script>>> {
  const plan = await frozenPlan(project);
  if (withTasks) {
    const taskPath = join(plan, 'tasks/task-001-example.md');
    const task = parseMarkdown(await readFile(taskPath, 'utf8'));
    task.attributes.write_scope = behavior === 'review-finding' ? ['src/input.ts'] : [];
    await writeFile(taskPath, renderMarkdown(task.attributes, task.body));
  } else {
    await rm(join(plan, 'tasks'), { recursive: true, force: true });
  }
  await writeFile(join(plan, 'workflow.js'), script);
  const manifest = await generateManifest(plan, 'codex');
  if (behavior === 'conditional-skip') manifest.tasks[0]!.activation = 'conditional';
  const hostDirectory = await temporary('ai-workflow-gates-host-');
  const host = join(hostDirectory, 'codex');
  await writeFile(host, `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const input = readFileSync(0, 'utf8');
const packet = JSON.parse(input.split('PACKET:\\n')[1].split('\\n\\nRespond')[0]);
const behavior = ${JSON.stringify(behavior)};
const digest = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const result = (value = {}, changed_paths = [], tests = []) => process.stdout.write(JSON.stringify({ result_version: '2.0.0', status: 'done', summary: 'gates fixture', changed_paths, evidence: [], tests, findings: [], git_refs: [], support_requests: [], value }));
if (behavior === 'authority-invalid') process.exit(7);
else if (packet.objective.includes('Host authority plan validation')) result({ result_version: '2.0.0', result_type: 'plan-validation', valid: behavior !== 'plan-invalid', errors: behavior === 'plan-invalid' ? ['fixture rejected plan'] : [] });
else if (packet.objective.includes('Host authority review standards-review')) result({ result_version: '2.0.0', result_type: 'review', gate_id: 'standards-review', findings: behavior === 'review-finding' ? [{ severity: 'error', message: 'repair src input', path: 'src/input.ts', applicable_action_ids: ['task-001-example-implement'] }] : [] });
else if (packet.objective.includes('Host authority review spec-review')) result({ result_version: '2.0.0', result_type: 'review', gate_id: 'spec-review', findings: [] });
else if (packet.objective.includes('Host authority aggregate repair')) { writeFileSync(packet.write_paths[0], 'repaired\\n'); result({ result_version: '2.0.0', result_type: 'aggregate-repair', changed_paths: [packet.write_paths[0]] }, [packet.write_paths[0]]); }
else if (packet.objective.includes('Host authority repair test')) { const taskId = /repair test ([^ ]+)/.exec(packet.objective)[1]; result({ result_version: '2.0.0', result_type: 'repair-test', task_id: taskId, tests: [{ command: 'pnpm test', status: behavior === 'repair-test-failed' ? 'failed' : 'passed' }] }, [], [{ command: 'pnpm test', status: behavior === 'repair-test-failed' ? 'failed' : 'passed' }]); }
else if (packet.objective.includes('Host authority finding recheck')) { const finding = /finding-sha256:[a-f0-9]{64}/.exec(packet.objective)[0]; const evidencePath = packet.read_paths.find((path) => path === 'src/input.ts'); const evidence = readFileSync(evidencePath); result({ result_version: '2.0.0', result_type: 'finding-recheck', finding_id: finding, status: 'closed', evidence_paths: [evidencePath], evidence_digests: [digest(evidence)], repair_diff_digest: packet.evidence[1], source_review_receipt_digest: packet.evidence[0], message: 'recheck complete' }); }
else if (packet.role === 'test') result({}, [], [{ command: 'pnpm test', status: 'passed' }]);
else if (packet.write_paths.length) { writeFileSync(packet.write_paths[0], 'script action\\n'); result({}, [packet.write_paths[0]]); }
else result();
`);
  await chmod(host, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${hostDirectory}:${previousPath ?? ''}`;
  try {
    await exec('git', ['add', 'MEMORY.md', 'src', '.ai-workflow/plans'], { cwd: project });
    await exec('git', ['commit', '-m', 'fixture baseline'], { cwd: project });
    return await runV2Script({ project, runId, manifest, script, args: {}, scriptDigest: manifest.script.bytes_digest, argsDigest: manifest.args.bytes_digest });
  } finally {
    process.env.PATH = previousPath;
  }
}

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

  it('rejects caller-supplied lifecycle executors and gate evidence', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-complete';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'commit-and-merge' as const, required_actions: ['task-001-test'], depends_on: [] }],
      actions: [{ action_id: 'task-001-test', task_id: 'task-001', operation: 'test', write_scope: ['output.txt'] }],
    };

    const forged = { project, runId, manifest, execute: async () => ({ status: 'done' as const, tests: [], changedPaths: [] }), gateEvidence: { planValidation: { valid: true, errors: [] } }, planAuthority: async () => ({ valid: true, errors: [] }) };
    await expect(runV2Lifecycle(forged as never)).rejects.toThrow(/host-owned|production entry/i);
    expect((await gitBaseline(project)).head).toBeTruthy();
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

    const result = await runWithHost(project, runId, 'return true;', 'authority-invalid', false);

    expect(result.run_state).toBe('paused');
    await expect(loadV2Run(project, runId)).resolves.toMatchObject({ run_state: 'paused', stop_reason: 'blocked' });
  });

  it('does not treat plain review gate evidence as host review authority', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-review-authority';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'read-only-finalize' as const, required_actions: [], depends_on: [] }],
      actions: [],
    };
    const baseline = (await gitBaseline(project)).head!;

    await expect(runV2Lifecycle({ project, runId, manifest, execute: async () => { throw new Error('no action should execute'); }, gateEvidence: { planValidation: { valid: true, errors: [] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: true, noFastForward: true } } })).rejects.toThrow(/host-owned|runV2Script/i);

    await expect(loadV2Run(project, runId)).rejects.toThrow();
  });

  it('does not treat plain plan gate evidence as host validation authority', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-plan-authority';
    const manifest = {
      manifest_digest: digest,
      target_branch: 'main',
      tasks: [{ task_id: 'task-001', activation: 'required' as const, finalization_mode: 'read-only-finalize' as const, required_actions: [], depends_on: [] }],
      actions: [],
    };
    const baseline = (await gitBaseline(project)).head!;

    await expect(runV2Lifecycle({ project, runId, manifest, execute: async () => { throw new Error('no action should execute'); }, gateEvidence: { planValidation: { valid: true, errors: [] }, standardsReview: { findings: [] }, specReview: { findings: [] }, repairClosure: { closedFindingIds: [], expectedFindingIds: [] }, baseline: { expected: baseline, current: baseline }, integration: { observed: true, noFastForward: true } } })).rejects.toThrow(/host-owned|runV2Script/i);

    await expect(loadV2Run(project, runId)).rejects.toThrow();
  });

  it('starts one normalized repair when host review returns an error finding', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-review-repair';
    const result = await runWithHost(project, runId, `${completeTaskScript}\n`, 'review-finding');

    if (result.run_state !== 'complete') throw new Error(await readFile(join(project, '.ai-workflow/runs', runId, 'events.jsonl'), 'utf8'));
    await expect(readFile(join(project, '.ai-workflow/runs', runId, 'receipts', 'repair', 'start.json'), 'utf8')).resolves.toMatch(/finding-sha256/);
    await expect(readFile(join(project, '.ai-workflow/runs', runId, 'receipts', 'gate', 'integration.json'), 'utf8')).resolves.toMatch(/passed/);
  });

  it('runs repair tests and targeted rechecks before integrating reviewed findings', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-review-recheck';
    const result = await runWithHost(project, runId, `${completeTaskScript}\n`, 'review-finding');

    if (result.run_state !== 'complete') throw new Error(await readFile(join(project, '.ai-workflow/runs', runId, 'events.jsonl'), 'utf8'));
    await expect(readFile(join(project, '.ai-workflow/runs', runId, 'receipts', 'gate', 'repair-closure.json'), 'utf8')).resolves.toMatch(/passed/);
    await expect(readFile(join(project, '.ai-workflow/runs', runId, 'receipts', 'authority', 'aggregate-repair.json'), 'utf8')).resolves.toMatch(/src\/input.ts/);
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
    const result = await runWithHost(project, runId, `${completeTaskScript}\n`, 'authority-invalid');

    expect(result.run_state).toBe('paused');
    await expect(loadV2Run(project, runId)).resolves.toMatchObject({ run_state: 'paused', stop_reason: 'error' });
  });

  it('executes the approved lifecycle script through the Worker engine', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-script-engine';
    const result = await runWithHost(project, runId, "phase('script-phase'); log('script-log'); return { executed: true };\n", 'pass', false);

    expect(result.run_state).toBe('paused');
    await expect(readFile(join(project, '.ai-workflow/runs', runId, 'events.jsonl'), 'utf8')).resolves.toMatch(/script-phase|script-log/);
  });

  it('does not bypass the lifecycle Worker with a direct execute callback', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-no-direct-execute';
    const result = await runWithHost(project, runId, "phase('worker-only'); return { executed: true };\n", 'pass', false);

    expect(result.run_state).toBe('paused');
    await expect(readFile(join(project, '.ai-workflow/runs', runId, 'events.jsonl'), 'utf8')).resolves.toMatch(/worker-only/);
  });

  it('runs the generated lifecycle script when no custom script is supplied', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-generated-script';
    const result = await runWithHost(project, runId, "phase('generated-lifecycle'); return true;\n", 'pass', false);

    expect(result.run_state).toBe('paused');
    await expect(readFile(join(project, '.ai-workflow/runs', runId, 'events.jsonl'), 'utf8')).resolves.toMatch(/generated-lifecycle/);
  });

  it('requires an explicit skip control for conditional lifecycle tasks', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-conditional-skip';
    const result = await runWithHost(project, runId, 'await skipTask("task-001-example", "feature disabled", "control/skip-optional");\n', 'conditional-skip');

    expect(result.run_state).toBe('complete');
    expect(result.blocked_tasks).toContain('task-001-example');
  });

  it('routes approved lifecycle script actions through host execution and task closure', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-script-action-closure';
    const result = await runWithHost(project, runId, `${completeTaskScript}\n`);

    if (result.run_state !== 'complete') throw new Error(await readFile(join(project, '.ai-workflow/runs', runId, 'events.jsonl'), 'utf8'));
    await expect(readFile(join(project, 'src/input.ts'), 'utf8')).resolves.toBe('export const input = true;\n');
  });

  it('acquires a durable owner lease before lifecycle actions execute', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-owner-lease';
    const result = await runWithHost(project, runId, `${completeTaskScript}\n`);

    expect(result.run_state).toBe('complete');
    await expect(readFile(join(project, '.ai-workflow/runs', runId, 'events.jsonl'), 'utf8')).resolves.toMatch(/run\/lease-acquired/);
  });

  it('cancels a deferred v2 run and reconciles its durable projection without deleting resources', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-cancel';
    await startV2Run({ project, runId, manifestDigest: digest, fencingEpoch: 1 });
    await expect(cancelV2Run(project, runId)).rejects.toMatchObject({ code: 'CANCEL_UNAUTHORIZED' });
    await expect(projectV2Run(project, runId)).resolves.toMatchObject({ run_state: 'preflight' });
  });

  it('cleans a completed v2 run only through its owned resource receipts', async () => {
    const project = await temporary();
    await gitInit(project);
    const runId = 'runner-v2-cleanup';
    const result = await runWithHost(project, runId, `${completeTaskScript}\n`);
    expect(result.run_state).toBe('complete');
    const cleaned = await cleanupV2Run(project, runId);
    expect(cleaned.run_state).toBe('complete');
    expect(await readFile(join(project, 'src/input.ts'), 'utf8')).toBe('export const input = true;\n');
  });
});
