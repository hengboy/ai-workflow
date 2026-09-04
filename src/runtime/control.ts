import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { admitAction, type ActionAdmission, type ActionAdmissionRequest } from '../security/capability.js';
import { ScopeScheduler, type LeaseTerminalState, type ScopeLease } from './scheduler.js';

export interface ReceiptApprovalIdentity {
  osUid: number;
  identityDigest: string;
}

export interface ProcessIdentity {
  pid: number;
  pgid: number;
  startIdentity: string;
  spawnNonce: string;
}

export interface OwnerLeaseRecord {
  leaseVersion: '1.0.0';
  runId: string;
  owner: ReceiptApprovalIdentity;
  process: ProcessIdentity;
  fencingEpoch: number;
  leaseExpiresAt: number;
  socketPath: string;
  status: 'active';
}

export interface OwnerLeaseOptions {
  root: string;
  runId: string;
  owner: ReceiptApprovalIdentity;
  process: ProcessIdentity;
  leaseMs: number;
  socketPath?: string;
  pollMs?: number;
  isProcessAlive?: (identity: ProcessIdentity) => boolean | Promise<boolean>;
}

export interface CancelRequest {
  peerUid: number;
  runId: string;
  fencingEpoch: number;
  nonce: string;
  reason: string;
  identityDigest: string;
  proof: string;
}

export interface CancelIntent {
  cancelVersion: '1.0.0';
  runId: string;
  fencingEpoch: number;
  reason: string;
  reasonDigest: string;
  identityDigest: string;
  requestedByUid: number;
  createdAt: string;
}

export interface CancelAuthority {
  authority_version: '1.0.0';
  run_id: string;
  fencing_epoch: number;
  challenge_nonce: string;
  socket_path: string;
  owner_uid?: number;
  owner_identity_digest?: string;
}

export interface CancelOutcome {
  won: boolean;
  intent: CancelIntent;
}

export class ControlError extends Error {
  readonly name = 'ControlError';

  constructor(readonly code: 'CANCEL_UNAUTHORIZED' | 'CANCEL_CONTROL_STALE' | 'LEASE_LOST' | 'LEASE_BUSY' | 'CLEANUP_OWNERSHIP_UNPROVEN', message: string) {
    super(message);
  }
}

function assertIdentity(identity: ProcessIdentity): void {
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1 || !Number.isSafeInteger(identity.pgid) || identity.pgid < 1 || !identity.startIdentity || !identity.spawnNonce) throw new ControlError('CLEANUP_OWNERSHIP_UNPROVEN', 'process identity is incomplete');
}

function sameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.pgid === right.pgid && left.startIdentity === right.startIdentity && left.spawnNonce === right.spawnNonce;
}

function controlDirectory(root: string, runId: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(runId)) throw new ControlError('CANCEL_UNAUTHORIZED', 'run ID is invalid');
  return join(resolve(root), '.ai-workflow', 'runs', runId, 'control');
}

async function prepareDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM' || path !== '/tmp') throw error;
  });
}

