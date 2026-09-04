import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunLedger, type CallDescriptor, type RecordedAgentResult } from '../../src/runtime/ledger.js';
import { assertResumeFingerprint, loadRun, loadV2Run, saveRun, saveV2Run, type ResumeFingerprint, type RunRecord } from '../../src/runtime/store.js';
import { EventLog } from '../../src/runtime/events.js';
import { cancelV2Run, projectV2Run, resumeV2Run, startV2Run } from '../../src/runtime/runner.js';
import { generateManifest } from '../../src/workflow/generate.js';
import { frozenPlan } from '../helpers.js';
import { writeFile } from 'node:fs/promises';
import { runV2Script } from '../../src/runtime/runner.js';

const descriptor: CallDescriptor = { action_id: 'action-one', task_id: 'task-one', input: { value: 1 } };
const result: RecordedAgentResult = { result_version: '2.0.0', status: 'done', summary: 'ok', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [] };

async function createLedger() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-replay-'));
  return { directory, ledger: new RunLedger({ directory, runId: 'run-replay', fencingEpoch: 1 }) };
}

async function prepare(ledger: RunLedger, callId: string, callOrdinal: number): Promise<void> {
  await ledger.prepareCall({ callId, callOrdinal, descriptor: { ...descriptor, action_id: callId } });
}

