import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { MessageLedger, encodeMessage, type CallDescriptor, type CodingAgentResult, type HostToWorkerMessage, type WorkerToHostMessage, type WorkflowResult } from './protocol.js';
import type { WorkerInit } from './session.js';
import type { ProcessGroupIdentity } from '../adapters/process.js';

export interface ChildRun {
  readonly id: string;
  readonly result: Promise<CodingAgentResult>;
  readonly identity?: ProcessGroupIdentity;
  readonly reaped?: Promise<void>;
  dispose(): Promise<void>;
}

export interface HostChildExecutor {
  start(descriptor: CallDescriptor, signal: AbortSignal): Promise<ChildRun>;
}

export interface HostAuditCallback {
  (descriptor: CallDescriptor, event: 'before-dispatch' | 'after-dispose'): Promise<void> | void;
}

export interface SandboxPreflightCallback {
  (descriptor: CallDescriptor): Promise<void> | void;
}

export interface ProcessRegistryCallback {
  (event: { type: 'registered' | 'released'; runId: string; callId: string; childId: string; identity?: ProcessGroupIdentity }): Promise<void> | void;
}

export interface WorkflowObserver {
  phase?(title: string): void;
  log?(message: string): void;
  agentStart?(descriptor: CallDescriptor, childId: string): void;
  agentEnd?(descriptor: CallDescriptor, outcome: 'completed' | 'failed' | 'cancelled'): void;
}

export interface WorkerRunOptions {
  runId: string;
  worker: WorkerInit;
  childExecutor?: HostChildExecutor | undefined;
  observer?: WorkflowObserver | undefined;
  audit?: HostAuditCallback | undefined;
  sandboxPreflight?: SandboxPreflightCallback | undefined;
  processRegistry?: ProcessRegistryCallback | undefined;
  taskControl?: (descriptor: import('./protocol.js').TaskControlDescriptor) => Promise<{ state: 'finalized' | 'committed' | 'skipped'; receipt_digest: string }>;
  disposeGraceMs: number;
}

interface ChildRecord {
  descriptor: CallDescriptor;
  run: ChildRun;
  disposal?: Promise<void>;
}

type HostMessageBody = HostToWorkerMessage extends infer Message
  ? Message extends HostToWorkerMessage
    ? Omit<Message, 'protocol_version' | 'run_id' | 'message_id'>
    : never
  : never;

function workerEntry(): { entry: string | URL; options: { workerData: WorkerInit; execArgv?: string[] } } {
  if (import.meta.url.endsWith('.ts')) {
    const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = `import { register } from ${JSON.stringify(tsxApi)}; register(); await import(${JSON.stringify(new URL('./session.ts', import.meta.url).href)});`;
    return { entry: new URL(`data:text/javascript,${encodeURIComponent(source)}`), options: { workerData: undefined as never, execArgv: [] } };
  }
  return { entry: new URL('./session.js', import.meta.url), options: { workerData: undefined as never, execArgv: [] } };
}

export class WorkerRun {
  readonly result: Promise<WorkflowResult>;
  private resolveResult!: (result: WorkflowResult) => void;
  private settled = false;
  private terminalClaimed = false;
  private cancelReason?: string;
  private workerGone = false;
  private deathObserved = false;
  private outboundMessageId = 0;
  private graceTimer?: NodeJS.Timeout;
  private disposal?: Promise<void>;
  private readonly worker: Worker;
  private readonly children = new Map<string, ChildRecord>();
  private readonly liveAgents = new Map<string, CallDescriptor>();
  private readonly controller = new AbortController();
  private readonly ledger: MessageLedger;

  constructor(private readonly options: WorkerRunOptions) {
    this.result = new Promise((resolve) => { this.resolveResult = resolve; });
    this.ledger = new MessageLedger({ direction: 'worker-to-host', runId: options.runId });
    const spawn = workerEntry();
    this.worker = new Worker(spawn.entry, { ...spawn.options, workerData: options.worker });
    this.worker.on('message', (message: unknown) => this.onMessage(message));
    this.worker.on('error', (error) => this.onDeath(`worker error: ${error instanceof Error ? error.message : String(error)}`, false));
    this.worker.on('exit', (code) => { this.workerGone = true; this.onDeath(`worker exited before result (code ${code})`, true); });
  }

