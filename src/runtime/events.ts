import { readFile } from 'node:fs/promises';
import type { CodingEventPayload, CodingEventType, CodingRunEvent } from '../generated/coding-event.schema.js';
import { appendFsync } from '../utils/fs.js';

const eventTypes = [
  'run/start', 'run/lease-acquired', 'run/cancel-requested', 'run/cancelling', 'run/cancelled', 'run/end', 'run/error',
  'workflow/phase', 'workflow/log', 'agent/start', 'agent/end', 'call/prepared', 'call/dispatch-intent', 'call/running',
  'call/observed', 'call/checkpointed', 'call/retry-scheduled', 'call/business-failed', 'call/blocked', 'call/audit-failed',
  'call/reconcile-required', 'control/prepared', 'control/intent', 'control/observed', 'control/cancelled',
  'control/reconcile-required', 'action/remediated', 'action/skipped', 'task/admitted', 'task/skipped', 'task/blocked',
  'task/finalize-intent', 'task/finalized', 'task/commit-intent', 'task/committed', 'scope/lease-acquired',
  'scope/lease-released', 'scope/queued', 'test/result', 'review/result', 'gate/started', 'gate/passed', 'gate/failed',
  'repair/started', 'repair/completed', 'git/baseline', 'git/project-lease-acquired', 'git/project-lease-released',
  'git/worktree-intent', 'git/worktree-created', 'git/commit-intent', 'git/commit-observed', 'git/merge-intent',
  'git/merge-observed', 'git/integration-intent', 'git/integration-observed', 'git/cleanup-intent', 'git/cleanup-observed',
  'resource/create-intent', 'resource/created', 'resource/retained', 'resume/replayed', 'resume/diverged',
] as const satisfies readonly CodingEventType[];

const eventTypeSet = new Set<string>(eventTypes);
const payloadKeys = new Set([
  'engine', 'manifest_digest', 'script_digest', 'args_digest', 'descriptor_digest', 'checkpoint_digest', 'receipt_digest',
  'audit_digest', 'repair_diff_digest', 'source_review_receipt_digest', 'policy_digest', 'resource_id', 'child_id', 'action_id',
  'original_action_id', 'repair_action_id', 'replacement_test_id', 'control_id', 'call_ordinal', 'attempt', 'attempt_id',
  'admission_ordinal', 'state', 'stop_reason', 'reason', 'message', 'title', 'code', 'error', 'reconciled', 'finding_id',
  'finding_ids', 'evidence_paths', 'evidence_digests', 'changed_paths', 'branch', 'head', 'target_head', 'expected_head',
  'path', 'kind', 'resource_kinds', 'findings', 'result', 'gate_id', 'predicate', 'merge_commit', 'commit', 'tree',
]);

export interface EventDraft {
  type: CodingEventType;
  payload: CodingEventPayload;
  call_id?: string;
  task_id?: string;
  transaction_id?: string;
  at?: string;
}

export interface EventLogOptions {
  path: string;
  runId: string;
  fencingEpoch: number;
  now?: () => string;
  maxEventBytes?: number;
}

export interface EventReadResult {
  events: CodingRunEvent[];
  tail_interrupted: boolean;
  next_seq: number;
}

export interface ProjectedCall {
  call_id: string;
  state: string;
  call_ordinal?: number;
  attempt?: number;
  attempt_id?: string;
  descriptor_digest?: string;
  checkpoint_digest?: string;
  audit_digest?: string;
}

export interface ProjectedControl {
  control_id: string;
  state: string;
  control_ordinal?: number;
  descriptor_digest?: string;
  receipt_digest?: string;
}

export interface EventProjection {
  run_id: string;
  fencing_epoch: number;
  last_seq: number;
  run_state?: string;
  calls: Record<string, ProjectedCall>;
  controls: Record<string, ProjectedControl>;
  agents: Record<string, { started: number; ended: number }>;
  tail_interrupted: boolean;
}

export class EventLogError extends Error {
  readonly name = 'EventLogError';
  constructor(readonly code: 'EVENT_INVALID' | 'EVENT_SEQUENCE' | 'EVENT_OWNER' | 'EVENT_TOO_LARGE' | 'EVENT_TAIL_INTERRUPTED', message: string) { super(message); }
}

function validId(value: string, label: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9._/-]*$/.test(value)) throw new EventLogError('EVENT_INVALID', `${label} is invalid`);
}

function validDigest(value: string): boolean { return /^sha256:[a-f0-9]{64}$/.test(value); }