async function writeExclusive(path: string, value: unknown): Promise<boolean> {
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export class OwnerLease {
  private readonly directory: string;
  private readonly ownerPath: string;
  private readonly pollMs: number;

  constructor(private readonly options: OwnerLeaseOptions) {
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) throw new ControlError('LEASE_BUSY', 'leaseMs must be positive');
    assertIdentity(options.process);
    if (!Number.isSafeInteger(options.owner.osUid) || options.owner.osUid < 0 || !options.owner.identityDigest) throw new ControlError('CANCEL_UNAUTHORIZED', 'approval identity is incomplete');
    this.directory = controlDirectory(options.root, options.runId);
    this.ownerPath = join(this.directory, 'owner.json');
    this.pollMs = options.pollMs ?? 10;
  }

  async acquire(options: { wait?: boolean; timeoutMs?: number } = {}): Promise<OwnerLeaseRecord> {
    await prepareDirectory(this.directory);
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (true) {
      const current = await readJson<OwnerLeaseRecord>(this.ownerPath);
      if (!current || await this.canTakeover(current)) {
        const next: OwnerLeaseRecord = {
          leaseVersion: '1.0.0', runId: this.options.runId, owner: this.options.owner, process: this.options.process,
          fencingEpoch: (current?.fencingEpoch ?? 0) + 1, leaseExpiresAt: Date.now() + this.options.leaseMs,
          socketPath: this.options.socketPath ?? join(this.directory, 'cancel.sock'), status: 'active',
        };
        if (await writeExclusive(this.ownerPath, next) || await this.takeover(current, next)) return next;
      }
      if (!options.wait) throw new ControlError('LEASE_BUSY', `run owner is held by ${current?.runId ?? 'another run'}`);
      if (Date.now() >= deadline) throw new ControlError('LEASE_BUSY', 'timed out waiting for run owner lease');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.pollMs));
    }
  }

  async renew(record: OwnerLeaseRecord): Promise<OwnerLeaseRecord> {
    const current = await this.assertCurrent(record);
    const renewed = { ...current, leaseExpiresAt: Date.now() + this.options.leaseMs };
    await this.replace(current, renewed);
    return renewed;
  }

  async release(record: OwnerLeaseRecord): Promise<void> {
    await this.assertCurrent(record);
    await unlink(this.ownerPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }

  async assertCurrent(record: OwnerLeaseRecord): Promise<OwnerLeaseRecord> {
    const current = await readJson<OwnerLeaseRecord>(this.ownerPath);
    if (!current || current.runId !== record.runId || current.fencingEpoch !== record.fencingEpoch || current.owner.identityDigest !== record.owner.identityDigest || !sameProcess(current.process, record.process) || current.leaseExpiresAt <= Date.now()) throw new ControlError('LEASE_LOST', 'owner lease is stale or fenced');
    return current;
  }

  private async canTakeover(current: OwnerLeaseRecord): Promise<boolean> {
    if (current.leaseExpiresAt <= Date.now()) return true;
    if (!this.options.isProcessAlive) return false;
    return !(await this.options.isProcessAlive(current.process));
  }

  private async takeover(previous: OwnerLeaseRecord | undefined, next: OwnerLeaseRecord): Promise<boolean> {
    if (!previous || !(await this.canTakeover(previous))) return false;
    const claimPath = `${this.ownerPath}.takeover-${previous.fencingEpoch}`;
    if (!await writeExclusive(claimPath, { runId: this.options.runId, claim: randomUUID() })) return false;
    const temporary = `${this.ownerPath}.${randomUUID()}.tmp`;
    try {
      const current = await readJson<OwnerLeaseRecord>(this.ownerPath);
      if (!current || current.fencingEpoch !== previous.fencingEpoch || current.runId !== previous.runId) return false;
      await writeExclusive(temporary, next);
      await rename(temporary, this.ownerPath);
      return true;
    } finally {
      await unlink(temporary).catch(() => undefined);
      await unlink(claimPath).catch(() => undefined);
    }
  }

  private async replace(expected: OwnerLeaseRecord, next: OwnerLeaseRecord): Promise<void> {
    const current = await readJson<OwnerLeaseRecord>(this.ownerPath);
    if (!current || current.fencingEpoch !== expected.fencingEpoch || !sameProcess(current.process, expected.process)) throw new ControlError('LEASE_LOST', 'owner lease changed during renewal');
    const temporary = `${this.ownerPath}.${randomUUID()}.tmp`;
    const created = await writeExclusive(temporary, next);
    if (!created) throw new ControlError('LEASE_LOST', 'owner lease temporary record already exists');
    await rename(temporary, this.ownerPath);
  }
}

export function cancelReasonDigest(reason: string): string {
  return `sha256:${createHash('sha256').update(reason).digest('hex')}`;
}

export function cancelProof(nonce: string, runId: string, fencingEpoch: number, reasonDigest: string): string {
  return createHash('sha256').update(`${nonce}\0${runId}\0${fencingEpoch}\0${reasonDigest}`).digest('hex');
}

export class CancelControl {
  private readonly directory: string;
  private readonly cancelPath: string;
  private readonly nonce: string;

  constructor(private readonly options: { root: string; runId: string; owner: ReceiptApprovalIdentity; fencingEpoch: number; nonce?: string; socketPath?: string }) {
    this.directory = controlDirectory(options.root, options.runId);
    this.cancelPath = join(this.directory, 'cancel.json');
    this.nonce = options.nonce ?? randomBytes(32).toString('hex');
  }

  get challengeNonce(): string { return this.nonce; }

  get authority(): CancelAuthority {
    return {
      authority_version: '1.0.0',
      run_id: this.options.runId,
      fencing_epoch: this.options.fencingEpoch,
      challenge_nonce: this.nonce,
      socket_path: this.options.socketPath ?? join(this.directory, 'cancel.sock'),
    };
  }

