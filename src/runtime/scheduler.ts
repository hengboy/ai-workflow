import { normalizeScope } from '../utils/paths.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

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

export interface GitMutexOwner {
  runId: string;
  pid: number;
  startIdentity: string;
  fencingEpoch: number;
  leaseExpiresAt: number;
  socket?: string;
}

export type GitMutexIdentity = Pick<GitMutexOwner, 'runId' | 'pid' | 'startIdentity'> & Pick<GitMutexOwner, 'socket'>;

export interface ProjectGitMutexOptions {
  root: string;
  gitCommonDir: string;
  targetBranch: string;
  leaseMs: number;
  pollMs?: number;
}

export class GitMutexError extends Error {
  readonly name = 'GitMutexError';

  constructor(readonly code: 'GIT_MUTEX_BUSY' | 'LEASE_LOST' | 'GIT_MUTEX_OWNER_MISMATCH', message: string) {
    super(message);
  }
}

function lockKey(gitCommonDir: string, targetBranch: string): string {
  return createHash('sha256').update(`${gitCommonDir}\0${targetBranch}`).digest('hex');
}

function sameOwner(left: GitMutexOwner, right: GitMutexOwner): boolean {
  return left.runId === right.runId && left.pid === right.pid && left.startIdentity === right.startIdentity && left.fencingEpoch === right.fencingEpoch;
}

export class ProjectGitMutex {
  private readonly lockPath: string;
  private readonly pollMs: number;

  constructor(private readonly options: ProjectGitMutexOptions) {
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) throw new GitMutexError('GIT_MUTEX_BUSY', 'leaseMs must be positive');
    this.pollMs = options.pollMs ?? 10;
    this.lockPath = join(options.root, '.ai-workflow', 'locks', `${lockKey(options.gitCommonDir, options.targetBranch)}.json`);
  }

  async acquire(identity: GitMutexIdentity, options: { wait?: boolean; timeoutMs?: number } = {}): Promise<GitMutexOwner> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (true) {
      const current = await this.readOwner();
      if (!current || this.expired(current)) {
        const epoch = (current?.fencingEpoch ?? 0) + 1;
        const owner: GitMutexOwner = { ...identity, fencingEpoch: epoch, leaseExpiresAt: Date.now() + this.options.leaseMs };
        if (await this.create(owner) || await this.takeover(current, owner)) return owner;
      }
      if (!options.wait) throw new GitMutexError('GIT_MUTEX_BUSY', `Git mutex is held by ${current?.runId ?? 'another run'}`);
      if (Date.now() >= deadline) throw new GitMutexError('GIT_MUTEX_BUSY', 'timed out waiting for Git mutex');
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  async renew(owner: GitMutexOwner): Promise<GitMutexOwner> {
    const current = await this.readOwner();
    if (!current || !sameOwner(current, owner)) throw new GitMutexError('LEASE_LOST', 'Git mutex fencing epoch or owner identity is stale');
    const renewed = { ...current, leaseExpiresAt: Date.now() + this.options.leaseMs };
    await this.replace(current, renewed);
    return renewed;
  }

  async release(owner: GitMutexOwner): Promise<void> {
    const current = await this.readOwner();
    if (!current || !sameOwner(current, owner)) throw new GitMutexError('GIT_MUTEX_OWNER_MISMATCH', 'only the current Git mutex owner may release');
    await unlink(this.lockPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }

  async withLock<T>(identity: GitMutexIdentity, callback: (owner: GitMutexOwner) => Promise<T> | T): Promise<T>;
  async withLock<T>(owner: GitMutexOwner, callback: (owner: GitMutexOwner) => Promise<T> | T): Promise<T>;
  async withLock<T>(identityOrOwner: GitMutexIdentity | GitMutexOwner, callback: (owner: GitMutexOwner) => Promise<T> | T): Promise<T> {
    if (!('fencingEpoch' in identityOrOwner)) {
      const owner = await this.acquire(identityOrOwner, { wait: true });
      try { return await callback(owner); } finally { await this.release(owner); }
    }
    const owner = identityOrOwner;
    const current = await this.readOwner();
    if (!current || !sameOwner(current, owner) || this.expired(current)) throw new GitMutexError('LEASE_LOST', 'Git mutation rejected by stale Git mutex owner');
    return callback(current);
  }

  private expired(owner: GitMutexOwner): boolean {
    return owner.leaseExpiresAt <= Date.now();
  }

  private async readOwner(): Promise<GitMutexOwner | undefined> {
    try { return JSON.parse(await readFile(this.lockPath, 'utf8')) as GitMutexOwner; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  private async create(owner: GitMutexOwner): Promise<boolean> {
    await mkdir(join(this.options.root, '.ai-workflow', 'locks'), { recursive: true });
    try {
      const handle = await open(this.lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.close();
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  }

  private async takeover(previous: GitMutexOwner | undefined, next: GitMutexOwner): Promise<boolean> {
    if (!previous || !this.expired(previous)) return false;
    const claimPath = `${this.lockPath}.takeover-${previous.fencingEpoch}`;
    let claim;
    try { claim = await open(claimPath, 'wx'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    await claim.close();
    const temporary = `${this.lockPath}.${randomUUID()}.tmp`;
    try {
      await open(temporary, 'w').then(async (handle) => { await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8'); await handle.close(); });
      const current = await this.readOwner();
      if (!current || !sameOwner(current, previous)) return false;
      await rename(temporary, this.lockPath);
      return true;
    } finally {
      await unlink(temporary).catch(() => undefined);
      await unlink(claimPath).catch(() => undefined);
    }
  }

  private async replace(expected: GitMutexOwner, next: GitMutexOwner): Promise<void> {
    const current = await this.readOwner();
    if (!current || !sameOwner(current, expected)) throw new GitMutexError('LEASE_LOST', 'Git mutex changed during renewal');
    const temporary = `${this.lockPath}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'w');
    await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
    await handle.close();
    await rename(temporary, this.lockPath);
  }
}

export class RunGitQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(operation: (owner: GitMutexOwner) => Promise<T> | T, owner: GitMutexOwner): Promise<T> {
    const result = this.tail.then(() => operation(owner));
    this.tail = result.catch(() => undefined);
    return result;
  }
}