function assertPayload(payload: unknown): asserts payload is CodingEventPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new EventLogError('EVENT_INVALID', 'payload must be an object');
  for (const key of Object.keys(payload)) if (!payloadKeys.has(key)) throw new EventLogError('EVENT_INVALID', `unknown payload field: ${key}`);
  const values = payload as Record<string, unknown>;
  for (const key of ['manifest_digest', 'script_digest', 'args_digest', 'descriptor_digest', 'checkpoint_digest', 'receipt_digest', 'audit_digest', 'repair_diff_digest', 'source_review_receipt_digest', 'policy_digest']) {
    const value = values[key];
    if (value !== undefined && (typeof value !== 'string' || !validDigest(value))) throw new EventLogError('EVENT_INVALID', `${key} must be a sha256 digest`);
  }
}

export function validateEvent(event: unknown, expected: Pick<EventLogOptions, 'runId' | 'fencingEpoch'>, sequence?: number): asserts event is CodingRunEvent {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new EventLogError('EVENT_INVALID', 'event must be an object');
  const value = event as Record<string, unknown>;
  const keys = new Set(['event_version', 'seq', 'at', 'run_id', 'fencing_epoch', 'type', 'call_id', 'task_id', 'transaction_id', 'payload']);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new EventLogError('EVENT_INVALID', `unknown event field: ${key}`);
  if (value.event_version !== '2.0.0') throw new EventLogError('EVENT_INVALID', 'event_version must be 2.0.0');
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) throw new EventLogError('EVENT_INVALID', 'seq must be a positive integer');
  if (sequence !== undefined && value.seq !== sequence) throw new EventLogError('EVENT_SEQUENCE', `expected sequence ${sequence}, received ${String(value.seq)}`);
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) throw new EventLogError('EVENT_INVALID', 'at must be a date-time');
  if (typeof value.run_id !== 'string') throw new EventLogError('EVENT_OWNER', 'run_id is invalid');
  validId(value.run_id, 'run_id');
  if (value.run_id !== expected.runId) throw new EventLogError('EVENT_OWNER', 'run_id does not belong to this log');
  if (!Number.isSafeInteger(value.fencing_epoch) || (value.fencing_epoch as number) < 1 || value.fencing_epoch !== expected.fencingEpoch) throw new EventLogError('EVENT_OWNER', 'fencing_epoch does not belong to this log');
  if (typeof value.type !== 'string' || !eventTypeSet.has(value.type)) throw new EventLogError('EVENT_INVALID', `unknown event type: ${String(value.type)}`);
  for (const key of ['call_id', 'transaction_id']) { const item = value[key]; if (item !== undefined && (typeof item !== 'string' || !/^[a-zA-Z][a-zA-Z0-9._/-]*$/.test(item))) throw new EventLogError('EVENT_INVALID', `${key} is invalid`); }
  if (value.task_id !== undefined && (typeof value.task_id !== 'string' || value.task_id.length === 0)) throw new EventLogError('EVENT_INVALID', 'task_id is invalid');
  assertPayload(value.payload);
}

async function readRaw(path: string, expected: Pick<EventLogOptions, 'runId' | 'fencingEpoch'>): Promise<EventReadResult> {
  let contents: string;
  try { contents = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], tail_interrupted: false, next_seq: 1 };
    throw error;
  }
  if (!contents) return { events: [], tail_interrupted: false, next_seq: 1 };
  const lines = contents.split('\n');
  const tail_interrupted = lines.at(-1) !== '';
  lines.pop();
  const events: CodingRunEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line) throw new EventLogError('EVENT_INVALID', `empty event line at ${index + 1}`);
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new EventLogError('EVENT_INVALID', `invalid JSON at line ${index + 1}`); }
    validateEvent(parsed, expected, index + 1);
    events.push(parsed);
  }
  return { events, tail_interrupted, next_seq: events.length + 1 };
}

export async function readEventLog(path: string, expected: Pick<EventLogOptions, 'runId' | 'fencingEpoch'>): Promise<EventReadResult> {
  return readRaw(path, expected);
}

function agentKey(event: CodingRunEvent): string | undefined {
  const childId = event.payload.child_id;
  const callId = event.call_id;
  return childId && callId ? `${callId}:${childId}` : undefined;
}

