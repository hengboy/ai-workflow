import { normalizeScope } from '../utils/paths.js';

export type LeaseTerminalState = 'completed' | 'finalized' | 'committed' | 'reconciled' | 'cancelled' | 'blocked';

export interface ScopeAdmissionRequest {
  admission_id: string;
  call_ordinal: number;
  action_id: string;
  task_id: string;
  read_scope: readonly string[];
  write_scope: readonly string[];
  concurrency_group_id?: string;
}

export interface ScopeAdmission {
  admission_id: string;
  call_ordinal: number;
  admission_ordinal: number;
  action_id: string;
  task_id: string;
  read_scope: readonly string[];
  write_scope: readonly string[];
  concurrency_group_id?: string;
}

export interface ScopeLease extends ScopeAdmission {
  readonly released: boolean;
  release(state: LeaseTerminalState): void;
}

export class SchedulerError extends Error {
  readonly name = 'SchedulerError';

  constructor(readonly code: 'PARALLEL_SCOPE_CONFLICT' | 'ACTION_CANCELLED' | 'LEASE_NOT_TERMINAL' | 'ACTION_NOT_READY', message: string) {
    super(message);
  }
}

interface QueueEntry {
  request: ScopeAdmissionRequest;
  resolve: (lease: ScopeLease) => void;
  reject: (error: unknown) => void;
  cancelled: boolean;
}

interface ActiveLease {
  lease: ScopeLease;
  released: boolean;
}

interface TaskScopeHolder {
  taskId: string;
  writeScope: string[];
}

function nonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new SchedulerError('ACTION_NOT_READY', `${label} must be non-empty`);
}