  cancel(reason = 'workflow cancelled'): void {
    if (this.settled || this.terminalClaimed || this.cancelReason) return;
    this.cancelReason = reason;
    this.controller.abort(reason);
    this.send({ type: 'cancel', reason });
    this.reapChildren();
    this.graceTimer = setTimeout(() => {
      this.terminalClaimed = true;
      this.endStrandedAgents();
      this.settle({ value: null, stop_reason: 'cancelled', error: `workflow run cancelled: ${reason}`, agents_started: this.liveAgents.size, completed_tasks: [], blocked_tasks: [] });
      void this.worker.terminate();
    }, this.options.disposeGraceMs);
    this.graceTimer.unref();
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposal = (async () => {
      this.cancel('workflow disposed');
      this.reapChildren();
      await Promise.race([this.result, new Promise<void>((resolve) => { const timer = setTimeout(resolve, this.options.disposeGraceMs); timer.unref(); })]);
      await this.worker.terminate();
      this.reapChildren();
    })();
    this.disposal.catch(() => undefined);
    return this.disposal;
  }

  terminateWorkerForTest(): Promise<number> {
    return this.worker.terminate();
  }

  private send(message: HostMessageBody): void {
    if (this.workerGone || this.deathObserved) return;
    this.outboundMessageId += 1;
    const full = { ...message, protocol_version: '2.0.0' as const, run_id: this.options.runId, message_id: this.outboundMessageId } as HostToWorkerMessage;
    try { this.worker.postMessage(JSON.parse(encodeMessage(full))); } catch (error) { if (!this.terminalClaimed) this.onDeath(`failed to post worker message (${message.type}): ${error instanceof Error ? error.message : String(error)}`, false); }
  }

  private onMessage(raw: unknown): void {
    if (this.deathObserved) return;
    let message: WorkerToHostMessage;
    try { message = this.ledger.accept(JSON.stringify(raw)) as WorkerToHostMessage; }
    catch (error) { this.terminalClaimed = true; this.endStrandedAgents(); this.settle({ value: null, stop_reason: 'error', error: `PROTOCOL_VIOLATION: ${error instanceof Error ? error.message : String(error)}`, agents_started: this.liveAgents.size, completed_tasks: [], blocked_tasks: [] }); void this.worker.terminate(); return; }
    switch (message.type) {
      case 'ready': this.send({ type: 'go' }); break;
      case 'phase': if (!this.cancelReason) this.options.observer?.phase?.(message.title); break;
      case 'log': if (!this.cancelReason) this.options.observer?.log?.(message.message); break;
      case 'agent-start': void this.startChild(message.request_id, message.descriptor); break;
      case 'agent-dispose': void this.disposeChild(message.request_id, message.call_id); break;
      case 'task-control': void this.handleTaskControl(message.request_id, message.control_descriptor); break;
      case 'result': this.onResult(message.result); break;
    }
  }

  private async handleTaskControl(requestId: string, descriptor: import('./protocol.js').TaskControlDescriptor): Promise<void> {
    if (!this.options.taskControl) {
      this.send({ type: 'task-control-error', request_id: requestId, control_id: descriptor.control_id, error: { code: 'ACTION_NOT_READY', message: 'task-control host adapter is not installed', fatal: true } });
      return;
    }
    try {
      const result = await this.options.taskControl(descriptor);
      this.send({ type: 'task-control-settled', request_id: requestId, control_id: descriptor.control_id, state: result.state, receipt_digest: result.receipt_digest });
    } catch (error) {
      this.send({ type: 'task-control-error', request_id: requestId, control_id: descriptor.control_id, error: { code: 'ACTION_NOT_READY', message: error instanceof Error ? error.message : String(error), fatal: true } });
    }
  }

