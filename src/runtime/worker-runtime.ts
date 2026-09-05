import { AsyncLocalStorage } from 'node:async_hooks';
import { objectDigest } from '../utils/hash.js';
import {
  PROTOCOL_VERSION,
  type CallDescriptor,
  type CodingAgentResult,
  type HostToWorkerMessage,
  type TaskControlDescriptor,
  type WorkerToHostMessage,
} from './protocol.js';
import { compileWorkflowScript, materializeFromRealm, renderThrown } from './realm.js';

export interface ActionProjection {
  action_id: string;
  task_id: string;
  action_digest?: string;
}

export interface WorkerRuntimeOptions {
  runId: string;
  script: string;
  args?: unknown;
  manifestDigest: string;
  scriptDigest: string;
  argsDigest: string;
  actions: readonly ActionProjection[];
  maxConcurrentAgents: number;
  maxTotalAgents: number;
  maxItemsPerCall: number;
  maxScriptBytes: number;
  maxResultBytes: number;
  syncTimeoutMs: number;
  send: (message: WorkerToHostMessage) => void;
}

export class WorkflowError extends Error {
  readonly fatal = true as const;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

type WorkerMessageBody = WorkerToHostMessage extends infer Message
  ? Message extends WorkerToHostMessage
    ? Omit<Message, 'protocol_version' | 'run_id' | 'message_id'>
    : never
  : never;

function withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('maxConcurrentAgents must be a positive integer');
  }

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve: () => { this.active += 1; resolve(); }, reject }));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active -= 1;
  }

  cancel(error: WorkflowError): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

function isFatal(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new WorkflowError('SCRIPT_API_FORBIDDEN', `${label} must be a non-empty string`);
  return value;
}

function callIdValue(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-zA-Z][a-zA-Z0-9._/-]*$/.test(result)) throw new WorkflowError('SCRIPT_API_FORBIDDEN', `${label} has an invalid format`);
  return result;
}

function actionIdValue(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-z][a-z0-9-]*$/.test(result)) throw new WorkflowError('SCRIPT_API_FORBIDDEN', `${label} has an invalid format`);
  return result;
}

function plainClone(value: unknown, label: string): unknown {
  const materialized = materializeFromRealm(value, label);
  return materialized === undefined ? undefined : structuredClone(materialized);
}

function asWorkflowError(error: unknown): WorkflowError {
  return isFatal(error) ? error : new WorkflowError('SCRIPT_API_FORBIDDEN', renderThrown(error));
}

export class WorkerRuntime {
  private readonly semaphore: Semaphore;
  private readonly compiled;
  private readonly actionMap: ReadonlyMap<string, ActionProjection>;
  private readonly itemKeyStore = new AsyncLocalStorage<string>();
  private readonly pendingAgents = new Map<string, {
    started: { resolve: (value: string) => void; reject: (error: unknown) => void };
    settled: { resolve: (value: CodingAgentResult) => void; reject: (error: unknown) => void };
  }>();
  private readonly pendingControls = new Map<string, { resolve: (value: { state: 'finalized' | 'committed' | 'skipped'; receipt_digest: string }) => void; reject: (error: unknown) => void }>();
  private callOrdinal = 0;
  private controlOrdinal = 0;
  private agentsStarted = 0;
  private messageId = 0;
  private cancelled?: WorkflowError;
  private currentPhase?: string;

  constructor(private readonly options: WorkerRuntimeOptions) {
    this.semaphore = new Semaphore(options.maxConcurrentAgents);
    this.actionMap = new Map(options.actions.map((action) => [action.action_id, action]));
    try {
      this.compiled = compileWorkflowScript(options.script, options.runId, options.maxScriptBytes);
    } catch (error) {
      throw new WorkflowError('SCRIPT_PARSE', renderThrown(error));
    }
  }

