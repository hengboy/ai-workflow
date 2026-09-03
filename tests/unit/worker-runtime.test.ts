import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  MessageLedger,
  ProtocolError,
  decodeMessage,
  encodeMessage,
  type WorkerToHostMessage,
} from '../../src/runtime/protocol.js';
import { MaterializeError, compileWorkflowScript, materializeFromRealm } from '../../src/runtime/realm.js';
import { WorkerRuntime } from '../../src/runtime/worker-runtime.js';

const digest = `sha256:${'a'.repeat(64)}`;
const ready: WorkerToHostMessage = {
  type: 'ready',
  protocol_version: '2.0.0',
  run_id: 'run-1',
  message_id: 1,
};
const validResult = {
  result_version: '2.0.0' as const,
  status: 'done' as const,
  summary: 'ok',
  changed_paths: [],
  evidence: [],
  tests: [],
  findings: [],
  git_refs: [],
  support_requests: [],
};

describe('worker runtime protocol and realm boundary', () => {
  it('round-trips a versioned ready message through the public codec', () => {
    const encoded = encodeMessage(ready);

    expect(decodeMessage(encoded, { direction: 'worker-to-host', runId: 'run-1' })).toEqual(ready);
  });

  it('rejects unknown tags and messages for another run', () => {
    expect(() => decodeMessage(JSON.stringify({ ...ready, type: 'unknown' }), { direction: 'worker-to-host', runId: 'run-1' })).toThrow(ProtocolError);
    expect(() => decodeMessage(JSON.stringify({ ...ready, run_id: 'run-2' }), { direction: 'worker-to-host', runId: 'run-1' })).toThrow(/run/i);
  });

  it('rejects a duplicate message id at the protocol boundary', () => {
    const ledger = new MessageLedger({ runId: 'run-1', direction: 'worker-to-host' });

    expect(ledger.accept(JSON.stringify(ready))).toEqual(ready);
    expect(() => ledger.accept(JSON.stringify(ready))).toThrow(/duplicate/i);
  });

  it('rejects request messages without a valid request id or descriptor', () => {
    const message = {
      type: 'agent-start',
      protocol_version: '2.0.0',
      run_id: 'run-1',
      message_id: 2,
      request_id: 'request/1',
      descriptor: {
        call_id: 'call/1',
        call_ordinal: 1,
        action_id: 'build',
        task_id: 'task-1',
        prompt: 'build',
        manifest_digest: digest,
        script_digest: digest,
        args_digest: digest,
        action_digest: digest,
        descriptor_digest: digest,
      },
    };

    expect(decodeMessage(JSON.stringify(message), { direction: 'worker-to-host', runId: 'run-1' })).toEqual(message);
    expect(() => decodeMessage(JSON.stringify({ ...message, request_id: 'bad id' }), { direction: 'worker-to-host', runId: 'run-1' })).toThrow(ProtocolError);
    expect(() => decodeMessage(JSON.stringify({ ...message, descriptor: { ...message.descriptor, call_ordinal: 0 } }), { direction: 'worker-to-host', runId: 'run-1' })).toThrow(ProtocolError);
  });

  it('materializes cross-realm JSON values and rejects values JSON cannot preserve', () => {
    const value = vm.runInNewContext('({ answer: 42, nested: [true, "ok"] })');
    expect(materializeFromRealm(value)).toEqual({ answer: 42, nested: [true, 'ok'] });

    expect(() => materializeFromRealm(() => 1)).toThrow(MaterializeError);
    expect(() => materializeFromRealm({ value: undefined })).toThrow(/undefined/);
    expect(() => materializeFromRealm({ value: Number.NaN })).toThrow(/finite/);
    expect(() => materializeFromRealm(new Date())).toThrow(/exotic/i);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => materializeFromRealm(cyclic)).toThrow(/circular/i);
  });

  it('rejects oversized values and wraps script parse failures', () => {
    expect(() => encodeMessage({ ...ready, message_id: 2 }, { maxBytes: 20 })).toThrow(/size/i);
    expect(() => compileWorkflowScript('await ;', 'workflow-test')).toThrow(/parse/i);
    expect(compileWorkflowScript('return { value: 1 };', 'workflow-test')).toBeInstanceOf(vm.Script);
  });

  it('runs parallel calls as a barrier with ordinal descriptors and ordinary null failures', async () => {
    const messages: WorkerToHostMessage[] = [];
    const runtime = new WorkerRuntime({
      runId: 'run-1', script: `const values = await parallel([() => agent('one', { actionId: 'build', callId: 'call-1' }), () => agent('two', { actionId: 'build', callId: 'call-2' })]); return values.map((item) => item?.value ?? null);`,
      args: {}, manifestDigest: digest, scriptDigest: digest, argsDigest: digest,
      actions: [{ action_id: 'build', task_id: 'task-1' }], maxConcurrentAgents: 2, maxTotalAgents: 4, maxItemsPerCall: 4, maxScriptBytes: 1000, maxResultBytes: 1000, syncTimeoutMs: 1000,
      send: (message) => messages.push(message),
    });
    const resultPromise = runtime.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const starts = messages.filter((message): message is Extract<WorkerToHostMessage, { type: 'agent-start' }> => message.type === 'agent-start');
    expect(starts.map((message) => message.descriptor.call_ordinal)).toEqual([1, 2]);
    for (const [index, start] of starts.entries()) runtime.receive({ type: 'agent-started', protocol_version: '2.0.0', run_id: 'run-1', message_id: 10 + index, request_id: start.request_id, call_id: start.descriptor.call_id, child_id: `child-${index}` });
    runtime.receive({ type: 'agent-settled', protocol_version: '2.0.0', run_id: 'run-1', message_id: 20, request_id: starts[0]!.request_id, call_id: starts[0]!.descriptor.call_id, result: { ...validResult, value: 'first' } });
    runtime.receive({ type: 'agent-settled', protocol_version: '2.0.0', run_id: 'run-1', message_id: 21, request_id: starts[1]!.request_id, call_id: starts[1]!.descriptor.call_id, result: { ...validResult, status: 'failed', value: 'ignored' } });
    await expect(resultPromise).resolves.toMatchObject({ stop_reason: 'completed', value: ['first', null], agents_started: 2 });
  });

  it('runs pipeline stages per item, preserves item keys, and skips later stages after business failure', async () => {
    const messages: WorkerToHostMessage[] = [];
    const runtime = new WorkerRuntime({
      runId: 'run-1', script: `const seen = []; const result = await pipeline(['a', 'b'], { itemKeys: ['item-a', 'item-b'] }, async (value, item, index, key) => { seen.push('first:' + key); if (key === 'item-a') throw new Error('business failure'); return (await agent('prompt-' + item, { actionId: 'build', callId: 'call-' + key }))?.value ?? null; }, async (value, item, index, key) => { seen.push('second:' + key); return value; }); return { result, seen };`,
      args: {}, manifestDigest: digest, scriptDigest: digest, argsDigest: digest,
      actions: [{ action_id: 'build', task_id: 'task-1' }], maxConcurrentAgents: 2, maxTotalAgents: 4, maxItemsPerCall: 4, maxScriptBytes: 1000, maxResultBytes: 1000, syncTimeoutMs: 1000,
      send: (message) => messages.push(message),
    });
    const resultPromise = runtime.run();
    await new Promise((resolve) => setImmediate(resolve));
    const starts = messages.filter((message): message is Extract<WorkerToHostMessage, { type: 'agent-start' }> => message.type === 'agent-start');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.descriptor.pipeline_item_key).toBe('item-b');
    runtime.receive({ type: 'agent-started', protocol_version: '2.0.0', run_id: 'run-1', message_id: 10, request_id: starts[0]!.request_id, call_id: starts[0]!.descriptor.call_id, child_id: 'child-b' });
    runtime.receive({ type: 'agent-settled', protocol_version: '2.0.0', run_id: 'run-1', message_id: 11, request_id: starts[0]!.request_id, call_id: starts[0]!.descriptor.call_id, result: { ...validResult, value: 'b-result' } });
    await expect(resultPromise).resolves.toMatchObject({ stop_reason: 'completed', value: { result: [null, 'b-result'], seen: ['first:item-a', 'first:item-b', 'second:item-b'] } });
  });

  it('rejects unstable pipeline keys and performs task control only through RPC', async () => {
    const messages: WorkerToHostMessage[] = [];
    const runtime = new WorkerRuntime({
      runId: 'run-1', script: `await skipTask('task-1', 'predicate false', 'control-1'); return true;`, args: {}, manifestDigest: digest, scriptDigest: digest, argsDigest: digest,
      actions: [], maxConcurrentAgents: 1, maxTotalAgents: 1, maxItemsPerCall: 4, maxScriptBytes: 1000, maxResultBytes: 1000, syncTimeoutMs: 1000, send: (message) => messages.push(message),
    });
    const resultPromise = runtime.run();
    await new Promise((resolve) => setImmediate(resolve));
    const control = messages.find((message): message is Extract<WorkerToHostMessage, { type: 'task-control' }> => message.type === 'task-control');
    expect(control?.control_descriptor.operation).toBe('skip-task');
    expect(messages.some((message) => message.type === 'agent-start')).toBe(false);
    runtime.receive({ type: 'task-control-settled', protocol_version: '2.0.0', run_id: 'run-1', message_id: 2, request_id: 'control-1', control_id: 'control-1', state: 'skipped', receipt_digest: digest });
    await expect(resultPromise).resolves.toMatchObject({ stop_reason: 'completed', value: true });

    const invalid = new WorkerRuntime({
      runId: 'run-2', script: `return pipeline([1, 2], { itemKeys: ['same', 'same'] }, (value) => value);`, args: {}, manifestDigest: digest, scriptDigest: digest, argsDigest: digest,
      actions: [], maxConcurrentAgents: 1, maxTotalAgents: 1, maxItemsPerCall: 4, maxScriptBytes: 1000, maxResultBytes: 1000, syncTimeoutMs: 1000, send: () => undefined,
    });
    await expect(invalid.run()).resolves.toMatchObject({ stop_reason: 'error', error: expect.stringMatching(/itemKeys/) });
  });
});
