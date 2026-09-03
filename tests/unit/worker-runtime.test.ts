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

const digest = `sha256:${'a'.repeat(64)}`;
const ready: WorkerToHostMessage = {
  type: 'ready',
  protocol_version: '2.0.0',
  run_id: 'run-1',
  message_id: 1,
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
});
