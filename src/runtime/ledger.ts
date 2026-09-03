import type { CodingAgentResult } from '../generated/coding-agent-result.schema.js';
import { redact } from '../security/policy.js';
import { objectDigest, sha256 } from '../utils/hash.js';
import { EventLog } from './events.js';
import { ensureRunStorage, readCallCheckpoint, writeCallCheckpoint, writeControlReceipt, type CallCheckpoint } from './store.js';

export type RecordedAgentResult = CodingAgentResult;
export interface CallDescriptor { action_id: string; task_id: string; [key: string]: unknown }
export interface ControlDescriptor { operation: 'finalize-task' | 'skip-action' | 'skip-task'; task_id?: string; [key: string]: unknown }
export type CallState = 'prepared' | 'dispatch_intent' | 'running' | 'observed' | 'checkpointed' | 'transient_failed' | 'retry_scheduled' | 'business_failed' | 'blocked' | 'cancelled' | 'reconcile_required';
export type ControlState = 'prepared' | 'intent' | 'observed' | 'cancelled' | 'reconcile_required';

export interface CallLedgerEntry {
  call_id: string;
  call_ordinal: number;
  action_id: string;
  task_id: string;
  descriptor_digest: string;
  attempt: number;
  attempt_id: string;
  state: CallState;
  checkpoint_digest?: string;
  audit_digest?: string;
  child_id?: string;
  pid?: number;
  pgid?: number;
  reconciled?: boolean;
  result?: unknown;
}

export interface ControlLedgerEntry {
  control_id: string;
  control_ordinal: number;
  operation: ControlDescriptor['operation'];
  descriptor_digest: string;
  state: ControlState;
  receipt_digest?: string;
  result?: unknown;
}

export interface LedgerOptions {
  directory: string;
  runId: string;
  fencingEpoch: number;
  eventLog?: EventLog;
  maxFieldBytes?: number;
  redactionPatterns?: readonly RegExp[];
}

export interface PreparedCall {
  callId: string;
  callOrdinal: number;
  descriptor: CallDescriptor;
}

export interface PreparedControl {
  controlId: string;
  controlOrdinal: number;
  descriptor: ControlDescriptor;
}

export class LedgerError extends Error {
  readonly name = 'LedgerError';
  constructor(readonly code: 'DUPLICATE_CALL' | 'DUPLICATE_CONTROL' | 'REPLAY_DIVERGED' | 'INVALID_TRANSITION' | 'RECONCILE_REQUIRED' | 'CHECKPOINT_REQUIRED', message: string) { super(message); }
}

export function descriptorDigest(descriptor: unknown): string { return objectDigest(descriptor); }

export interface ProjectionOptions { maxBytes?: number; patterns?: readonly RegExp[] }

export function redactAndCap(value: unknown, options: ProjectionOptions = {}): unknown {
  const maxBytes = options.maxBytes ?? 16 * 1024;
  if (typeof value === 'string') {
    let projected = redact(value);
    for (const pattern of options.patterns ?? []) { pattern.lastIndex = 0; projected = projected.replace(pattern, '[REDACTED]'); }
    const bytes = Buffer.byteLength(projected);
    if (bytes > maxBytes) return `[truncated ${sha256(projected)} bytes=${bytes}]`;
    return projected;
  }
  if (Array.isArray(value)) return value.map((item) => redactAndCap(item, options));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactAndCap(item, options)]));
  return value;
}

function digestValue(value: unknown): string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : objectDigest(value); }
function callEventPayload(entry: CallLedgerEntry, options: { state?: string; result?: RecordedAgentResult; error?: string; reconciled?: boolean } = {}): { call_ordinal: number; attempt: number; attempt_id: string; descriptor_digest: string; action_id: string; state?: string; result?: RecordedAgentResult; error?: string; audit_digest?: string; checkpoint_digest?: string; reconciled?: boolean } {
  return { call_ordinal: entry.call_ordinal, attempt: entry.attempt, attempt_id: entry.attempt_id, descriptor_digest: entry.descriptor_digest, action_id: entry.action_id, ...(options.state === undefined ? {} : { state: options.state }), ...(options.result === undefined ? {} : { result: options.result }), ...(options.error === undefined ? {} : { error: options.error }), ...(options.reconciled === undefined ? {} : { reconciled: options.reconciled }), ...(entry.audit_digest === undefined ? {} : { audit_digest: entry.audit_digest }), ...(entry.checkpoint_digest === undefined ? {} : { checkpoint_digest: entry.checkpoint_digest }) };
}