  receive(message: HostToWorkerMessage): void {
    if (message.run_id !== this.options.runId || message.protocol_version !== PROTOCOL_VERSION) return;
    switch (message.type) {
      case 'cancel':
        this.cancel(message.reason);
        break;
      case 'agent-started':
        this.pendingAgents.get(message.request_id)?.started.resolve(message.child_id);
        break;
      case 'agent-settled':
        this.pendingAgents.get(message.request_id)?.settled.resolve(message.result);
        break;
      case 'agent-start-error':
        this.pendingAgents.get(message.request_id)?.started.reject(new WorkflowError(message.error.code, message.error.message));
        this.pendingAgents.get(message.request_id)?.settled.reject(new WorkflowError(message.error.code, message.error.message));
        break;
      case 'agent-disposed':
        break;
      case 'task-control-settled':
        this.pendingControls.get(message.request_id)?.resolve({ state: message.state, receipt_digest: message.receipt_digest });
        break;
      case 'task-control-error':
        this.pendingControls.get(message.request_id)?.reject(new WorkflowError(message.error.code, message.error.message));
        break;
      case 'go':
        break;
    }
  }

  cancel(reason: string): void {
    if (this.cancelled) return;
    this.cancelled = new WorkflowError('CANCEL_UNAUTHORIZED', `workflow run cancelled: ${reason}`);
    this.semaphore.cancel(this.cancelled);
  }