  async requestCancel(request: CancelRequest): Promise<CancelOutcome> {
    this.authorize(request);
    const intent: CancelIntent = {
      cancelVersion: '1.0.0', runId: this.options.runId, fencingEpoch: this.options.fencingEpoch,
      reason: request.reason, reasonDigest: cancelReasonDigest(request.reason), identityDigest: request.identityDigest,
      requestedByUid: request.peerUid, createdAt: new Date().toISOString(),
    };
    await prepareDirectory(this.directory);
    if (await writeExclusive(this.cancelPath, intent)) return { won: true, intent };
    const existing = await readJson<CancelIntent>(this.cancelPath);
    if (!existing) throw new ControlError('CANCEL_CONTROL_STALE', 'cancel intent disappeared after create-if-absent');
    return { won: false, intent: existing };
  }

  async readIntent(): Promise<CancelIntent | undefined> {
    return readJson<CancelIntent>(this.cancelPath);
  }

  private authorize(request: CancelRequest): void {
    if (request.peerUid !== this.options.owner.osUid || request.identityDigest !== this.options.owner.identityDigest) throw new ControlError('CANCEL_UNAUTHORIZED', 'socket peer is not the receipt identity owner');
    if (request.runId !== this.options.runId || request.fencingEpoch !== this.options.fencingEpoch) throw new ControlError('CANCEL_CONTROL_STALE', 'cancel request run or fencing epoch is stale');
    const digest = cancelReasonDigest(request.reason);
    if (request.nonce !== this.nonce || request.proof !== cancelProof(this.nonce, this.options.runId, this.options.fencingEpoch, digest)) throw new ControlError('CANCEL_UNAUTHORIZED', 'cancel nonce challenge is invalid');
  }
}

export interface CancelSocketOptions {
  socketPath: string;
  peerUid: (socket: Socket) => number | Promise<number>;
  requestCancel?: (request: CancelRequest) => Promise<CancelOutcome>;
}

export class CancelSocket {
  private server?: Server;

  constructor(private readonly control: CancelControl, private readonly options: CancelSocketOptions) {}

  async start(): Promise<void> {
    await prepareDirectory(dirname(this.options.socketPath));
    await unlink(this.options.socketPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolvePromise, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.socketPath, resolvePromise);
    });
    await chmod(this.options.socketPath, 0o600);
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((resolvePromise) => this.server?.close(() => resolvePromise()));
    await unlink(this.options.socketPath).catch(() => undefined);
  }

  private handle(socket: Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const line = buffer.split('\n')[0];
      if (line === undefined || !buffer.includes('\n')) return;
      void this.processLine(socket, line).finally(() => socket.end());
    });
    socket.on('error', () => socket.destroy());
  }

  private async processLine(socket: Socket, line: string): Promise<void> {
    try {
      const peerUid = await this.options.peerUid(socket);
      const request = JSON.parse(line) as Omit<CancelRequest, 'peerUid'>;
      const result = await (this.options.requestCancel ?? ((value: CancelRequest) => this.control.requestCancel(value)))({ ...request, peerUid });
      socket.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      const value = error instanceof ControlError ? { code: error.code, message: error.message } : { code: 'CANCEL_UNAUTHORIZED', message: String(error) };
      socket.write(`${JSON.stringify({ error: value })}\n`);
    }
  }
}

export async function requestCancelSocket(socketPath: string, request: Omit<CancelRequest, 'peerUid'>): Promise<CancelOutcome> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        const value = JSON.parse(response) as { error?: { code?: string; message?: string } } | CancelOutcome;
        if ('error' in value && value.error) throw new ControlError('CANCEL_UNAUTHORIZED', value.error.message ?? 'cancel request rejected');
        resolvePromise(value as CancelOutcome);
      } catch (error) { reject(error); }
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

