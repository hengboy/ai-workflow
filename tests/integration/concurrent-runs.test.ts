import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectGitMutex, RunGitQueue } from '../../src/runtime/scheduler.js';
import { CancelControl, OwnerLease, RunControl, cancelProof, cancelReasonDigest } from '../../src/runtime/control.js';
import type { ActionAdmissionRequest, ActionCapabilityManifest } from '../../src/security/capability.js';

describe('concurrent runs', () => {
  function actionRequest(actionId: string): ActionAdmissionRequest {
    const digest = `sha256:${'a'.repeat(64)}`;
    const manifest: ActionCapabilityManifest = {
      plan_id: 'plan-control', host: 'codex',
      host_execution: {
        adapter: 'codex', mode: 'brokered-sandbox',
        model_transport: { owner: 'host-native-broker', network_allowed: true, project_write_allowed: false, credential_visibility: 'broker-only' },
        action_executor: { process_group: true, network_allowed: false, project_write_enforced: true, git_metadata_write_allowed: false },
        native_tool_authorization: 'unavailable', capability_digest: digest,
      },
      tasks: [{ task_id: 'task-control', depends_on: [], required_actions: ['build-a', 'build-b'], optional_actions: [], finalization_action: 'build-a' }],
      actions: [
        { action_id: 'build-a', task_id: 'task-control', operation: 'implement', role: 'backend', locator_read_order: ['src'], read_scope: ['src'], write_scope: ['src/a.ts'], new_module_directories: [], allowed_commands: [], test_commands: [], requires_actions: [], max_attempts: 1, optional: false, write_access: true, host_only: false },
        { action_id: 'build-b', task_id: 'task-control', operation: 'implement', role: 'backend', locator_read_order: ['src'], read_scope: ['src'], write_scope: ['src/b.ts'], new_module_directories: [], allowed_commands: [], test_commands: [], requires_actions: [], max_attempts: 1, optional: false, write_access: true, host_only: false },
      ],
    };
    return { manifest, action_id: actionId, run_id: 'run-control', cwd: rootForTests, attempt: 1, task_states: { 'task-control': 'ready' }, action_states: {}, active_hosts: [] };
  }

  let rootForTests = '/tmp/control-test-worktree';

  it('allows only one run into a same-branch Git mutation callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-git-mutex-'));
    const first = new ProjectGitMutex({ root, gitCommonDir: join(root, 'common'), targetBranch: 'main', leaseMs: 1_000 });
    const second = new ProjectGitMutex({ root, gitCommonDir: join(root, 'common'), targetBranch: 'main', leaseMs: 1_000 });
    const firstOwner = await first.acquire({ runId: 'run-1', pid: process.pid, startIdentity: 'start-1' });
    let secondEntered = false;
    const secondWaiter = second.withLock({ runId: 'run-2', pid: process.pid, startIdentity: 'start-2' }, async () => {
      secondEntered = true;
      return 'second';
    });

    await Promise.resolve();
    expect(secondEntered).toBe(false);
    await first.withLock(firstOwner, async () => 'first');
    await first.release(firstOwner);
    await expect(secondWaiter).resolves.toBe('second');
    expect(secondEntered).toBe(true);
  });

  it('serializes Git operations in submission order within one run', async () => {
    const queue = new RunGitQueue();
    const order: string[] = [];
    const owner = { runId: 'run-1', pid: process.pid, startIdentity: 'start-1', fencingEpoch: 1, leaseExpiresAt: Date.now() + 1_000 };
    const first = queue.enqueue(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); order.push('first'); return 1; }, owner);
    const second = queue.enqueue(async () => { order.push('second'); return 2; }, owner);
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first', 'second']);
  });

  it('takes over an expired owner with a higher fencing epoch and rejects the old owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-git-takeover-'));
    const options = { root, gitCommonDir: join(root, 'common'), targetBranch: 'main', leaseMs: 1_000 };
    const first = new ProjectGitMutex(options);
    const second = new ProjectGitMutex(options);
    const oldOwner = await first.acquire({ runId: 'run-old', pid: process.pid, startIdentity: 'old' });
    const lockPath = join(root, '.ai-workflow', 'locks');
    const lockFile = readdir(lockPath).then((files) => join(lockPath, files[0] as string));
    const path = await lockFile;
    const expired = new Date(Date.now() - 5_000);
    await utimes(path, expired, expired);
    const raw = JSON.parse(await readFile(path, 'utf8')) as typeof oldOwner;
    await writeFile(path, `${JSON.stringify({ ...raw, leaseExpiresAt: Date.now() - 1 })}\n`);

    const newOwner = await second.acquire({ runId: 'run-new', pid: process.pid, startIdentity: 'new' }, { wait: false });
    expect(newOwner.fencingEpoch).toBe(oldOwner.fencingEpoch + 1);
    await expect(first.withLock(oldOwner, async () => 'stale')).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await second.release(newOwner);
  });

  it('elects one winner when two runs race to take over an expired owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-git-race-'));
    const options = { root, gitCommonDir: join(root, 'common'), targetBranch: 'main', leaseMs: 1_000 };
    const original = new ProjectGitMutex(options);
    await original.acquire({ runId: 'run-old', pid: process.pid, startIdentity: 'old' });
    const path = join(root, '.ai-workflow', 'locks', (await readdir(join(root, '.ai-workflow', 'locks')))[0] as string);
    const owner = JSON.parse(await readFile(path, 'utf8')) as { leaseExpiresAt: number };
    await writeFile(path, `${JSON.stringify({ ...owner, leaseExpiresAt: Date.now() - 1, runId: 'run-old', pid: process.pid, startIdentity: 'old', fencingEpoch: 1 })}\n`);
    const contenders = [new ProjectGitMutex(options), new ProjectGitMutex(options)];
    const results = await Promise.allSettled(contenders.map((mutex, index) => mutex.acquire({ runId: `run-new-${index}`, pid: process.pid, startIdentity: `new-${index}` }, { wait: false })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) => {
      const reason: unknown = result.reason;
      return reason && typeof reason === 'object' && 'code' in reason ? reason.code : undefined;
    })).toEqual(['GIT_MUTEX_BUSY']);
    const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<ProjectGitMutex['acquire']>>> => result.status === 'fulfilled');
    if (winner) {
      const winnerMutex = contenders[results.indexOf(winner)];
      if (winnerMutex) await winnerMutex.release(winner.value);
    }
  });

  it('stops admission on cancel and releases an action lease only after reap and reconcile', async () => {
    rootForTests = await mkdtemp(join(tmpdir(), 'ai-workflow-run-control-'));
    const ownerIdentity = { osUid: 501, identityDigest: 'identity-501' };
    const processIdentity = { pid: process.pid, pgid: process.pid, startIdentity: 'run-start', spawnNonce: 'run-nonce' };
    const ownerLease = new OwnerLease({ root: rootForTests, runId: 'run-control', owner: ownerIdentity, process: processIdentity, leaseMs: 5_000 });
    const owner = await ownerLease.acquire();
    const cancelControl = new CancelControl({ root: rootForTests, runId: 'run-control', owner: ownerIdentity, fencingEpoch: owner.fencingEpoch, nonce: 'cancel-challenge' });
    const scheduler = new (await import('../../src/runtime/scheduler.js')).ScopeScheduler({ maxConcurrent: 1 });
    const events: string[] = [];
    let reconcile!: () => void;
    const reconciled = new Promise<void>((resolve) => { reconcile = resolve; });
    const control = new RunControl({
      ownerLease, owner, cancelControl, scheduler,
      abortChild: () => { events.push('abort'); },
      reapChild: () => { events.push('reap'); },
      reconcileChild: async () => { events.push('reconcile'); await reconciled; },
    });
    const first = await control.admitAction(actionRequest('build-a'));
    const second = control.admitAction(actionRequest('build-b'));
    const reason = 'operator requested stop';
    const cancel = control.requestCancel({ peerUid: 501, runId: 'run-control', fencingEpoch: owner.fencingEpoch, nonce: 'cancel-challenge', reason, identityDigest: ownerIdentity.identityDigest, proof: cancelProof('cancel-challenge', 'run-control', owner.fencingEpoch, cancelReasonDigest(reason)) });
    await expect(second).rejects.toMatchObject({ code: 'ACTION_CANCELLED' });
    await Promise.resolve();
    expect(events).toEqual(['abort', 'reap', 'reconcile']);
    expect(scheduler.activeCount).toBe(1);
    reconcile();
    await cancel;
    expect(scheduler.activeCount).toBe(0);
    await expect(control.admitAction(actionRequest('build-b'))).rejects.toMatchObject({ code: 'CANCEL_CONTROL_STALE' });
    expect(first.lease.released).toBe(true);
    await ownerLease.release(owner).catch(() => undefined);
  });
});
