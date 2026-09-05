import { describe, expect, it } from 'vitest';
import { CodingWorkflowEngine, type ChildRun, type HostChildExecutor } from '../../src/runtime/engine.js';
import type { CallDescriptor, CodingAgentResult } from '../../src/runtime/protocol.js';

const digest = `sha256:${'b'.repeat(64)}`;
const done = (value: unknown): CodingAgentResult => ({ result_version: '2.0.0', status: 'done', summary: 'done', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [], value });

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function executor(result: CodingAgentResult | Promise<CodingAgentResult> = done('ok'), records: CallDescriptor[] = [], disposals: string[] = []): HostChildExecutor {
  return {
    async start(descriptor) {
      records.push(descriptor);
      const child: ChildRun = { id: `child-${records.length}`, result: Promise.resolve(result), dispose: async () => { disposals.push(descriptor.call_id); } };
      return child;
    },
  };
}

function start(script: string, childExecutor?: HostChildExecutor, overrides: Record<string, unknown> = {}) {
  return new CodingWorkflowEngine().start({ script, manifestDigest: digest, scriptDigest: digest, argsDigest: digest, actions: [{ action_id: 'build', task_id: 'task-1' }], ...(childExecutor === undefined ? {} : { childExecutor }), disposeGraceMs: 50, ...overrides });
}

describe('worker workflow engine lifecycle', () => {
  it('uses one worker per run and resolves a completed result after ready/go', async () => {
    const records: CallDescriptor[] = [];
    const run = start(`const value = await agent('build', { actionId: 'build', callId: 'call-1' }); return value.value;`, executor(done('finished'), records));

    await expect(run.result).resolves.toMatchObject({ stop_reason: 'completed', value: 'finished', agents_started: 1 });
    expect(records).toHaveLength(1);
    expect(records[0]!.call_ordinal).toBe(1);
    await run.dispose();
  });

  it('cancels before go without running the script and never rejects the result', async () => {
    const run = start(`throw new Error('script should not run');`);
    run.cancel('cancel before go');

    await expect(run.result).resolves.toMatchObject({ stop_reason: 'cancelled' });
    await expect(run.dispose()).resolves.toBeUndefined();
  });

  it('cancels a mid-run child, pairs agent end once, and disposes the child', async () => {
    const pending = deferred<CodingAgentResult>();
    const records: CallDescriptor[] = [];
    const disposals: string[] = [];
    const lifecycle: string[] = [];
    const run = start(`await agent('long', { actionId: 'build', callId: 'call-1' }); return 'unreachable';`, {
      async start(descriptor) {
        records.push(descriptor);
        return { id: 'child-1', result: pending.promise, dispose: async () => { disposals.push(descriptor.call_id); } };
      },
    }, { observer: { agentStart: (_descriptor: CallDescriptor, childId: string) => lifecycle.push(`start:${childId}`), agentEnd: (_descriptor: CallDescriptor, outcome: 'completed' | 'failed' | 'cancelled') => lifecycle.push(`end:${outcome}`) } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    run.cancel('mid-run');

    await expect(run.result).resolves.toMatchObject({ stop_reason: 'cancelled' });
    expect(lifecycle).toEqual(['start:child-1', 'end:cancelled']);
    expect(disposals).toEqual(['call-1']);
    await run.dispose();
  });

  it('turns worker death into an error result and rejects late worker messages', async () => {
    const run = start(`await new Promise(() => {}); return 'never';`, undefined);
    await run.terminateWorkerForTest();

    await expect(run.result).resolves.toMatchObject({ stop_reason: 'error', error: expect.stringMatching(/worker/i) as unknown });
    await run.dispose();
  });

  it('first terminal result wins and dropped hook promises cannot reject the run', async () => {
    const records: CallDescriptor[] = [];
    const lifecycle: string[] = [];
    const childResult = deferred<CodingAgentResult>();
    const run = start(`agent('dropped', { actionId: 'build', callId: 'call-1' }); return { ok: true };`, {
      async start(descriptor) {
        records.push(descriptor);
        return { id: 'child-dropped', result: childResult.promise, dispose: async () => undefined };
      },
    }, { observer: { agentEnd: (_descriptor: CallDescriptor, outcome: 'completed' | 'failed' | 'cancelled') => { lifecycle.push(`end:${outcome}`); if (outcome === 'failed') throw new Error('observer failure'); } } });

    await expect(run.result).resolves.toMatchObject({ stop_reason: 'completed', value: { ok: true } });
    childResult.reject(new Error('late child failure'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(run.dispose()).resolves.toBeUndefined();
    expect(records).toHaveLength(1);
    expect(lifecycle).toContain('end:failed');
  });

  it('returns an error result for an unserializable workflow value', async () => {
    const run = start(`return { bad: undefined };`);

    await expect(run.result).resolves.toMatchObject({ stop_reason: 'error', error: expect.stringMatching(/undefined/i) as unknown });
    await run.dispose();
  });

  it('exposes S04 callbacks with descriptor and cleanup ordering', async () => {
    const audit: string[] = [];
    const sandbox: string[] = [];
    const registry: string[] = [];
    const records: CallDescriptor[] = [];
    const run = start(`const value = await agent('seam', { actionId: 'build', callId: 'call-seam' }); return value.value;`, executor(done('seam-ok'), records), {
      audit: (descriptor: CallDescriptor, event: 'before-dispatch' | 'after-dispose') => { audit.push(`${event}:${descriptor.call_id}`); },
      sandboxPreflight: (descriptor: CallDescriptor) => { sandbox.push(descriptor.call_id); },
      processRegistry: (event: { type: 'registered' | 'released'; runId: string; callId: string; childId: string }) => { registry.push(`${event.type}:${event.callId}`); },
    });

    await expect(run.result).resolves.toMatchObject({ stop_reason: 'completed', value: 'seam-ok' });
    await run.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(records[0]!.descriptor_digest).toMatch(/^sha256:/);
    expect(sandbox).toEqual(['call-seam']);
    expect(audit).toEqual(['before-dispatch:call-seam', 'after-dispose:call-seam']);
    expect(registry).toEqual(['registered:call-seam', 'released:call-seam']);
  });
});