export interface ReapOptions {
  signal?: (pgid: number, signal: NodeJS.Signals) => void | Promise<void>;
  isAlive: (identity: ProcessIdentity) => boolean | Promise<boolean>;
  observe: () => ProcessIdentity | undefined;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function safeReapProcessGroup(expected: ProcessIdentity, observed: ProcessIdentity | undefined, options: ReapOptions): Promise<'reaped' | 'already-exited'> {
  assertIdentity(expected);
  if (!observed || !sameProcess(expected, observed)) throw new ControlError('CLEANUP_OWNERSHIP_UNPROVEN', 'process identity could not be verified');
  const signal = options.signal ?? ((pgid, value) => process.kill(-pgid, value));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  if (!await options.isAlive(expected)) return 'already-exited';
  await signal(expected.pgid, 'SIGTERM');
  await sleep(options.waitMs ?? 100);
  if (!await options.isAlive(expected)) return 'reaped';
  const latest = options.observe();
  if (!latest || !sameProcess(expected, latest)) throw new ControlError('CLEANUP_OWNERSHIP_UNPROVEN', 'process identity changed before forced reap');
  await signal(expected.pgid, 'SIGKILL');
  await sleep(options.waitMs ?? 100);
  if (await options.isAlive(expected)) throw new ControlError('CLEANUP_OWNERSHIP_UNPROVEN', 'process group did not reap');
  return 'reaped';
}

export interface ControlledActionAdmission {
  admission: ActionAdmission;
  lease: ScopeLease;
}

export interface RunControlOptions {
  ownerLease: OwnerLease;
  owner: OwnerLeaseRecord;
  cancelControl: CancelControl;
  scheduler: ScopeScheduler;
  abortChild?: (lease: ScopeLease, reason: string) => Promise<void> | void;
  reapChild?: (lease: ScopeLease) => Promise<void> | void;
  reconcileChild?: (lease: ScopeLease) => Promise<void> | void;
}

export class RunControl {
  private owner: OwnerLeaseRecord;
  private admissionStopped = false;
  private readonly pending = new Set<string>();
  private readonly admitted = new Map<string, ScopeLease>();

  constructor(private readonly options: RunControlOptions) {
    this.owner = options.owner;
  }

  async renewOwner(): Promise<OwnerLeaseRecord> {
    this.owner = await this.options.ownerLease.renew(this.owner);
    return this.owner;
  }

  async admitAction(request: ActionAdmissionRequest): Promise<ControlledActionAdmission> {
    if (this.admissionStopped || await this.options.cancelControl.readIntent()) throw new ControlError('CANCEL_CONTROL_STALE', 'run cancellation has stopped action admission');
    await this.options.ownerLease.assertCurrent(this.owner);
    const admission = admitAction(request);
    this.pending.add(admission.attempt_id);
    try {
      const lease = await this.options.scheduler.submit({
        admission_id: admission.attempt_id,
        call_ordinal: request.attempt,
        action_id: admission.action.action_id,
        task_id: admission.task.task_id,
        read_scope: admission.action.read_scope,
        write_scope: admission.action.write_scope,
        ...(admission.action.concurrency_group_id === undefined ? {} : { concurrency_group_id: admission.action.concurrency_group_id }),
      });
      if (this.admissionStopped || await this.options.cancelControl.readIntent()) {
        await this.releaseCancelled(lease, 'workflow cancellation won during admission');
        throw new ControlError('CANCEL_CONTROL_STALE', 'run cancellation has stopped action admission');
      }
      await this.options.ownerLease.assertCurrent(this.owner);
      this.admitted.set(lease.admission_id, lease);
      return { admission, lease };
    } finally {
      this.pending.delete(admission.attempt_id);
    }
  }

  async settleAction(lease: ScopeLease, state: LeaseTerminalState, reconcile: () => Promise<void> | void = () => undefined): Promise<void> {
    await this.options.ownerLease.assertCurrent(this.owner);
    await lease.releaseAfterReconcile(state, reconcile);
    this.admitted.delete(lease.admission_id);
  }

  async requestCancel(request: CancelRequest): Promise<CancelOutcome> {
    const outcome = await this.options.cancelControl.requestCancel(request);
    if (!outcome.won) return outcome;
    this.admissionStopped = true;
    for (const admissionId of this.pending) this.options.scheduler.cancel(admissionId);
    await Promise.all([...this.admitted.values()].map((lease) => this.releaseCancelled(lease, outcome.intent.reason)));
    return outcome;
  }

  private async releaseCancelled(lease: ScopeLease, reason: string): Promise<void> {
    await this.options.abortChild?.(lease, reason);
    await this.options.reapChild?.(lease);
    await lease.releaseAfterReconcile('cancelled', () => this.options.reconcileChild?.(lease));
    this.admitted.delete(lease.admission_id);
  }
}