function validOrdinal(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new SchedulerError('ACTION_NOT_READY', `${label} must be a positive integer`);
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function conflicts(left: ScopeAdmissionRequest, right: ScopeAdmissionRequest): boolean {
  return overlaps(left.write_scope, right.write_scope)
    || overlaps(left.write_scope, right.read_scope)
    || overlaps(right.write_scope, left.read_scope);
}

export class ScopeScheduler {
  private active = 0;
  private nextAdmissionOrdinal = 1;
  private readonly activeLeases = new Map<string, ActiveLease>();
  private readonly queue: QueueEntry[] = [];
  private readonly cancelled = new Set<string>();
  private readonly taskWriteLeases = new Map<string, TaskScopeHolder>();
  private readonly traceEntries: string[] = [];

  constructor(private readonly options: { maxConcurrent: number }) {
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) throw new SchedulerError('ACTION_NOT_READY', 'maxConcurrent must be a positive integer');
  }

  get activeCount(): number {
    return this.active;
  }

  get trace(): readonly string[] {
    return [...this.traceEntries];
  }

  submit(rawRequest: ScopeAdmissionRequest): Promise<ScopeLease> {
    const request = this.normalizeRequest(rawRequest);
    const existing = [
      ...[...this.activeLeases.values()].filter(({ released }) => !released).map(({ lease }) => lease),
      ...this.queue.filter((entry) => !entry.cancelled).map((entry) => entry.request),
    ].find((candidate) => conflicts(request, candidate));
    if (existing && request.concurrency_group_id !== undefined && request.concurrency_group_id === existing.concurrency_group_id) {
      this.traceEntries.push(`reject:${request.admission_id}:PARALLEL_SCOPE_CONFLICT`);
      return Promise.reject(new SchedulerError('PARALLEL_SCOPE_CONFLICT', `scope conflicts with ${existing.admission_id} in concurrency group ${request.concurrency_group_id}`));
    }
    return new Promise<ScopeLease>((resolve, reject) => {
      const entry = { request, resolve, reject, cancelled: false };
      if (this.canAdmit(request)) this.admit(entry);
      else {
        this.queue.push(entry);
        this.traceEntries.push(`queue:${request.admission_id}`);
      }
    });
  }

  cancel(admissionId: string): boolean {
    const entry = this.queue.find((candidate) => candidate.request.admission_id === admissionId);
    if (!entry) return false;
    entry.cancelled = true;
    this.cancelled.add(admissionId);
    this.traceEntries.push(`cancel:${admissionId}`);
    entry.reject(new SchedulerError('ACTION_CANCELLED', `queued admission cancelled: ${admissionId}`));
    this.pump();
    return true;
  }

  finalizeTask(taskId: string, state: LeaseTerminalState): void {
    if (!['completed', 'finalized', 'committed', 'reconciled', 'cancelled', 'blocked'].includes(state)) throw new SchedulerError('LEASE_NOT_TERMINAL', `task ${taskId} is not terminal`);
    const ids = [...this.activeLeases.entries()]
      .filter(([, activeLease]) => activeLease.lease.task_id === taskId && !activeLease.released)
      .map(([id]) => id);
    for (const id of ids) this.releaseLease(id, state, true);
    this.taskWriteLeases.delete(taskId);
    this.traceEntries.push(`task-release:${taskId}:${state}`);
    this.pump();
  }

  private normalizeRequest(rawRequest: ScopeAdmissionRequest): ScopeAdmissionRequest {
    nonEmpty(rawRequest.admission_id, 'admission_id');
    nonEmpty(rawRequest.action_id, 'action_id');
    nonEmpty(rawRequest.task_id, 'task_id');
    validOrdinal(rawRequest.call_ordinal, 'call_ordinal');
    return {
      ...rawRequest,
      read_scope: rawRequest.read_scope.map((path) => normalizeScope(path)),
      write_scope: rawRequest.write_scope.map((path) => normalizeScope(path)),
    };
  }

  private canAdmit(request: ScopeAdmissionRequest): boolean {
    if (this.active >= this.options.maxConcurrent) return false;
    if ([...this.activeLeases.values()].some(({ lease, released }) => !released && conflicts(request, lease) && (lease.task_id !== request.task_id || lease.concurrency_group_id === request.concurrency_group_id))) return false;
    return ![...this.taskWriteLeases.values()].some((holder) => holder.taskId !== request.task_id
      && (overlaps(request.write_scope, holder.writeScope) || overlaps(request.read_scope, holder.writeScope)));
  }

  private admit(entry: QueueEntry): void {
    if (entry.cancelled || this.cancelled.has(entry.request.admission_id)) return;
    const admission: ScopeAdmission = {
      ...entry.request,
      admission_ordinal: this.nextAdmissionOrdinal++,
    };
    let activeLease: ActiveLease;
    const lease = {
      ...admission,
      get released() { return activeLease.released; },
      release: (state: LeaseTerminalState) => this.releaseLease(admission.admission_id, state),
    } as ScopeLease;
    activeLease = { lease, released: false };
    this.activeLeases.set(admission.admission_id, activeLease);
    this.active += 1;
    if (admission.write_scope.length > 0) {
      const holder = this.taskWriteLeases.get(admission.task_id);
      if (holder) holder.writeScope = [...new Set([...holder.writeScope, ...admission.write_scope])];
      else this.taskWriteLeases.set(admission.task_id, { taskId: admission.task_id, writeScope: [...admission.write_scope] });
    }
    this.traceEntries.push(`admit:${admission.admission_id}:${admission.admission_ordinal}`);
    entry.resolve(lease);
  }

  private releaseLease(admissionId: string, state: LeaseTerminalState, fromTaskFinalization = false): void {
    const activeLease = this.activeLeases.get(admissionId);
    if (!activeLease || activeLease.released) return;
    if (!fromTaskFinalization && !['completed', 'finalized', 'committed', 'reconciled', 'cancelled', 'blocked'].includes(state)) throw new SchedulerError('LEASE_NOT_TERMINAL', `admission ${admissionId} cannot release at ${state}`);
    activeLease.released = true;
    this.active -= 1;
    this.traceEntries.push(`release:${admissionId}:${state}`);
    this.pump();
  }

  private pump(): void {
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index];
      if (!entry || entry.cancelled) continue;
      if (!this.canAdmit(entry.request)) continue;
      this.queue.splice(index, 1);
      index -= 1;
      this.admit(entry);
    }
  }
}