export class RunLedger {
  readonly calls = new Map<string, CallLedgerEntry>();
  readonly controls = new Map<string, ControlLedgerEntry>();
  readonly eventLog: EventLog;
  private hydrated = false;
  private readonly maxFieldBytes: number;
  private readonly redactionPatterns: readonly RegExp[];

  constructor(private readonly options: LedgerOptions) {
    this.eventLog = options.eventLog ?? new EventLog({ path: `${options.directory}/events.jsonl`, runId: options.runId, fencingEpoch: options.fencingEpoch });
    this.maxFieldBytes = options.maxFieldBytes ?? 16 * 1024;
    this.redactionPatterns = options.redactionPatterns ?? [];
  }

  async prepareCall(input: PreparedCall): Promise<CallLedgerEntry> {
    await this.hydrate();
    const digest = descriptorDigest(input.descriptor);
    const existing = this.calls.get(input.callId);
    if (existing) {
      if (existing.descriptor_digest !== digest || existing.call_ordinal !== input.callOrdinal || existing.action_id !== input.descriptor.action_id || existing.task_id !== input.descriptor.task_id) throw new LedgerError('REPLAY_DIVERGED', `call descriptor diverged: ${input.callId}`);
      throw new LedgerError('DUPLICATE_CALL', `call already exists: ${input.callId}`);
    }
    const entry: CallLedgerEntry = { call_id: input.callId, call_ordinal: input.callOrdinal, action_id: input.descriptor.action_id, task_id: input.descriptor.task_id, descriptor_digest: digest, attempt: 1, attempt_id: `${input.callId}/attempt-1`, state: 'prepared' };
    await this.eventLog.append({ type: 'call/prepared', call_id: input.callId, task_id: input.descriptor.task_id, payload: callEventPayload(entry) });
    this.calls.set(input.callId, entry);
    return entry;
  }

  async dispatchIntent(callId: string): Promise<CallLedgerEntry> { return this.transitionCall(callId, 'dispatch_intent', 'call/dispatch-intent'); }
  async markRunning(callId: string, process?: { childId?: string; pid?: number; pgid?: number }): Promise<CallLedgerEntry> {
    const entry = await this.transitionCall(callId, 'running', 'call/running');
    if (process) Object.assign(entry, process);
    return entry;
  }

  async observeCall(callId: string, result: RecordedAgentResult, options: { audit?: unknown; auditDigest?: string } = {}): Promise<CallLedgerEntry> {
    const entry = await this.requireCall(callId);
    if (!['running', 'dispatch_intent'].includes(entry.state)) throw new LedgerError('INVALID_TRANSITION', `call ${callId} cannot be observed from ${entry.state}`);
    entry.audit_digest = options.auditDigest ?? digestValue(options.audit ?? null);
    const projected = redactAndCap(result, { maxBytes: this.maxFieldBytes, patterns: this.redactionPatterns }) as RecordedAgentResult;
    await this.eventLog.append({ type: 'call/observed', call_id: callId, task_id: entry.task_id, payload: callEventPayload(entry, { state: 'observed', result: projected }) });
    entry.state = 'observed';
    entry.result = result;
    return entry;
  }

  async recordTransientFailure(callId: string, error: string): Promise<CallLedgerEntry> {
    const entry = await this.requireCall(callId);
    if (!['running', 'observed'].includes(entry.state)) throw new LedgerError('INVALID_TRANSITION', `call ${callId} cannot fail transiently from ${entry.state}`);
    await this.eventLog.append({ type: 'call/observed', call_id: callId, task_id: entry.task_id, payload: callEventPayload(entry, { state: 'transient_failed', error: redactAndCap(error, { maxBytes: this.maxFieldBytes, patterns: this.redactionPatterns }) as string }) });
    entry.state = 'transient_failed';
    return entry;
  }