describe('replay and resume', () => {
  it('replays calls in submission ordinal even when completion order differs', async () => {
    const { ledger } = await createLedger();
    await prepare(ledger, 'call-one', 1);
    await prepare(ledger, 'call-two', 2);
    await ledger.dispatchIntent('call-two');
    await ledger.markRunning('call-two');
    await ledger.observeCall('call-two', result);
    await ledger.checkpointCall('call-two');
    await ledger.dispatchIntent('call-one');
    await ledger.markRunning('call-one');
    await ledger.observeCall('call-one', result);
    await ledger.checkpointCall('call-one');

    await expect(ledger.replaySubmissionOrder()).resolves.toEqual([
      expect.objectContaining({ call_id: 'call-one', call_ordinal: 1 }),
      expect.objectContaining({ call_id: 'call-two', call_ordinal: 2 }),
    ]);
  });

  it.each(['prepared', 'intent', 'running', 'observed'] as const)('pauses unknown %s state instead of retrying the external call', async (state) => {
    const { ledger } = await createLedger();
    await prepare(ledger, `call-${state}`, 1);
    if (state === 'intent' || state === 'running' || state === 'observed') await ledger.dispatchIntent(`call-${state}`);
    if (state === 'running' || state === 'observed') await ledger.markRunning(`call-${state}`);
    if (state === 'observed') await ledger.observeCall(`call-${state}`, result);

    await expect(ledger.replayCall(`call-${state}`)).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
    await expect(ledger.reconcileCall(`call-${state}`)).resolves.toMatchObject({ state: 'reconcile_required' });
  });

  it('records an exact external outcome as reconciled and never invokes a retry callback', async () => {
    const { ledger } = await createLedger();
    await prepare(ledger, 'call-reconcile', 1);
    await ledger.dispatchIntent('call-reconcile');
    const retries = 0;

    const reconciled = await ledger.reconcileCall('call-reconcile', { outcome: 'expected', result, audit: { clean: true } });

    expect(reconciled).toMatchObject({ state: 'observed' });
    expect(await ledger.replayCall('call-reconcile')).toEqual(result);
    expect(retries).toBe(0);
  });

  it('only resolves a missing outcome for a read-only call with an audit proof', async () => {
    const { ledger } = await createLedger();
    await prepare(ledger, 'call-read-only', 1);
    await ledger.dispatchIntent('call-read-only');

    await expect(ledger.reconcileCall('call-read-only', { outcome: 'none', readOnly: true, audit: { clean: true } })).resolves.toMatchObject({ state: 'business_failed' });
    await expect(ledger.replayCall('call-read-only')).resolves.toBeNull();
  });

  it('rejects every changed resume fingerprint before any replay can proceed', () => {
    const fingerprint: ResumeFingerprint = { workflow: 'workflow-a', script: 'script-a', args: 'args-a', manifest: 'manifest-a', profile: 'profile-a', baseline: 'baseline-a' };
    for (const key of Object.keys(fingerprint) as Array<keyof ResumeFingerprint>) {
      const current = { ...fingerprint, [key]: `${fingerprint[key]}-drift` };
      expect(() => assertResumeFingerprint(fingerprint, current)).toThrow(new RegExp(`${key}.*drift`, 'i'));
    }
  });

  it('keeps v1 and v2 persistence entries on separate loader contracts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-versioned-'));
    const started = await startV2Run({ project: directory, runId: 'run-v2', manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fencingEpoch: 1 });

    expect(started).toMatchObject({ record_version: '2.0.0', engine: 'worker-thread-trusted', run_id: 'run-v2' });
    await expect(loadV2Run(directory, 'run-v2')).resolves.toMatchObject({ record_version: '2.0.0', run_state: 'preflight' });
    await expect(loadRun(directory, 'run-v2')).rejects.toMatchObject({ code: 'RUN_VERSION_MISMATCH' });

    const legacyDirectory = await mkdtemp(join(tmpdir(), 'ai-workflow-legacy-'));
    const legacy: RunRecord = { run_id: 'run-v1', project: legacyDirectory, workflow_path: 'workflow.json', workflow_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', plan_id: 'plan', host: 'codex', state: 'paused', started_at: '2026-09-03T00:00:00.000Z', updated_at: '2026-09-03T00:00:00.000Z', cancelled: false, resources: { start_branch: 'main', start_head: 'a'.repeat(40), task_worktrees: {}, task_branches: {}, commits: {} }, nodes: {}, events: [] };
    await saveRun(legacy);
    await expect(loadV2Run(legacyDirectory, 'run-v1')).rejects.toMatchObject({ code: 'RUN_VERSION_MISMATCH' });
    await expect(startV2Run({ project: legacyDirectory, runId: 'run-v1', manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fencingEpoch: 1 })).rejects.toThrow(/already exists/i);
  });

  it('projects v2 lifecycle events and resumes only after durable preflight checks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-v2-lifecycle-'));
    const manifestDigest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await startV2Run({ project: directory, runId: 'run-lifecycle', manifestDigest, fencingEpoch: 2 });
    const log = new EventLog({ path: join(directory, '.ai-workflow/runs/run-lifecycle/events.jsonl'), runId: 'run-lifecycle', fencingEpoch: 2 });
    await log.append({ type: 'run/error', payload: { state: 'paused', reason: 'worker exited' } });
    await expect(projectV2Run(directory, 'run-lifecycle')).resolves.toMatchObject({ run_state: 'paused' });

    const fingerprint: ResumeFingerprint = { workflow: 'workflow', script: 'script', args: 'args', manifest: manifestDigest, profile: 'profile', baseline: 'baseline' };
    await expect(resumeV2Run(directory, 'run-lifecycle', { expected: fingerprint, current: fingerprint })).resolves.toMatchObject({ run_state: 'executing' });
    await expect(cancelV2Run(directory, 'run-lifecycle')).resolves.toMatchObject({ run_state: 'cancelled', stop_reason: 'cancelled' });
    await expect(resumeV2Run(directory, 'run-lifecycle')).rejects.toThrow(/paused v2/i);
  });

  it('keeps a paused v2 run paused when resume authority is incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-v2-resume-guard-'));
    const manifestDigest = 'sha256:' + 'c'.repeat(64);
    await startV2Run({ project: directory, runId: 'run-guard', manifestDigest, fencingEpoch: 1 });
    const log = new EventLog({ path: join(directory, '.ai-workflow/runs/run-guard/events.jsonl'), runId: 'run-guard', fencingEpoch: 1 });
    await log.append({ type: 'run/error', payload: { state: 'paused', reason: 'worker exited' } });

    await expect(resumeV2Run(directory, 'run-guard')).rejects.toThrow(/fingerprint|authority/i);
    await expect(projectV2Run(directory, 'run-guard')).resolves.toMatchObject({ run_state: 'paused' });
    await expect(log.read()).resolves.toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ type: 'resume/diverged' })]) });
  });

  it('persists the first v2 cancel intent and retains unknown resources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-v2-cancel-intent-'));
    const manifestDigest = 'sha256:' + 'd'.repeat(64);
    const started = await startV2Run({ project: directory, runId: 'run-cancel-intent', manifestDigest, fencingEpoch: 1 });
    started.resources = [{ resource_id: 'unknown-resource' }];
    await saveV2Run(directory, started);

    const first = await cancelV2Run(directory, 'run-cancel-intent');
    const second = await cancelV2Run(directory, 'run-cancel-intent');

    expect(first).toMatchObject({ run_state: 'cancelled', stop_reason: 'cancelled' });
    expect(second).toMatchObject({ run_state: 'cancelled', stop_reason: 'cancelled' });
    await expect(readFile(join(directory, '.ai-workflow/runs/run-cancel-intent/control/cancel.json'), 'utf8')).resolves.toMatch(/run-cancel-intent/);
    await expect(readFile(join(directory, '.ai-workflow/runs/run-cancel-intent/events.jsonl'), 'utf8')).resolves.toMatch(/run\/cancel-requested/);
    expect(second.resources).toEqual([{ resource_id: 'unknown-resource' }]);
  });

  it('records a durable skip control for a conditional task in the approved script', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ai-workflow-v2-skip-control-'));
    const plan = await frozenPlan(project);
    await writeFile(join(plan, 'workflow.js'), 'await skipTask("task-001-example", "not activated", "control/skip-task");\n');
    const manifest = await generateManifest(plan, 'codex');
    manifest.tasks[0]!.activation = 'conditional';

    const record = await runV2Script({ project, runId: 'run-skip-control', manifest, script: await readFile(join(plan, 'workflow.js'), 'utf8'), args: {}, scriptDigest: manifest.script.bytes_digest, argsDigest: manifest.args.bytes_digest });

    expect(record.run_state).toBe('paused');
    expect(record.control_ledger).toEqual(expect.arrayContaining([expect.objectContaining({ control_id: 'control/skip-task', state: 'observed', result: expect.objectContaining({ state: 'skipped' }) })]));
  });
});
