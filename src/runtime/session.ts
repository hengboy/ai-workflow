import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { MessageLedger, ProtocolError, encodeMessage, type HostToWorkerMessage, type WorkerToHostMessage } from './protocol.js';
import { WorkerRuntime, type WorkerRuntimeOptions } from './worker-runtime.js';

export type WorkerInit = Omit<WorkerRuntimeOptions, 'send'>;

type WorkerMessageBody = WorkerToHostMessage extends infer Message
  ? Message extends WorkerToHostMessage
    ? Omit<Message, 'protocol_version' | 'run_id' | 'message_id'>
    : never
  : never;

function post(port: MessagePort, message: WorkerMessageBody, state: { messageId: number }, runId: string): void {
  state.messageId += 1;
  const full = { ...message, protocol_version: '2.0.0' as const, run_id: runId, message_id: state.messageId } as WorkerToHostMessage;
  port.postMessage(JSON.parse(encodeMessage(full)));
}

export async function runWorkerSession(port: MessagePort, init: WorkerInit): Promise<void> {
  const state = { messageId: 0 };
  let runtime: WorkerRuntime;
  try {
    runtime = new WorkerRuntime({ ...init, send: (message) => {
      state.messageId += 1;
      port.postMessage(JSON.parse(encodeMessage({ ...message, message_id: state.messageId })));
    } });
  } catch (error) {
    post(port, { type: 'result', result: { value: null, stop_reason: 'error', error: error instanceof Error ? error.message : String(error), agents_started: 0, completed_tasks: [], blocked_tasks: [] } }, state, init.runId);
    return;
  }

  const ledger = new MessageLedger({ direction: 'host-to-worker', runId: init.runId });
  let gateResolve!: () => void;
  const gate = new Promise<void>((resolve) => { gateResolve = resolve; });
  let released = false;
  const onMessage = (raw: unknown): void => {
    try {
      const message = ledger.accept(JSON.stringify(raw)) as HostToWorkerMessage;
      if (message.type === 'go' || message.type === 'cancel') {
        if (!released) { released = true; gateResolve(); }
      }
      runtime.receive(message);
    } catch (error) {
      runtime.cancel(error instanceof ProtocolError ? error.message : String(error));
      if (!released) { released = true; gateResolve(); }
    }
  };
  port.on('message', onMessage);
  post(port, { type: 'ready' }, state, init.runId);
  await gate;
  const result = await runtime.run();
  post(port, { type: 'result', result }, state, init.runId);
  port.off('message', onMessage);
}

if (parentPort !== null && workerData !== undefined) {
  void runWorkerSession(parentPort, workerData as WorkerInit);
}