  async scheduleRetry(callId: string): Promise<CallLedgerEntry> { return this.transitionCall(callId, 'retry_scheduled', 'call/retry-scheduled'); }

  async retryCall(callId: string): Promise<CallLedgerEntry> {
    const entry = await this.requireCall(callId);
    if (entry.state !== 'retry_scheduled') throw new LedgerError('INVALID_TRANSITION', `call ${callId} is not scheduled for retry`);
    entry.attempt += 1;
    entry.attempt_id = `${entry.call_id}/attempt-${entry.attempt}`;
    entry.state = 'prepared';
    await this.eventLog.append({ type: 'call/prepared', call_id: callId, task_id: entry.task_id, payload: callEventPayload(entry) });
    return entry;
  }

  async checkpointCall(callId: string, changedPaths: string[] = []): Promise<CallCheckpoint> {
    const entry = await this.requireCall(callId);
    if (entry.state !== 'observed' || !entry.result) throw new LedgerError('CHECKPOINT_REQUIRED', `call ${callId} has no observed result`);
    const checkpoint: CallCheckpoint = { checkpoint_version: '2.0.0', call_id: entry.call_id, call_ordinal: entry.call_ordinal, action_id: entry.action_id, task_id: entry.task_id, descriptor_digest: entry.descriptor_digest, attempt: entry.attempt, attempt_id: entry.attempt_id, state: 'checkpointed', result: redactAndCap(entry.result, { maxBytes: this.maxFieldBytes, patterns: this.redactionPatterns }) as RecordedAgentResult, audit_digest: entry.audit_digest ?? digestValue(null), ...(changedPaths.length ? { changed_paths: changedPaths } : {}) };
    await writeCallCheckpoint(this.options.directory, checkpoint);
    entry.checkpoint_digest = objectDigest(checkpoint);
    await this.eventLog.append({ type: 'call/checkpointed', call_id: callId, task_id: entry.task_id, payload: callEventPayload(entry, { state: 'checkpointed', result: checkpoint.result }) });
    entry.state = 'checkpointed';
    return checkpoint;
  }

  async replayCall(callId: string): Promise<unknown> {
    const entry = await this.requireCall(callId);
    if (entry.state === 'checkpointed' || (entry.state === 'observed' && entry.reconciled)) return entry.result ?? (await readCallCheckpoint(this.options.directory, callId)).result;
    if (entry.state === 'business_failed' || entry.state === 'blocked' || entry.state === 'cancelled') return null;
    throw new LedgerError('RECONCILE_REQUIRED', `call ${callId} has unresolved state ${entry.state}`);
  }

  async replaySubmissionOrder(): Promise<CallLedgerEntry[]> {
    await this.hydrate();
    return [...this.calls.values()].sort((left, right) => left.call_ordinal - right.call_ordinal).map((entry) => ({ ...entry }));
  }

  async reconcileCall(callId: string, outcome?: { outcome: 'expected'; result: RecordedAgentResult; audit?: unknown } | { outcome: 'none'; readOnly: true; audit: unknown } | { outcome: 'ambiguous' }): Promise<CallLedgerEntry> {
    const entry = await this.requireCall(callId);
    if (entry.state === 'reconcile_required') return entry;
    if (outcome?.outcome === 'expected') {
      entry.audit_digest = digestValue(outcome.audit ?? null);
      const projected = redactAndCap(outcome.result, { maxBytes: this.maxFieldBytes, patterns: this.redactionPatterns }) as RecordedAgentResult;
      await this.eventLog.append({ type: 'call/observed', call_id: callId, task_id: entry.task_id, payload: callEventPayload(entry, { state: 'observed', result: projected, reconciled: true }) });
      entry.state = 'observed';
      entry.reconciled = true;
      entry.result = outcome.result;
      return entry;
    }
    if (outcome?.outcome === 'none' && outcome.readOnly) {
      entry.audit_digest = digestValue(outcome.audit);
      await this.eventLog.append({ type: 'call/business-failed', call_id: callId, task_id: entry.task_id, payload: callEventPayload(entry, { state: 'business_failed' }) });
      entry.state = 'business_failed';
      entry.result = null;
      return entry;
    }
    await this.eventLog.append({ type: 'call/reconcile-required', call_id: callId, task_id: entry.task_id, payload: callEventPayload(entry, { state: 'reconcile_required' }) });
    entry.state = 'reconcile_required';
    return entry;
  }