  async run(): Promise<import('./protocol.js').WorkflowResult> {
    try {
      const cancelled = this.cancelled;
      if (cancelled) throw new WorkflowError(cancelled.code, cancelled.message);
      const context = Object.create(null) as Record<string, unknown>;
      const args = plainClone(this.options.args ?? {}, 'args');
      context.args = deepFreeze(args);
      context.agent = (prompt: unknown, opts?: unknown) => this.contain(this.agent(prompt, opts));
      context.parallel = (thunks: unknown) => this.contain(this.parallel(thunks));
      context.pipeline = (items: unknown, config: unknown, ...stages: unknown[]) => this.contain(this.pipeline(items, config, stages));
      context.phase = (title: unknown) => this.phase(title);
      context.log = (message: unknown) => this.log(message);
      context.finalizeTask = (taskId: unknown, controlId: unknown) => this.contain(this.control('finalize-task', taskId, undefined, undefined, controlId));
      context.skipAction = (actionId: unknown, reason: unknown, controlId: unknown) => this.contain(this.control('skip-action', undefined, actionId, reason, controlId));
      context.skipTask = (taskId: unknown, reason: unknown, controlId: unknown) => this.contain(this.control('skip-task', taskId, undefined, reason, controlId));
      for (const [key, value] of Object.entries(context)) (context as Record<string, unknown>)[key] = typeof value === 'function' ? Object.freeze(value) : value;
      const value = await this.compiled.runInNewContext(context, { timeout: this.options.syncTimeoutMs }) as unknown;
      if (this.cancelled) throw this.cancelled;
      const materialized = materializeFromRealm(value === undefined ? null : value, 'workflow result');
      const encoded = JSON.stringify(materialized);
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > this.options.maxResultBytes) throw new WorkflowError('OUTPUT_CONTRACT_INVALID', 'workflow result exceeds the result size limit');
      return { value: materialized, stop_reason: 'completed', agents_started: this.agentsStarted, completed_tasks: [], blocked_tasks: [] };
    } catch (error) {
      const fatal = asWorkflowError(error);
      return { value: null, stop_reason: fatal.code.startsWith('CANCEL_') ? 'cancelled' : 'error', error: fatal.message, agents_started: this.agentsStarted, completed_tasks: [], blocked_tasks: [] };
    }
  }

  private contain<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => undefined);
    return promise;
  }

  private checkCancelled(): void {
    if (this.cancelled) throw this.cancelled;
  }

  private emit(message: WorkerMessageBody): void {
    this.messageId += 1;
    this.options.send({ ...message, protocol_version: PROTOCOL_VERSION, run_id: this.options.runId, message_id: this.messageId } as WorkerToHostMessage);
  }

  private phase(title: unknown): void {
    this.checkCancelled();
    const value = requiredString(title, 'phase() title');
    this.currentPhase = value;
    this.emit({ type: 'phase', title: value });
  }

  private log(message: unknown): void {
    this.checkCancelled();
    if (typeof message !== 'string') throw new WorkflowError('SCRIPT_API_FORBIDDEN', 'log() message must be a string');
    this.emit({ type: 'log', message });
  }

  private async agent(prompt: unknown, rawOptions: unknown): Promise<CodingAgentResult | null> {
    this.checkCancelled();
    const promptText = requiredString(prompt, 'agent() prompt');
    const opts = this.readAgentOptions(rawOptions);
    const action = this.actionMap.get(opts.actionId);
    if (!action) throw new WorkflowError('ACTION_NOT_AUTHORIZED', `action is not authorized: ${opts.actionId}`);
    if (this.agentsStarted >= this.options.maxTotalAgents) throw new WorkflowError('ACTION_NOT_AUTHORIZED', 'maximum agent count exceeded');
    const callId = callIdValue(opts.callId, 'agent() callId');
    this.agentsStarted += 1;
    this.callOrdinal += 1;
    const pipelineItemKey = this.itemKeyStore.getStore();
    const descriptorBase = {
      call_id: callId,
      call_ordinal: this.callOrdinal,
      action_id: action.action_id,
      task_id: action.task_id,
      prompt: promptText,
      ...opts.label === undefined ? {} : { label: opts.label },
      ...opts.phase === undefined && this.currentPhase === undefined ? {} : { phase: opts.phase ?? this.currentPhase },
      ...pipelineItemKey === undefined ? {} : { pipeline_item_key: pipelineItemKey },
      manifest_digest: this.options.manifestDigest,
      script_digest: this.options.scriptDigest,
      args_digest: this.options.argsDigest,
      action_digest: action.action_digest ?? this.options.manifestDigest,
    };
    const descriptor: CallDescriptor = { ...descriptorBase, descriptor_digest: objectDigest(descriptorBase) };
    await this.semaphore.acquire();
    try {
      this.checkCancelled();
      const started = withResolvers<string>();
      const settled = withResolvers<CodingAgentResult>();
      this.pendingAgents.set(callId, { started, settled });
      this.emit({ type: 'agent-start', request_id: callId, descriptor });
      await started.promise;
      const result = await settled.promise;
      if (result.status !== 'done') return null;
      return result;
    } catch (error) {
      if (isFatal(error)) throw error;
      return null;
    } finally {
      this.pendingAgents.delete(callId);
      this.emit({ type: 'agent-dispose', request_id: callId, call_id: callId });
      this.semaphore.release();
    }
  }

  private readonly usedCallIds = new Set<string>();

  private readAgentOptions(raw: unknown): { actionId: string; callId: string; label?: string; phase?: string } {
    const value = raw === undefined ? {} : plainClone(raw, 'agent() options');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError('SCRIPT_API_FORBIDDEN', 'agent() options must be an object');
    const options = value as Record<string, unknown>;
    for (const key of Object.keys(options)) if (!['actionId', 'callId', 'label', 'phase'].includes(key)) throw new WorkflowError('SCRIPT_API_FORBIDDEN', `agent() option is not allowed: ${key}`);
    const actionId = actionIdValue(options.actionId, 'agent() actionId');
    const callId = callIdValue(options.callId, 'agent() callId');
    if (this.usedCallIds.has(callId)) throw new WorkflowError('REPLAY_DIVERGED', `callId is duplicated: ${callId}`);
    this.usedCallIds.add(callId);
    for (const key of ['label', 'phase'] as const) if (options[key] !== undefined && typeof options[key] !== 'string') throw new WorkflowError('SCRIPT_API_FORBIDDEN', `agent() ${key} must be a string`);
    return { actionId, callId, ...options.label === undefined ? {} : { label: options.label as string }, ...options.phase === undefined ? {} : { phase: options.phase as string } };
  }

  private async parallel(rawThunks: unknown): Promise<unknown[]> {
    this.checkCancelled();
    if (!Array.isArray(rawThunks)) throw new WorkflowError('SCRIPT_API_FORBIDDEN', 'parallel() requires an array');
    this.assertItemCap(rawThunks.length, 'parallel()');
    const thunks = rawThunks.map((value, index) => {
      if (typeof value !== 'function') throw new WorkflowError('SCRIPT_API_FORBIDDEN', `parallel() item ${index} is not a function`);
      return value as () => unknown;
    });
    return Promise.all(thunks.map(async (thunk) => {
      try { return await thunk(); } catch (error) { if (isFatal(error)) throw error; return null; }
    }));
  }

  private async pipeline(rawItems: unknown, rawConfig: unknown, rawStages: unknown[]): Promise<unknown[]> {
    this.checkCancelled();
    if (!Array.isArray(rawItems)) throw new WorkflowError('SCRIPT_API_FORBIDDEN', 'pipeline() requires an items array');
    this.assertItemCap(rawItems.length, 'pipeline()');
    if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) throw new WorkflowError('REPLAY_DIVERGED', 'pipeline() requires itemKeys');
    const itemKeys = (rawConfig as { itemKeys?: unknown }).itemKeys;
    if (!Array.isArray(itemKeys) || itemKeys.length !== rawItems.length || itemKeys.some((key) => typeof key !== 'string' || key.length === 0) || new Set(itemKeys).size !== itemKeys.length) throw new WorkflowError('REPLAY_DIVERGED', 'pipeline itemKeys must be stable, unique and aligned with items');
    const stages = rawStages.map((value, index) => {
      if (typeof value !== 'function') throw new WorkflowError('SCRIPT_API_FORBIDDEN', `pipeline() stage ${index} is not a function`);
      return value as (previous: unknown, item: unknown, index: number, itemKey: string) => unknown;
    });
    if (stages.length === 0) throw new WorkflowError('SCRIPT_API_FORBIDDEN', 'pipeline() requires a stage');
    return Promise.all(rawItems.map(async (item, index) => {
      const itemKey = itemKeys[index] as string;
      try {
        let previous: unknown = item;
        for (const stage of stages) previous = await this.itemKeyStore.run(itemKey, () => stage(previous, item, index, itemKey));
        return previous;
      } catch (error) { if (isFatal(error)) throw error; return null; }
    }));
  }

  private assertItemCap(count: number, hook: string): void {
    if (count > this.options.maxItemsPerCall) throw new WorkflowError('ACTION_NOT_AUTHORIZED', `${hook} exceeds maxItemsPerCall`);
  }

  private async control(operation: TaskControlDescriptor['operation'], rawTaskId: unknown, rawActionId: unknown, rawReason: unknown, rawControlId: unknown): Promise<unknown> {
    this.checkCancelled();
    const controlId = requiredString(rawControlId, `${operation} controlId`);
    const taskId = rawTaskId === undefined ? undefined : requiredString(rawTaskId, `${operation} taskId`);
    const actionId = rawActionId === undefined ? undefined : requiredString(rawActionId, `${operation} actionId`);
    const reason = rawReason === undefined ? undefined : requiredString(rawReason, `${operation} reason`);
    if (this.pendingControls.has(controlId) || this.usedControlIds.has(controlId)) throw new WorkflowError('REPLAY_DIVERGED', `controlId is duplicated: ${controlId}`);
    this.usedControlIds.add(controlId);
    this.controlOrdinal += 1;
    const base = { control_id: controlId, control_ordinal: this.controlOrdinal, operation, ...taskId === undefined ? {} : { task_id: taskId }, ...actionId === undefined ? {} : { action_id: actionId }, ...reason === undefined ? {} : { reason }, manifest_digest: this.options.manifestDigest, script_digest: this.options.scriptDigest, args_digest: this.options.argsDigest };
    const descriptor: TaskControlDescriptor = { ...base, descriptor_digest: objectDigest(base) };
    return new Promise((resolve, reject) => {
      this.pendingControls.set(controlId, { resolve, reject });
      this.emit({ type: 'task-control', request_id: controlId, control_descriptor: descriptor });
    }).finally(() => { this.pendingControls.delete(controlId); });
  }

  private readonly usedControlIds = new Set<string>();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
