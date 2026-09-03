import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunLedger, type CallDescriptor, type RecordedAgentResult } from '../../src/runtime/ledger.js';
import { assertResumeFingerprint, type ResumeFingerprint } from '../../src/runtime/store.js';

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
});