  async prepareControl(input: PreparedControl): Promise<ControlLedgerEntry> {
    await this.hydrate();
    const digest = descriptorDigest(input.descriptor);
    const existing = this.controls.get(input.controlId);
    if (existing) {
      if (existing.descriptor_digest !== digest || existing.control_ordinal !== input.controlOrdinal) throw new LedgerError('REPLAY_DIVERGED', `control descriptor diverged: ${input.controlId}`);
      throw new LedgerError('DUPLICATE_CONTROL', `control already exists: ${input.controlId}`);
    }
    const entry: ControlLedgerEntry = { control_id: input.controlId, control_ordinal: input.controlOrdinal, operation: input.descriptor.operation, descriptor_digest: digest, state: 'prepared' };
    await this.eventLog.append({ type: 'control/prepared', payload: { control_id: input.controlId, call_ordinal: input.controlOrdinal, descriptor_digest: digest, kind: input.descriptor.operation } });
    this.controls.set(input.controlId, entry);
    return entry;
  }

  async intentControl(controlId: string): Promise<ControlLedgerEntry> { return this.transitionControl(controlId, 'intent', 'control/intent'); }

  async observeControl(controlId: string, result: unknown, receiptDigest?: string): Promise<ControlLedgerEntry> {
    const entry = await this.requireControl(controlId);
    if (entry.state !== 'intent') throw new LedgerError('INVALID_TRANSITION', `control ${controlId} cannot be observed from ${entry.state}`);
    entry.receipt_digest = receiptDigest ?? objectDigest(result);
    entry.result = result;
    await writeControlReceipt(this.options.directory, controlId, redactAndCap(result, { maxBytes: this.maxFieldBytes, patterns: this.redactionPatterns }));
    await this.eventLog.append({ type: 'control/observed', payload: { control_id: controlId, call_ordinal: entry.control_ordinal, descriptor_digest: entry.descriptor_digest, receipt_digest: entry.receipt_digest, result: redactAndCap(result, { maxBytes: this.maxFieldBytes, patterns: this.redactionPatterns }) as RecordedAgentResult } });
    entry.state = 'observed';
    return entry;
  }

  async executeControl<T>(input: PreparedControl, effect: () => Promise<T> | T): Promise<T> {
    await this.hydrate();
    const existing = this.controls.get(input.controlId);
    if (existing) {
      if (existing.descriptor_digest !== descriptorDigest(input.descriptor) || existing.control_ordinal !== input.controlOrdinal) throw new LedgerError('REPLAY_DIVERGED', `control descriptor diverged: ${input.controlId}`);
      if (existing.state === 'observed') return existing.result as T;
      throw new LedgerError('RECONCILE_REQUIRED', `control ${input.controlId} has unresolved state ${existing.state}`);
    }
    await this.prepareControl(input);
    await this.intentControl(input.controlId);
    const value = await effect();
    await this.observeControl(input.controlId, value);
    return value;
  }

  async replayControl(controlId: string): Promise<unknown> {
    const entry = await this.requireControl(controlId);
    if (entry.state === 'observed') return entry.result;
    throw new LedgerError('RECONCILE_REQUIRED', `control ${controlId} has unresolved state ${entry.state}`);
  }