export function projectEvents(events: readonly CodingRunEvent[], expected: Pick<EventLogOptions, 'runId' | 'fencingEpoch'>, tail_interrupted = false): EventProjection {
  const projection: EventProjection = { run_id: expected.runId, fencing_epoch: expected.fencingEpoch, last_seq: 0, calls: {}, controls: {}, agents: {}, tail_interrupted };
  for (const [index, event] of events.entries()) {
    validateEvent(event, expected, index + 1);
    projection.last_seq = event.seq;
    if (event.type === 'run/start' || event.type === 'run/lease-acquired' || event.type === 'run/cancel-requested' || event.type === 'run/cancelling' || event.type === 'run/cancelled' || event.type === 'run/end' || event.type === 'run/error' || event.type === 'resume/replayed' || event.type === 'resume/diverged') projection.run_state = event.type === 'run/end' ? 'complete' : event.payload.state ?? event.type.slice(4);
    if (event.call_id && event.type.startsWith('call/')) projection.calls[event.call_id] = { ...projection.calls[event.call_id], call_id: event.call_id, state: event.type.slice(5), ...(event.payload.call_ordinal === undefined ? {} : { call_ordinal: event.payload.call_ordinal }), ...(event.payload.attempt === undefined ? {} : { attempt: event.payload.attempt }), ...(event.payload.attempt_id === undefined ? {} : { attempt_id: event.payload.attempt_id }), ...(event.payload.descriptor_digest === undefined ? {} : { descriptor_digest: event.payload.descriptor_digest }), ...(event.payload.checkpoint_digest === undefined ? {} : { checkpoint_digest: event.payload.checkpoint_digest }), ...(event.payload.audit_digest === undefined ? {} : { audit_digest: event.payload.audit_digest }) };
    if (event.payload.control_id && event.type.startsWith('control/')) projection.controls[event.payload.control_id] = { ...projection.controls[event.payload.control_id], control_id: event.payload.control_id, state: event.type.slice(8), ...(event.payload.call_ordinal === undefined ? {} : { control_ordinal: event.payload.call_ordinal }), ...(event.payload.descriptor_digest === undefined ? {} : { descriptor_digest: event.payload.descriptor_digest }), ...(event.payload.receipt_digest === undefined ? {} : { receipt_digest: event.payload.receipt_digest }) };
    const key = agentKey(event);
    if (key) { const current = projection.agents[key] ?? { started: 0, ended: 0 }; if (event.type === 'agent/start') current.started += 1; if (event.type === 'agent/end') current.ended += 1; if (current.started > 1 || current.ended > 1 || current.ended > current.started) throw new EventLogError('EVENT_INVALID', `agent lifecycle is not paired: ${key}`); projection.agents[key] = current; }
  }
  return projection;
}

export class EventLog {
  private readonly options: EventLogOptions;
  private readonly now: () => string;
  private readonly maxEventBytes: number;
  private next: Promise<unknown> = Promise.resolve();

  constructor(options: EventLogOptions);
  constructor(path: string, runId: string, fencingEpoch: number);
  constructor(optionsOrPath: EventLogOptions | string, runId?: string, fencingEpoch?: number) {
    this.options = typeof optionsOrPath === 'string' ? { path: optionsOrPath, runId: runId ?? '', fencingEpoch: fencingEpoch ?? 0 } : optionsOrPath;
    this.now = this.options.now ?? (() => new Date().toISOString());
    this.maxEventBytes = this.options.maxEventBytes ?? 256 * 1024;
    validId(this.options.runId, 'runId');
    if (!Number.isSafeInteger(this.options.fencingEpoch) || this.options.fencingEpoch < 1) throw new EventLogError('EVENT_OWNER', 'fencingEpoch must be positive');
  }

  async append(draft: EventDraft): Promise<CodingRunEvent> {
    const operation = this.next.then(async () => {
      const existing = await readRaw(this.options.path, this.options);
      if (existing.tail_interrupted) throw new EventLogError('EVENT_TAIL_INTERRUPTED', 'event log has an interrupted tail and must be repaired before append');
      const event: CodingRunEvent = { event_version: '2.0.0', seq: existing.next_seq, at: draft.at ?? this.now(), run_id: this.options.runId, fencing_epoch: this.options.fencingEpoch, type: draft.type, ...(draft.call_id === undefined ? {} : { call_id: draft.call_id }), ...(draft.task_id === undefined ? {} : { task_id: draft.task_id }), ...(draft.transaction_id === undefined ? {} : { transaction_id: draft.transaction_id }), payload: draft.payload };
      validateEvent(event, this.options, existing.next_seq);
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line) > this.maxEventBytes) throw new EventLogError('EVENT_TOO_LARGE', `event exceeds ${this.maxEventBytes} bytes`);
      await appendFsync(this.options.path, line);
      return event;
    });
    this.next = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async read(): Promise<EventReadResult> { return readRaw(this.options.path, this.options); }

  async rebuildState(): Promise<EventProjection> {
    const result = await this.read();
    return projectEvents(result.events, this.options, result.tail_interrupted);
  }
}
