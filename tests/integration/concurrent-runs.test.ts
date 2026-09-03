import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectGitMutex, RunGitQueue } from '../../src/runtime/scheduler.js';

describe('concurrent runs', () => {
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
    expect(results.filter((result) => result.status === 'rejected').map((result) => result.reason.code)).toEqual(['GIT_MUTEX_BUSY']);
    const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<ProjectGitMutex['acquire']>>> => result.status === 'fulfilled');
    if (winner) {
      const winnerMutex = contenders[results.indexOf(winner)];
      if (winnerMutex) await winnerMutex.release(winner.value);
    }
  });
});
