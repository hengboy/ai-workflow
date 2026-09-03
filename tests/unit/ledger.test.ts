import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunLedger, type CallDescriptor, type ControlDescriptor, type RecordedAgentResult } from '../../src/runtime/ledger.js';
import { readCallCheckpoint } from '../../src/runtime/store.js';

const result: RecordedAgentResult = {
  result_version: '2.0.0', status: 'done', summary: 'completed', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [],
};
const descriptor: CallDescriptor = { action_id: 'action-one', task_id: 'task-one', input: { value: 1 } };
const control: ControlDescriptor = { operation: 'finalize-task', task_id: 'task-one', input: { value: 1 } };

async function ledgerFixture(maxFieldBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-ledger-'));
  const ledger = new RunLedger({ directory, runId: 'run-ledger', fencingEpoch: 4, ...(maxFieldBytes === undefined ? {} : { maxFieldBytes }) });
  return { directory, ledger };
}

describe('durable call and control ledger', () => {
  it('keeps one logical call while numbering physical attempts', async () => {
    const { ledger } = await ledgerFixture();
    const preparedEntry = await ledger.prepareCall({ callId: 'call-one', callOrdinal: 1, descriptor });
    const prepared = { ...preparedEntry };
    await ledger.dispatchIntent('call-one');
    await ledger.markRunning('call-one');
    await ledger.observeCall('call-one', result, { audit: { clean: true } });
    await ledger.recordTransientFailure('call-one', 'temporary host failure');
    await ledger.scheduleRetry('call-one');
    const retried = await ledger.retryCall('call-one');

    expect(prepared).toMatchObject({ call_id: 'call-one', call_ordinal: 1, attempt: 1, attempt_id: 'call-one/attempt-1' });
    expect(retried).toMatchObject({ call_id: 'call-one', call_ordinal: 1, attempt: 2, attempt_id: 'call-one/attempt-2', descriptor_digest: prepared.descriptor_digest, state: 'prepared' });
  });

  it('writes an owner-only checkpoint and returns its recorded result on replay', async () => {
    const { directory, ledger } = await ledgerFixture(64);
    await ledger.prepareCall({ callId: 'call-checkpoint', callOrdinal: 1, descriptor });
    await ledger.dispatchIntent('call-checkpoint');
    await ledger.markRunning('call-checkpoint');
    await ledger.observeCall('call-checkpoint', result, { audit: { clean: true } });
    const checkpoint = await ledger.checkpointCall('call-checkpoint', ['src/output.ts']);

    expect(checkpoint).toMatchObject({ call_id: 'call-checkpoint', state: 'checkpointed', attempt_id: 'call-checkpoint/attempt-1', changed_paths: ['src/output.ts'] });
    expect(await ledger.replayCall('call-checkpoint')).toEqual(result);
    const persisted = await readCallCheckpoint(directory, 'call-checkpoint');
    expect(persisted).toMatchObject({ checkpoint_version: '2.0.0', result });
    expect((await stat(join(directory, 'checkpoints', 'call-checkpoint.json'))).mode & 0o777).toBe(0o600);

    const reopened = new RunLedger({ directory, runId: 'run-ledger', fencingEpoch: 4 });
    expect(await reopened.replayCall('call-checkpoint')).toEqual(result);
    await expect(reopened.replayCall('call-checkpoint')).resolves.toEqual(persisted.result);
  });

  it('does not repeat a control side effect when the first reply is lost', async () => {
    const { ledger } = await ledgerFixture();
    let effects = 0;
    const execute = () => ledger.executeControl({ controlId: 'control-one', controlOrdinal: 1, descriptor: control }, async () => { effects += 1; return { receipt: 'receipt-one' }; });

    const first = await execute();
    const replayed = await execute();

    expect(first).toEqual({ receipt: 'receipt-one' });
    expect(replayed).toEqual(first);
    expect(effects).toBe(1);
  });

  it('moves an intent with unknown outcome to reconcile_required without retrying it', async () => {
    const { ledger } = await ledgerFixture();
    await ledger.prepareCall({ callId: 'call-unknown', callOrdinal: 1, descriptor });
    await ledger.dispatchIntent('call-unknown');

    await expect(ledger.replayCall('call-unknown')).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
    await expect(ledger.reconcileCall('call-unknown')).resolves.toMatchObject({ state: 'reconcile_required' });
  });

  it('redacts secrets and caps stored result fields', async () => {
    const { directory, ledger } = await ledgerFixture(64);
    const sensitive: RecordedAgentResult = { ...result, summary: 'authorization: Bearer secret-value', value: 'x'.repeat(200) };
    await ledger.prepareCall({ callId: 'call-sensitive', callOrdinal: 1, descriptor });
    await ledger.dispatchIntent('call-sensitive');
    await ledger.markRunning('call-sensitive');
    await ledger.observeCall('call-sensitive', sensitive, { audit: { stderr: 'token=secret' } });
    await ledger.checkpointCall('call-sensitive');

    const raw = await readFile(join(directory, 'checkpoints', 'call-sensitive.json'), 'utf8');
    expect(raw).not.toContain('secret-value');
    expect(raw).toContain('[REDACTED]');
    expect(raw).toContain('truncated');
  });

  it('rejects a duplicate logical call with a changed descriptor', async () => {
    const { ledger } = await ledgerFixture();
    await ledger.prepareCall({ callId: 'call-drift', callOrdinal: 1, descriptor });

    await expect(ledger.prepareCall({ callId: 'call-drift', callOrdinal: 1, descriptor: { ...descriptor, input: { value: 2 } } })).rejects.toMatchObject({ code: 'REPLAY_DIVERGED' });
  });
});
