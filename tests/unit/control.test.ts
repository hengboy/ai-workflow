import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { CancelControl, CancelSocket, OwnerLease, safeReapProcessGroup, cancelProof, cancelReasonDigest } from '../../src/runtime/control.js';

describe('run control', () => {
  it('rejects a cancel request from an unauthorized socket peer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-control-'));
    const control = new CancelControl({
      root,
      runId: 'run-1',
      owner: { osUid: 501, identityDigest: 'identity-501' },
      fencingEpoch: 1,
      nonce: 'challenge-1',
    });

    await expect(control.requestCancel({
      peerUid: 502,
      runId: 'run-1',
      fencingEpoch: 1,
      nonce: 'challenge-1',
      reason: 'stop',
      identityDigest: 'identity-502',
      proof: 'invalid',
    })).rejects.toMatchObject({ code: 'CANCEL_UNAUTHORIZED' });
  });

  it('keeps the first authorized cancel reason when cancellation is requested twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-control-'));
    const control = new CancelControl({ root, runId: 'run-1', owner: { osUid: 501, identityDigest: 'identity-501' }, fencingEpoch: 4, nonce: 'challenge-1' });
    const request = (reason: string) => ({ peerUid: 501, runId: 'run-1', fencingEpoch: 4, nonce: 'challenge-1', reason, identityDigest: 'identity-501', proof: cancelProof('challenge-1', 'run-1', 4, cancelReasonDigest(reason)) });
    const first = await control.requestCancel(request('first reason'));
    const second = await control.requestCancel(request('second reason'));
    expect(first.won).toBe(true);
    expect(second.won).toBe(false);
    expect(second.intent.reason).toBe('first reason');
    expect(await control.readIntent()).toMatchObject({ reason: 'first reason', fencingEpoch: 4 });
  });

  it('rejects stale epoch and invalid nonce cancellation requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-control-'));
    const control = new CancelControl({ root, runId: 'run-1', owner: { osUid: 501, identityDigest: 'identity-501' }, fencingEpoch: 4, nonce: 'challenge-1' });
    const request = { peerUid: 501, runId: 'run-1', fencingEpoch: 3, nonce: 'wrong', reason: 'stop', identityDigest: 'identity-501', proof: 'wrong' };
    await expect(control.requestCancel(request)).rejects.toMatchObject({ code: 'CANCEL_CONTROL_STALE' });
  });

  it('fences the old owner after a dead owner lease is taken over', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-owner-'));
    const options = { root, runId: 'run-1', owner: { osUid: 501, identityDigest: 'identity-501' }, process: { pid: 10, pgid: 10, startIdentity: 'old-start', spawnNonce: 'old-nonce' }, leaseMs: 1_000 };
    const first = new OwnerLease(options);
    const second = new OwnerLease({ ...options, process: { ...options.process, pid: 11, pgid: 11, startIdentity: 'new-start', spawnNonce: 'new-nonce' }, isProcessAlive: () => false });
    const oldOwner = await first.acquire();
    const newOwner = await second.acquire({ wait: false });
    expect(newOwner.fencingEpoch).toBe(oldOwner.fencingEpoch + 1);
    await expect(first.assertCurrent(oldOwner)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await second.release(newOwner);
  });

  it('does not signal a process group whose start identity no longer matches', async () => {
    const signals: string[] = [];
    const identity = { pid: 10, pgid: 10, startIdentity: 'start-1', spawnNonce: 'nonce-1' };
    await expect(safeReapProcessGroup(identity, { ...identity, spawnNonce: 'reused' }, {
      isAlive: () => true,
      observe: () => identity,
      signal: (_pgid, signal) => { signals.push(signal); },
    })).rejects.toMatchObject({ code: 'CLEANUP_OWNERSHIP_UNPROVEN' });
    expect(signals).toEqual([]);
  });

  it('gracefully reaps and then forcefully reaps the same verified process group', async () => {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const identity = { pid: 10, pgid: 10, startIdentity: 'start-1', spawnNonce: 'nonce-1' };
    const result = await safeReapProcessGroup(identity, identity, {
      isAlive: () => alive,
      observe: () => identity,
      signal: (_pgid, signal) => { signals.push(signal); if (signal === 'SIGKILL') alive = false; },
      sleep: async () => undefined,
    });
    expect(result).toBe('reaped');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('authorizes socket cancellation using the peer credential before accepting the intent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-socket-'));
    const control = new CancelControl({ root, runId: 'run-1', owner: { osUid: 501, identityDigest: 'identity-501' }, fencingEpoch: 1, nonce: 'challenge-1' });
    const socketPath = join(root, 'cancel.sock');
    const socket = new CancelSocket(control, { socketPath, peerUid: () => 502 });
    await socket.start();
    const request = { runId: 'run-1', fencingEpoch: 1, nonce: 'challenge-1', reason: 'stop', identityDigest: 'identity-501', proof: cancelProof('challenge-1', 'run-1', 1, cancelReasonDigest('stop')) };
    const response = await new Promise<string>((resolvePromise, reject) => {
      const client = connect(socketPath);
      let data = '';
      client.on('data', (chunk) => { data += chunk.toString(); });
      client.on('end', () => resolvePromise(data));
      client.on('error', reject);
      client.on('connect', () => client.write(`${JSON.stringify(request)}\n`));
    });
    expect(JSON.parse(response)).toMatchObject({ error: { code: 'CANCEL_UNAUTHORIZED' } });
    expect(await control.readIntent()).toBeUndefined();
    await socket.close();
  });
});
