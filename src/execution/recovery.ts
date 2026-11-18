import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readExecutionOrder } from '../workflow/order.js';
import { readPlan, readTasks } from '../workflow/parse.js';
import { nowCst, toCstTimestamp } from '../workspace/record.js';
import type { ExecutionConfig } from './config.js';
import { DEFAULT_EXECUTION_CONFIG } from './config.js';
import { executionPaths, type ExecutionPaths } from './paths.js';
import { readOrdinaryRecord, type OrdinaryImplementationRecord } from './record.js';
import {
  acquireLock,
  appendEvent,
  attemptCountsFromEvents,
  isProcessAlive,
  readEvents,
  readLatestCheckpoint,
  readLock,
  readRun,
  releaseLock,
  taskStatesForCheckpoint,
  writeCheckpoint,
  writeRun,
} from './store.js';
import type { ExecutionCheckpoint, ExecutionEvent, ExecutionLock, ExecutionRun } from './types.js';
import { validateExecutionRecord } from './validate.js';

/** Lock classification reported by read-only discovery and resume validation. */
export type RunLockState = 'none' | 'held' | 'stale' | 'other-host' | 'unreadable';

/** Compact metadata for one unfinished run, suitable for a phase entry notice. */
export interface UnfinishedRunNotice {
  plan_id: string;
  plan_directory: string;
  run_id: string;
  status: ExecutionRun['status'];
  lock: RunLockState;
  updated_at: string;
}

/** Unfinished runs plus any bounded discovery warnings such as a corrupt run file. */
export interface UnfinishedRunDiscovery {
  runs: UnfinishedRunNotice[];
  warnings: string[];
}

/** Options bounding unfinished-run discovery. */
export interface FindUnfinishedRunsOptions {
  maxPlans?: number;
  host?: string;
}

const DEFAULT_MAX_PLANS = 100;
const UNFINISHED_STATUSES = new Set<ExecutionRun['status']>(['CREATED', 'RUNNING', 'PAUSED', 'INTERRUPTED', 'RESUMING']);