  private async startChild(requestId: string, descriptor: CallDescriptor): Promise<void> {
    if (this.cancelReason || this.terminalClaimed || this.deathObserved || !this.options.childExecutor) {
      this.send({ type: 'agent-start-error', request_id: requestId, call_id: descriptor.call_id, error: { code: this.cancelReason ? 'CANCEL_UNAUTHORIZED' : 'ACTION_NOT_READY', message: this.cancelReason ?? 'host child executor is not installed', fatal: true } });
      return;
    }
    try {
      await this.options.sandboxPreflight?.(descriptor);
      await this.options.audit?.(descriptor, 'before-dispatch');
      const run = await this.options.childExecutor.start(descriptor, this.controller.signal);
      if (this.cancelReason || this.terminalClaimed || this.deathObserved) { await run.dispose().catch(() => undefined); this.send({ type: 'agent-start-error', request_id: requestId, call_id: descriptor.call_id, error: { code: 'CANCEL_UNAUTHORIZED', message: this.cancelReason ?? 'workflow is terminal', fatal: true } }); return; }
      this.children.set(descriptor.call_id, { descriptor, run });
      this.liveAgents.set(descriptor.call_id, descriptor);
       await this.options.processRegistry?.({ type: 'registered', runId: this.options.runId, callId: descriptor.call_id, childId: run.id, ...(run.identity === undefined ? {} : { identity: run.identity }) });
      this.options.observer?.agentStart?.(descriptor, run.id);
      this.send({ type: 'agent-started', request_id: requestId, call_id: descriptor.call_id, child_id: run.id });
      void run.result.then((result) => {
        this.send({ type: 'agent-settled', request_id: requestId, call_id: descriptor.call_id, result });
        this.options.observer?.agentEnd?.(descriptor, result.status === 'done' ? 'completed' : 'failed');
        this.liveAgents.delete(descriptor.call_id);
      }, () => {
        this.send({ type: 'agent-settled', request_id: requestId, call_id: descriptor.call_id, result: { result_version: '2.0.0', status: 'failed', summary: 'child result rejected', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [] } });
        this.options.observer?.agentEnd?.(descriptor, 'failed');
        this.liveAgents.delete(descriptor.call_id);
      });
     } catch (error) {
       const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'ACTION_NOT_READY';
       this.send({ type: 'agent-start-error', request_id: requestId, call_id: descriptor.call_id, error: { code: code as 'ACTION_NOT_READY', message: error instanceof Error ? error.message : String(error), fatal: true } });
     }
  }

  private disposeChild(requestId: string, callId: string): Promise<void> {
    const record = this.children.get(callId);
    if (!record) { this.send({ type: 'agent-disposed', request_id: requestId, call_id: callId }); return Promise.resolve(); }
     if (!record.disposal) record.disposal = (async () => {
       await record.run.dispose().catch(() => undefined);
       await record.run.reaped?.catch(() => undefined);
       await this.options.audit?.(record.descriptor, 'after-dispose');
       await this.options.processRegistry?.({ type: 'released', runId: this.options.runId, callId, childId: record.run.id, ...(record.run.identity === undefined ? {} : { identity: record.run.identity }) });
       this.children.delete(callId);
     })();
     return record.disposal.then(() => { if (!this.terminalClaimed) this.send({ type: 'agent-disposed', request_id: requestId, call_id: callId }); });
  }

  private reapChildren(): void { for (const [callId, record] of this.children) void this.disposeChild(callId, callId === record.descriptor.call_id ? callId : callId); }

  private endStrandedAgents(): void { for (const [callId, descriptor] of this.liveAgents) { this.options.observer?.agentEnd?.(descriptor, 'cancelled'); this.liveAgents.delete(callId); } }

  private onResult(result: WorkflowResult): void {
    if (this.terminalClaimed) return;
    this.terminalClaimed = true;
    if (this.cancelReason && result.stop_reason !== 'cancelled') result = { ...result, value: null, stop_reason: 'cancelled', error: `workflow run cancelled: ${this.cancelReason}` };
    this.reapChildren();
    this.settle(result);
  }

  private onDeath(message: string, isExit: boolean): void {
    if (this.deathObserved) return;
    this.deathObserved = true;
    if (!this.terminalClaimed) { this.terminalClaimed = true; this.endStrandedAgents(); this.reapChildren(); this.settle({ value: null, stop_reason: this.cancelReason ? 'cancelled' : 'error', error: this.cancelReason ? `workflow run cancelled: ${this.cancelReason}` : message, agents_started: this.liveAgents.size, completed_tasks: [], blocked_tasks: [] }); }
    if (isExit) this.reapChildren();
  }

  private settle(result: WorkflowResult): void { if (this.settled) return; this.settled = true; clearTimeout(this.graceTimer); this.resolveResult(result); }
}