  private async transitionCall(callId: string, state: CallState, type: 'call/dispatch-intent' | 'call/running' | 'call/retry-scheduled'): Promise<CallLedgerEntry> {
    const entry = await this.requireCall(callId);
    const allowed: Record<string, CallState[]> = { 'call/dispatch-intent': ['prepared'], 'call/running': ['dispatch_intent'], 'call/retry-scheduled': ['transient_failed'] };
    if (!allowed[type]?.includes(entry.state)) throw new LedgerError('INVALID_TRANSITION', `call ${callId} cannot transition from ${entry.state}`);
    await this.eventLog.append({ type, call_id: callId, task_id: entry.task_id, payload: callEventPayload(entry) });
    entry.state = state;
    return entry;
  }

  private async transitionControl(controlId: string, state: ControlState, type: 'control/intent'): Promise<ControlLedgerEntry> {
    const entry = await this.requireControl(controlId);
    if (entry.state !== 'prepared') throw new LedgerError('INVALID_TRANSITION', `control ${controlId} cannot transition from ${entry.state}`);
    await this.eventLog.append({ type, payload: { control_id: controlId, call_ordinal: entry.control_ordinal, descriptor_digest: entry.descriptor_digest, kind: entry.operation } });
    entry.state = state;
    return entry;
  }

  private async requireCall(callId: string): Promise<CallLedgerEntry> { await this.hydrate(); const entry = this.calls.get(callId); if (!entry) throw new LedgerError('REPLAY_DIVERGED', `unknown call: ${callId}`); return entry; }
  private async requireControl(controlId: string): Promise<ControlLedgerEntry> { await this.hydrate(); const entry = this.controls.get(controlId); if (!entry) throw new LedgerError('REPLAY_DIVERGED', `unknown control: ${controlId}`); return entry; }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    await ensureRunStorage(this.options.directory);
    const { events } = await this.eventLog.read();
    for (const event of events) {
      const payload = event.payload;
      if (event.call_id && event.type.startsWith('call/')) {
        const current = this.calls.get(event.call_id);
        const state = payload.state ?? event.type.slice(5).replaceAll('-', '_');
        const entry: CallLedgerEntry = current ?? { call_id: event.call_id, call_ordinal: payload.call_ordinal ?? 0, action_id: payload.action_id ?? '', task_id: event.task_id ?? '', descriptor_digest: payload.descriptor_digest ?? '', attempt: payload.attempt ?? 1, attempt_id: payload.attempt_id ?? `${event.call_id}/attempt-${payload.attempt ?? 1}`, state: state as CallState };
        entry.state = state as CallState;
        if (payload.call_ordinal !== undefined) entry.call_ordinal = payload.call_ordinal;
        if (payload.attempt !== undefined) entry.attempt = payload.attempt;
        if (payload.attempt_id !== undefined) entry.attempt_id = payload.attempt_id;
        if (payload.descriptor_digest !== undefined) entry.descriptor_digest = payload.descriptor_digest;
        if (payload.action_id !== undefined) entry.action_id = payload.action_id;
        if (payload.audit_digest !== undefined) entry.audit_digest = payload.audit_digest;
        if (payload.checkpoint_digest !== undefined) entry.checkpoint_digest = payload.checkpoint_digest;
        if (payload.reconciled !== undefined) entry.reconciled = payload.reconciled;
        if (payload.result !== undefined) entry.result = payload.result;
        this.calls.set(event.call_id, entry);
      }
      if (event.payload.control_id && event.type.startsWith('control/')) {
        const controlId = event.payload.control_id;
        const current = this.controls.get(controlId);
        const state = (event.type === 'control/prepared' ? 'prepared' : event.type.slice(8).replaceAll('-', '_')) as ControlState;
        const entry: ControlLedgerEntry = current ?? { control_id: controlId, control_ordinal: payload.call_ordinal ?? 0, operation: (payload.kind ?? 'skip-action') as ControlDescriptor['operation'], descriptor_digest: payload.descriptor_digest ?? '', state };
        entry.state = state;
        if (payload.receipt_digest !== undefined) entry.receipt_digest = payload.receipt_digest;
        if (payload.result !== undefined) entry.result = payload.result;
        this.controls.set(controlId, entry);
      }
    }
    this.hydrated = true;
  }
}

export { RunLedger as Ledger };