const REASON = {
  digest: 'Execution run plan digest does not match the frozen plan',
  repository: 'Execution run repository does not match the requested repository',
  liveLock: 'Execution lock is held by a live process',
  otherHostLock: 'Execution lock is held by another host',
  missingRecord: 'Implementation record is absent',
  unreadableRecord: 'Implementation record is unreadable',
  unreadableLock: 'Execution lock is unreadable',
  contradictoryTask: (taskId: string): string => `Contradictory task evidence for ${taskId}`,
  noCheckpoint: 'No valid execution checkpoint is available',
  ambiguous: 'Multiple execution runs found; select one with --plan',
  noRun: 'No execution run found for the project',
  invalidRun: 'Execution run is invalid',
  terminalCompleted: 'Execution run is already COMPLETED',
  terminalFailed: 'Execution run is already FAILED',
  terminalCancelled: 'Execution run was CANCELLED',
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function planDirectories(root: string, maxPlans: number): Promise<string[]> {
  const plansRoot = join(resolve(root), '.ai-workflow', 'plans');
  let entries;
  try {
    entries = await readdir(plansRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const limit = Math.max(0, Math.trunc(maxPlans));
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(plansRoot, entry.name))
    .sort()
    .slice(0, limit);
}

async function classifyLock(paths: ExecutionPaths, currentHost: string): Promise<RunLockState> {
  let lock: ExecutionLock | undefined;
  try {
    lock = await readLock(paths);
  } catch {
    return 'unreadable';
  }
  if (lock === undefined) return 'none';
  if (lock.host !== currentHost) return 'other-host';
  return isProcessAlive(lock.pid) ? 'held' : 'stale';
}

/**
 * Discover unfinished runs from their stored metadata only. Discovery is bounded by
 * `maxPlans`, never reads frozen plan documents, and never writes any file.
 */
export async function findUnfinishedRuns(
  root: string,
  options: FindUnfinishedRunsOptions = {},
): Promise<UnfinishedRunDiscovery> {
  const currentHost = options.host ?? hostname();
  const directories = await planDirectories(root, options.maxPlans ?? DEFAULT_MAX_PLANS);
  const runs: UnfinishedRunNotice[] = [];
  const warnings: string[] = [];
  for (const planDirectory of directories) {
    const paths = executionPaths(planDirectory);
    let run: ExecutionRun;
    try {
      run = await readRun(paths);
    } catch (error) {
      if (isMissing(error)) continue;
      warnings.push(`Unable to read the execution run for ${basename(planDirectory)} at ${paths.run}: ${errorMessage(error)}`);
      continue;
    }
    if (!UNFINISHED_STATUSES.has(run.status)) continue;
    runs.push({
      plan_id: run.plan_id,
      plan_directory: planDirectory,
      run_id: run.run_id,
      status: run.status,
      lock: await classifyLock(paths, currentHost),
      updated_at: run.updated_at,
    });
  }
  return { runs, warnings };
}

type RunDocument =
  | { status: 'ok'; run: ExecutionRun }
  | { status: 'missing' }
  | { status: 'invalid'; raw: Record<string, unknown>; error: string }
  | { status: 'unreadable'; error: string };

/** Read the run document without discarding a schema-invalid digest before it can be compared. */
async function readRunDocument(paths: ExecutionPaths): Promise<RunDocument> {
  let source: string;
  try {
    source = await readFile(paths.run, 'utf8');
  } catch (error) {
    return isMissing(error) ? { status: 'missing' } : { status: 'unreadable', error: errorMessage(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return { status: 'unreadable', error: errorMessage(error) };
  }
  const validation = validateExecutionRecord('run', parsed);
  if (validation.valid) return { status: 'ok', run: parsed as ExecutionRun };
  if (isRecord(parsed)) return { status: 'invalid', raw: parsed, error: validation.errors.join('; ') };
  return { status: 'unreadable', error: validation.errors.join('; ') };
}

interface DiscoveredRun {
  planDirectory: string;
  run: ExecutionRun;
}

async function discoverRuns(
  root: string,
  maxPlans: number,
): Promise<{ entries: DiscoveredRun[]; warnings: string[] }> {
  const directories = await planDirectories(root, maxPlans);
  const entries: DiscoveredRun[] = [];
  const warnings: string[] = [];
  for (const planDirectory of directories) {
    const paths = executionPaths(planDirectory);
    try {
      entries.push({ planDirectory, run: await readRun(paths) });
    } catch (error) {
      if (isMissing(error)) continue;
      warnings.push(`Unable to read the execution run for ${basename(planDirectory)} at ${paths.run}: ${errorMessage(error)}`);
    }
  }
  return { entries, warnings };
}

/** One recovery packet body; success carries resume context, refusals carry a stable reason. */
export interface ResumePacket {
  valid: boolean;
  decision: 'resume' | 'manual' | 'refused';
  reason?: string;
  plan_id?: string;
  plan_directory?: string;
  run_id?: string;
  status?: string;
  phase?: string;
  checkpoint?: { checkpoint_id: string; created_at: string };
  agent?: ExecutionRun['agent'];
  completed_tasks?: string[];
  pending_tasks?: string[];
  warnings?: string[];
  reconciled?: boolean;
}

export interface ResumeRunInput {
  planDirectory?: string;
  projectRoot?: string;
  repository?: string;
  host?: string;
  pid?: number;
  ownerId?: string;
  now?: string;
  config?: ExecutionConfig;
}

export interface ResumeRunResult {
  packet: ResumePacket;
  exitCode: number;
}

function packetFor(
  run: ExecutionRun,
  planDirectory: string,
  warnings: string[],
): Pick<ResumePacket, 'plan_id' | 'plan_directory' | 'run_id' | 'status' | 'warnings'> {
  return {
    plan_id: run.plan_id,
    plan_directory: planDirectory,
    run_id: run.run_id,
    status: run.status,
    warnings,
  };
}

function manual(run: ExecutionRun, planDirectory: string, reason: string, warnings: string[]): ResumeRunResult {
  return {
    packet: { valid: false, decision: 'manual', reason, ...packetFor(run, planDirectory, warnings) },
    exitCode: 1,
  };
}

function refused(run: ExecutionRun, planDirectory: string, reason: string, warnings: string[]): ResumeRunResult {
  return {
    packet: { valid: false, decision: 'refused', reason, ...packetFor(run, planDirectory, warnings) },
    exitCode: 1,
  };
}

function terminalReason(status: ExecutionRun['status']): string | undefined {
  if (status === 'COMPLETED') return REASON.terminalCompleted;
  if (status === 'FAILED') return REASON.terminalFailed;
  if (status === 'CANCELLED') return REASON.terminalCancelled;
  return undefined;
}

function taskOrder(run: ExecutionRun, schedule: string[]): string[] {
  const order = [...schedule];
  const seen = new Set(order);
  for (const taskId of Object.keys(run.tasks ?? {})) {
    if (seen.has(taskId)) continue;
    order.push(taskId);
    seen.add(taskId);
  }
  return order;
}

function taskLists(run: ExecutionRun, order: string[]): { completed: string[]; pending: string[] } {
  const completed: string[] = [];
  const pending: string[] = [];
  for (const taskId of order) {
    if (run.tasks?.[taskId]?.status === 'completed') completed.push(taskId);
    else pending.push(taskId);
  }
  return { completed, pending };
}

async function scheduleOrder(planDirectory: string, planId: string): Promise<string[]> {
  try {
    const tasks = await readTasks(planDirectory);
    if (tasks.length === 0) return [];
    const schedule = await readExecutionOrder(planDirectory, planId, tasks);
    return schedule.phases.flatMap((phase) => phase.parallel);
  } catch {
    // A schedule that cannot be read leaves the run's own task keys as the bounded fallback.
    return [];
  }
}

function contradictoryTask(run: ExecutionRun, events: ExecutionEvent[]): string | undefined {
  const completedEvents = new Map<string, { commit?: string; head?: string }>();
  for (const event of events) {
    if (event.type !== 'task.completed' || event.task_id === undefined) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const reference: { commit?: string; head?: string } = {};
    if (typeof payload.commit === 'string') reference.commit = payload.commit;
    if (typeof payload.head === 'string') reference.head = payload.head;
    completedEvents.set(event.task_id, reference);
  }
  for (const [taskId, state] of Object.entries(run.tasks ?? {})) {
    if (state.status !== 'completed') continue;
    const recorded = completedEvents.get(taskId);
    if (recorded === undefined) continue;
    const runReference = state.commit ?? state.head;
    const eventReference = recorded.commit ?? recorded.head;
    if (runReference !== undefined && eventReference !== undefined && runReference !== eventReference) return taskId;
  }
  return undefined;
}

function checkpointFor(
  run: ExecutionRun,
  now: string,
  details: { attemptCounts: Record<string, number>; lastPersistedEventId?: string },
): ExecutionCheckpoint {
  const checkpoint: ExecutionCheckpoint = {
    checkpoint_id: randomUUID(),
    run_id: run.run_id,
    plan_id: run.plan_id,
    plan_digest: run.plan_digest,
    task_states: taskStatesForCheckpoint(run.tasks),
    attempt_counts: details.attemptCounts,
    created_at: now,
  };
  if (run.repository !== undefined) checkpoint.repository = run.repository;
  if (run.phase !== undefined) checkpoint.phase = run.phase;
  if (run.agent !== undefined) checkpoint.agent_binding = run.agent;
  if (details.lastPersistedEventId !== undefined) checkpoint.last_persisted_event_id = details.lastPersistedEventId;
  return checkpoint;
}

async function appendRecoveryEvent(
  paths: ExecutionPaths,
  run: ExecutionRun,
  type: 'execution.interrupted' | 'execution.resumed' | 'execution.reconciled',
  config: ExecutionConfig,
  warnings: string[],
  payload?: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    const event = await appendEvent(
      paths,
      { run_id: run.run_id, plan_id: run.plan_id, type, ...(payload === undefined ? {} : { payload }) },
      config,
    );
    return event.event_id;
  } catch (error) {
    warnings.push(`Unable to record ${type}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function releaseRecoveredLock(paths: ExecutionPaths, warnings: string[]): Promise<void> {
  try {
    await releaseLock(paths);
  } catch (error) {
    warnings.push(`Unable to release the execution lock: ${errorMessage(error)}`);
  }
}

async function successPacket(
  run: ExecutionRun,
  planDirectory: string,
  checkpoint: ExecutionCheckpoint | undefined,
  warnings: string[],
  options: { reconciled?: boolean },
): Promise<ResumeRunResult> {
  const order = taskOrder(run, await scheduleOrder(planDirectory, run.plan_id));
  const { completed, pending } = taskLists(run, order);
  const packet: ResumePacket = {
    valid: true,
    decision: 'resume',
    plan_id: run.plan_id,
    plan_directory: planDirectory,
    run_id: run.run_id,
    status: run.status,
    completed_tasks: completed,
    pending_tasks: pending,
    warnings,
  };
  if (run.phase !== undefined) packet.phase = run.phase;
  if (checkpoint !== undefined) packet.checkpoint = { checkpoint_id: checkpoint.checkpoint_id, created_at: checkpoint.created_at };
  if (run.agent !== undefined) packet.agent = run.agent;
  if (options.reconciled === true) packet.reconciled = true;
  return { packet, exitCode: 0 };
}

/**
 * Resolve and validate an explicit resume request. The authoritative implementation record,
 * the frozen plan identity, task evidence, the newest valid checkpoint and the lock owner are
 * checked before any state change; manual refusals write nothing.
 */
export async function resumeRun(input: ResumeRunInput): Promise<ResumeRunResult> {
  const warnings: string[] = [];
  const config = input.config ?? DEFAULT_EXECUTION_CONFIG;
  const currentHost = input.host ?? hostname();
  const now = toCstTimestamp(input.now, nowCst());

  let planDirectory: string;
  if (input.planDirectory !== undefined) {
    planDirectory = resolve(input.planDirectory);
  } else {
    const root = resolve(input.projectRoot ?? process.cwd());
    const discovery = await discoverRuns(root, DEFAULT_MAX_PLANS);
    warnings.push(...discovery.warnings);
    if (discovery.entries.length === 0) {
      return {
        packet: { valid: false, decision: 'manual', reason: REASON.noRun, warnings },
        exitCode: 1,
      };
    }
    if (discovery.entries.length > 1) {
      return {
        packet: { valid: false, decision: 'manual', reason: REASON.ambiguous, warnings },
        exitCode: 1,
      };
    }
    const only = discovery.entries[0];
    if (only === undefined) {
      return { packet: { valid: false, decision: 'manual', reason: REASON.noRun, warnings }, exitCode: 1 };
    }
    planDirectory = only.planDirectory;
  }

  const paths = executionPaths(planDirectory);
  const document = await readRunDocument(paths);

  if (document.status === 'missing') {
    return { packet: { valid: false, decision: 'manual', reason: REASON.noRun, warnings }, exitCode: 1 };
  }
  if (document.status === 'unreadable') {
    return {
      packet: { valid: false, decision: 'manual', reason: REASON.invalidRun, plan_directory: planDirectory, warnings: [...warnings, document.error] },
      exitCode: 1,
    };
  }
  if (document.status === 'invalid') {
    const rawRunId = typeof document.raw.run_id === 'string' ? document.raw.run_id : undefined;
    let planDigest: string | undefined;
    try {
      planDigest = (await readPlan(planDirectory)).digest;
    } catch {
      planDigest = undefined;
    }
    const declaredDigest = typeof document.raw.plan_digest === 'string' ? document.raw.plan_digest : undefined;
    const digestMismatch = planDigest !== undefined && declaredDigest !== undefined && declaredDigest !== planDigest;
    const reason = digestMismatch ? REASON.digest : REASON.invalidRun;
    const packet: ResumePacket = { valid: false, decision: 'manual', reason, plan_directory: planDirectory, warnings };
    if (rawRunId !== undefined) packet.run_id = rawRunId;
    if (typeof document.raw.plan_id === 'string') packet.plan_id = document.raw.plan_id;
    if (typeof document.raw.status === 'string') packet.status = document.raw.status;
    return { packet, exitCode: 1 };
  }

  const run = document.run;

  const terminal = terminalReason(run.status);
  if (terminal !== undefined) return refused(run, planDirectory, terminal, warnings);

  let plan;
  try {
    plan = await readPlan(planDirectory);
  } catch (error) {
    return manual(run, planDirectory, errorMessage(error), warnings);
  }
  if (run.plan_digest !== plan.digest || run.plan_id !== plan.planId) {
    return manual(run, planDirectory, REASON.digest, warnings);
  }

  if (input.repository !== undefined && run.repository !== input.repository) {
    return manual(run, planDirectory, REASON.repository, warnings);
  }

  const recordPath = join(planDirectory, 'implementation.yaml');
  let record: OrdinaryImplementationRecord | undefined;
  try {
    record = await readOrdinaryRecord(recordPath, run.plan_id);
  } catch (error) {
    return manual(run, planDirectory, `${REASON.unreadableRecord}: ${errorMessage(error)}`, warnings);
  }
  if (record === undefined) return manual(run, planDirectory, REASON.missingRecord, warnings);

  const events = await readEvents(paths);
  warnings.push(...events.warnings);
  const contradiction = contradictoryTask(run, events.events);
  if (contradiction !== undefined) return manual(run, planDirectory, REASON.contradictoryTask(contradiction), warnings);

  const checkpointResult = await readLatestCheckpoint(paths);
  warnings.push(...checkpointResult.warnings);
  if (checkpointResult.status !== 'ok') return manual(run, planDirectory, REASON.noCheckpoint, warnings);

  let lock: ExecutionLock | undefined;
  try {
    lock = await readLock(paths);
  } catch (error) {
    return manual(run, planDirectory, `${REASON.unreadableLock}: ${errorMessage(error)}`, warnings);
  }
  let staleLock = false;
  if (lock !== undefined) {
    if (lock.host !== currentHost) return manual(run, planDirectory, REASON.otherHostLock, warnings);
    if (isProcessAlive(lock.pid)) return manual(run, planDirectory, REASON.liveLock, warnings);
    staleLock = true;
  }

  if (record.status === 'completed') {
    const reconciled: ExecutionRun = {
      ...run,
      status: 'COMPLETED',
      updated_at: now,
      completed_at: toCstTimestamp(record.completed_at, now),
    };
    if (reconciled.started_at === undefined && record.started_at !== undefined) {
      reconciled.started_at = toCstTimestamp(record.started_at, now);
    }
    try {
      await writeRun(paths, reconciled);
    } catch (error) {
      return manual(run, planDirectory, errorMessage(error), warnings);
    }
    await appendRecoveryEvent(paths, reconciled, 'execution.reconciled', config, warnings, {
      payload: { record_status: 'completed' },
    });
    await releaseRecoveredLock(paths, warnings);
    return await successPacket(reconciled, planDirectory, undefined, warnings, { reconciled: true });
  }

  const acquisition = await acquireLock(paths, {
    command: 'execution resume',
    ...(input.ownerId === undefined ? {} : { owner_id: input.ownerId }),
    host: currentHost,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    acquired_at: now,
  });
  if (!acquisition.acquired) {
    const reason = acquisition.reason === 'other-host'
      ? REASON.otherHostLock
      : acquisition.reason === 'live'
        ? REASON.liveLock
        : REASON.unreadableLock;
    return manual(run, planDirectory, reason, warnings);
  }

  const resumed: ExecutionRun = { ...run, status: 'RUNNING', updated_at: now };
  let lastEventId: string | undefined;
  if (staleLock && run.status === 'RUNNING') {
    lastEventId = await appendRecoveryEvent(paths, resumed, 'execution.interrupted', config, warnings, {
      payload: { reason: 'stale lock' },
    });
  }
  try {
    await writeRun(paths, resumed);
  } catch (error) {
    warnings.push(`Unable to write the execution run: ${errorMessage(error)}`);
  }
  const resumedEventId = await appendRecoveryEvent(paths, resumed, 'execution.resumed', config, warnings);
  if (resumedEventId !== undefined) lastEventId = resumedEventId;

  // Checkpoints sort by their recorded creation time, so a resume checkpoint uses the real
  // write time rather than a caller-supplied logical clock and stays the newest record.
  const checkpoint = checkpointFor(resumed, nowCst(), {
    attemptCounts: attemptCountsFromEvents(events.events),
    ...(lastEventId === undefined ? {} : { lastPersistedEventId: lastEventId }),
  });
  try {
    await writeCheckpoint(paths, checkpoint, config);
  } catch (error) {
    warnings.push(`Unable to write an execution checkpoint: ${errorMessage(error)}`);
    return await successPacket(resumed, planDirectory, undefined, warnings, {});
  }
  return await successPacket(resumed, planDirectory, checkpoint, warnings, {});
}
