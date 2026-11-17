import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdown } from '../utils/frontmatter.js';
import { appendFsync, atomicWrite } from '../utils/fs.js';
import { readExecutionOrder } from '../workflow/order.js';
import { readPlan, readTasks } from '../workflow/parse.js';
import type { TaskDocument, TaskPhase, TaskSchedule } from '../workflow/types.js';
import { nowCst } from '../workspace/record.js';
import type { ExecutionConfig } from './config.js';
import { DEFAULT_EXECUTION_CONFIG } from './config.js';
import { classifyFailure, redactFailureSummary, type FailureGuidance } from './failure.js';
import type { ExecutionPaths } from './paths.js';
import { executionPaths } from './paths.js';
import type { OrdinaryImplementationRecord } from './record.js';
import { readOrdinaryRecord, writeOrdinaryRecord } from './record.js';
import { acquireLock, readRun, releaseLock, writeCheckpoint } from './store.js';
import type {
  ExecutionCheckpoint,
  ExecutionEvent,
  ExecutionEventType,
  ExecutionRun,
  FailureCategory,
  RunStatus,
} from './types.js';
import { FAILURE_CATEGORIES } from './types.js';
import { assertExecutionRecord, validateExecutionRecord } from './validate.js';

type TaskState = NonNullable<ExecutionRun['tasks']>[string];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function assertSha(value: string, label: string): void {
  if (!FULL_SHA.test(value)) {
    throw new Error(`Invalid ${label}: expected a full lowercase 40- or 64-hex commit SHA`);
  }
}

function isTerminal(status: RunStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

function toUtcTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

/** Return the run as read, with the authoritative record's start time for externally visible views. */
function withAuthoritativeStart(run: ExecutionRun, startedAt: string | undefined): ExecutionRun {
  return startedAt === undefined ? run : { ...run, started_at: startedAt };
}

function failureEventType(category: FailureCategory): ExecutionEventType {
  return `failure.${category}`;
}

interface PlanMeta {
  planId: string;
  digest: string;
  createdAt: string;
}

async function readPlanMeta(planDirectory: string): Promise<PlanMeta> {
  const plan = await readPlan(planDirectory);
  const { attributes } = parseMarkdown(await readFile(join(planDirectory, 'plan.md'), 'utf8'));
  if (typeof attributes.created_at !== 'string' || attributes.created_at.length === 0) {
    throw new Error('Frozen plan.md is missing a created_at timestamp');
  }
  return { planId: plan.planId, digest: plan.digest, createdAt: attributes.created_at };
}

/** Read the run document, treating an absent or unreadable overlay as recoverable telemetry state. */
async function loadRun(paths: ExecutionPaths, warnings: string[]): Promise<ExecutionRun | undefined> {
  try {
    return await readRun(paths);
  } catch (error) {
    if (isMissing(error)) return undefined;
    warnings.push(`Unable to read the execution run: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * Persist the run without requiring the checkpoint directory, so a broken checkpoint area never
 * blocks the authoritative overlay update that the caller already computed.
 */
async function persistRun(paths: ExecutionPaths, run: ExecutionRun, warnings: string[]): Promise<void> {
  try {
    assertExecutionRecord('run', run, paths.run);
    await atomicWrite(paths.run, `${JSON.stringify(run, null, 2)}\n`);
  } catch (error) {
    warnings.push(`Unable to write the execution run: ${errorMessage(error)}`);
  }
}

async function needsLeadingNewline(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (info.size === 0) return false;
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, info.size - 1);
    return (buffer[0] ?? 0) !== 0x0a;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

/** Append one event as a single fsynced JSONL line, reporting any telemetry failure as a warning. */
async function appendEventSafe(
  paths: ExecutionPaths,
  run: ExecutionRun,
  type: ExecutionEventType,
  config: ExecutionConfig,
  warnings: string[],
  options: { taskId?: string; payload?: Record<string, unknown> } = {},
): Promise<void> {
  const event: ExecutionEvent = {
    event_id: randomUUID(),
    run_id: run.run_id,
    plan_id: run.plan_id,
    type,
    timestamp: new Date().toISOString(),
  };
  if (options.taskId !== undefined) event.task_id = options.taskId;
  if (options.payload !== undefined) event.payload = options.payload;

  const validation = validateExecutionRecord('event', event);
  if (!validation.valid) {
    warnings.push(`Unable to record ${type}: ${validation.errors.join('; ')}`);
    return;
  }
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, 'utf8') > config.maxEventLineBytes) {
    warnings.push(`Unable to record ${type}: event exceeds the ${config.maxEventLineBytes}-byte limit`);
    return;
  }
  try {
    const prefix = (await needsLeadingNewline(paths.events)) ? '\n' : '';
    await appendFsync(paths.events, `${prefix}${serialized}\n`);
  } catch (error) {
    warnings.push(`Unable to record ${type}: ${errorMessage(error)}`);
  }
}

function taskStatesForCheckpoint(tasks: ExecutionRun['tasks']): ExecutionCheckpoint['task_states'] {
  const states: ExecutionCheckpoint['task_states'] = {};
  for (const [taskId, state] of Object.entries(tasks ?? {})) {
    const copy: ExecutionCheckpoint['task_states'][string] = { status: state.status };
    if (state.commit !== undefined) copy.commit = state.commit;
    if (state.head !== undefined) copy.head = state.head;
    states[taskId] = copy;
  }
  return states;
}

async function persistCheckpoint(
  paths: ExecutionPaths,
  run: ExecutionRun,
  config: ExecutionConfig,
  warnings: string[],
): Promise<void> {
  const checkpoint: ExecutionCheckpoint = {
    checkpoint_id: randomUUID(),
    run_id: run.run_id,
    plan_id: run.plan_id,
    plan_digest: run.plan_digest,
    task_states: taskStatesForCheckpoint(run.tasks),
    attempt_counts: {},
    created_at: new Date().toISOString(),
  };
  if (run.repository !== undefined) checkpoint.repository = run.repository;
  if (run.phase !== undefined) checkpoint.phase = run.phase;
  if (run.agent !== undefined) checkpoint.agent_binding = run.agent;
  try {
    await writeCheckpoint(paths, checkpoint, config);
  } catch (error) {
    warnings.push(`Unable to write an execution checkpoint: ${errorMessage(error)}`);
  }
}

async function takeLock(paths: ExecutionPaths, command: string, warnings: string[]): Promise<void> {
  let acquisition: Awaited<ReturnType<typeof acquireLock>>;
  try {
    acquisition = await acquireLock(paths, { command });
  } catch (error) {
    warnings.push(`Unable to acquire the execution lock: ${errorMessage(error)}`);
    return;
  }
  if (!acquisition.acquired) throw new Error(`Execution lock unavailable: ${acquisition.reason}`);
}

async function dropLock(paths: ExecutionPaths, warnings: string[]): Promise<void> {
  try {
    await releaseLock(paths);
  } catch (error) {
    warnings.push(`Unable to release the execution lock: ${errorMessage(error)}`);
  }
}

function phaseIndex(phase: string | undefined, phaseCount: number): number {
  const parsed = Number(phase);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= phaseCount) return parsed - 1;
  return 0;
}

function deriveInitialTasks(
  schedule: TaskSchedule | undefined,
  existing: ExecutionRun['tasks'],
  existingPhase: string | undefined,
): { states: ExecutionRun['tasks']; opened: string[] } {
  if (schedule === undefined) return { states: existing, opened: [] };
  const nowIso = new Date().toISOString();
  const current = phaseIndex(existingPhase, schedule.phases.length);
  const states: Record<string, TaskState> = {};
  const opened: string[] = [];
  schedule.phases.forEach((phase: TaskPhase, index: number) => {
    for (const taskId of phase.parallel) {
      const prior = existing?.[taskId];
      if (prior && prior.status !== 'pending') {
        states[taskId] = prior;
        continue;
      }
      if (index <= current) {
        states[taskId] = { status: 'running', started_at: nowIso };
        opened.push(taskId);
      } else {
        states[taskId] = { status: 'pending' };
      }
    }
  });
  return { states, opened };
}

/** Input accepted by the start transition. */
export interface StartRunInput {
  planDirectory: string;
  config?: ExecutionConfig;
}

/** Outcome of starting or adopting one repository run. */
export interface StartRunResult {
  adopted: boolean;
  run: ExecutionRun;
  tasks: TaskDocument[];
  warnings: string[];
}

/**
 * Start a repository run: adopt an existing CREATED run, write the authoritative in-progress record
 * before the first step, open the first scheduled phase, and record the start checkpoint. Telemetry
 * failures are collected as warnings while the authoritative record still advances.
 */
export async function startRun(input: StartRunInput): Promise<StartRunResult> {
  const config = input.config ?? DEFAULT_EXECUTION_CONFIG;
  const paths = executionPaths(input.planDirectory);
  const warnings: string[] = [];
  const meta = await readPlanMeta(input.planDirectory);
  const tasks = await readTasks(input.planDirectory);
  const schedule = tasks.length > 0 ? await readExecutionOrder(input.planDirectory, meta.planId, tasks) : undefined;

  const existing = await loadRun(paths, warnings);
  if (existing) {
    if (existing.plan_id !== meta.planId || existing.plan_digest !== meta.digest) {
      throw new Error('Existing execution run contradicts the frozen plan identity');
    }
    if (existing.status !== 'CREATED') {
      throw new Error(`Cannot start a run that is already ${existing.status}`);
    }
  }

  const recordPath = join(input.planDirectory, 'implementation.yaml');
  const priorRecord = await readOrdinaryRecord(recordPath, meta.planId);
  if (priorRecord?.status === 'completed') {
    throw new Error('Cannot start a plan whose implementation record is already completed');
  }

  await takeLock(paths, 'execution start', warnings);

  const nowIso = new Date().toISOString();
  const startedAt = priorRecord?.started_at ?? nowCst();
  const record: OrdinaryImplementationRecord = {
    plan_id: meta.planId,
    status: 'in-progress',
    started_at: startedAt,
  };
  await writeOrdinaryRecord(recordPath, record);

  const derived = deriveInitialTasks(schedule, existing?.tasks, existing?.phase);
  const run: ExecutionRun = {
    run_id: existing?.run_id ?? randomUUID(),
    plan_id: meta.planId,
    plan_digest: meta.digest,
    status: 'RUNNING',
    plan_created_at: existing?.plan_created_at ?? meta.createdAt,
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
    failure_count: existing?.failure_count ?? 0,
    started_at: existing?.started_at ?? nowIso,
  };
  if (existing?.repository !== undefined) run.repository = existing.repository;
  if (existing?.last_failure !== undefined) run.last_failure = existing.last_failure;
  const phase = existing?.phase ?? (schedule === undefined ? undefined : '1');
  if (phase !== undefined) run.phase = phase;
  if (derived.states !== undefined) run.tasks = derived.states;

  await persistRun(paths, run, warnings);
  await appendEventSafe(paths, run, 'workflow.started', config, warnings);
  for (const taskId of derived.opened) {
    await appendEventSafe(paths, run, 'task.started', config, warnings, { taskId });
  }
  await persistCheckpoint(paths, run, config, warnings);

  return { adopted: existing !== undefined, run, tasks, warnings };
}

/** Input accepted by the task-completion transition. */
export interface RecordTaskInput {
  planDirectory: string;
  taskId: string;
  commit?: string;
  head?: string;
  config?: ExecutionConfig;
}

/** Outcome of recording one task, including any next-phase tasks opened by its completion. */
export interface RecordTaskResult {
  idempotent: boolean;
  openedPhase: string[];
  run: ExecutionRun;
  warnings: string[];
}

/**
 * Record a running task as completed and, when that completes a phase, open every task of the next
 * scheduled phase. A repeated identical record is idempotent; a different record is a contradiction.
 */
export async function recordTask(input: RecordTaskInput): Promise<RecordTaskResult> {
  const config = input.config ?? DEFAULT_EXECUTION_CONFIG;
  const paths = executionPaths(input.planDirectory);
  const warnings: string[] = [];
  const run = await readRun(paths);
  if (run.status !== 'RUNNING') throw new Error(`Cannot record a task for a ${run.status} run`);
  if (!run.tasks || !(input.taskId in run.tasks)) throw new Error(`Unknown task: ${input.taskId}`);

  const hasCommit = input.commit !== undefined;
  const hasHead = input.head !== undefined;
  if (hasCommit === hasHead) throw new Error('Specify exactly one of commit or head');
  const reference = hasCommit ? input.commit : input.head;
  if (reference === undefined) throw new Error('Specify exactly one of commit or head');
  assertSha(reference, hasCommit ? 'commit' : 'head');

  const current = run.tasks[input.taskId];
  if (current === undefined) throw new Error(`Unknown task: ${input.taskId}`);

  if (current.status === 'completed') {
    const matches = hasCommit ? current.commit === input.commit : current.head === input.head;
    if (!matches) throw new Error(`Task ${input.taskId} is already completed with a different reference`);
    return { idempotent: true, openedPhase: [], run, warnings };
  }
  if (current.status !== 'running') throw new Error(`Task ${input.taskId} is not running`);

  const nowIso = new Date().toISOString();
  const completed: TaskState = { ...current, status: 'completed', completed_at: nowIso };
  if (hasCommit) completed.commit = reference;
  else completed.head = reference;
  const tasks: Record<string, TaskState> = { ...run.tasks, [input.taskId]: completed };

  let phase = run.phase;
  const opened: string[] = [];
  const meta = await readPlanMeta(input.planDirectory);
  const documents = await readTasks(input.planDirectory);
  const schedule = await readExecutionOrder(input.planDirectory, meta.planId, documents);
  const index = phaseIndex(phase, schedule.phases.length);
  const currentPhase = schedule.phases[index];
  if (currentPhase && currentPhase.parallel.every((taskId) => tasks[taskId]?.status === 'completed')) {
    const nextPhase = schedule.phases[index + 1];
    if (nextPhase) {
      phase = String(index + 2);
      for (const taskId of nextPhase.parallel) {
        const state = tasks[taskId];
        if (state === undefined || state.status === 'pending') {
          tasks[taskId] = { status: 'running', started_at: nowIso };
          opened.push(taskId);
        }
      }
    }
  }

  const updated: ExecutionRun = { ...run, tasks, updated_at: nowIso };
  if (phase !== undefined) updated.phase = phase;

  await persistRun(paths, updated, warnings);
  await appendEventSafe(paths, updated, 'task.completed', config, warnings, {
    taskId: input.taskId,
    payload: hasCommit ? { commit: reference } : { head: reference },
  });
  for (const taskId of opened) {
    await appendEventSafe(paths, updated, 'task.started', config, warnings, { taskId });
  }
  await persistCheckpoint(paths, updated, config, warnings);

  return { idempotent: false, openedPhase: opened, run: updated, warnings };
}

/** Input accepted by the completion transition. */
export interface CompleteRunInput {
  planDirectory: string;
  commit: string;
  config?: ExecutionConfig;
}

/** Outcome of completing a run or recovering a completed authoritative record. */
export interface CompleteRunResult {
  recovered: boolean;
  run: ExecutionRun;
  warnings: string[];
}

/**
 * Complete a running run, or adopt a completed authoritative record that predates telemetry. The
 * record keeps its original start time, and a repeated completion for the same commit is idempotent.
 */
export async function completeRun(input: CompleteRunInput): Promise<CompleteRunResult> {
  const config = input.config ?? DEFAULT_EXECUTION_CONFIG;
  const paths = executionPaths(input.planDirectory);
  const warnings: string[] = [];
  assertSha(input.commit, 'commit');
  const meta = await readPlanMeta(input.planDirectory);
  const recordPath = join(input.planDirectory, 'implementation.yaml');
  const record = await readOrdinaryRecord(recordPath, meta.planId);
  const existing = await loadRun(paths, warnings);

  if (existing?.status === 'COMPLETED') {
    if (record?.status !== 'completed' || record.commit !== input.commit) {
      throw new Error('Execution run is already completed with a different commit');
    }
    return { recovered: false, run: withAuthoritativeStart(existing, record.started_at), warnings };
  }

  if (record?.status === 'completed') {
    if (record.commit !== input.commit) {
      throw new Error('The completed implementation record carries a different commit');
    }
    const nowIso = new Date().toISOString();
    const run: ExecutionRun = existing
      ? {
          ...existing,
          status: 'COMPLETED',
          updated_at: nowIso,
          completed_at: toUtcTimestamp(record.completed_at, nowIso),
        }
      : {
          run_id: randomUUID(),
          plan_id: meta.planId,
          plan_digest: meta.digest,
          status: 'COMPLETED',
          plan_created_at: meta.createdAt,
          created_at: nowIso,
          updated_at: nowIso,
          failure_count: 0,
          completed_at: toUtcTimestamp(record.completed_at, nowIso),
        };
    if (record.started_at !== undefined) {
      run.started_at = toUtcTimestamp(record.started_at, nowIso);
    }
    await persistRun(paths, run, warnings);
    await appendEventSafe(paths, run, 'workflow.completed', config, warnings);
    await persistCheckpoint(paths, run, config, warnings);
    await dropLock(paths, warnings);
    return { recovered: true, run: withAuthoritativeStart(run, record.started_at), warnings };
  }

  if (!existing) throw new Error('No execution run to complete');
  if (existing.status !== 'RUNNING') throw new Error(`Cannot complete a ${existing.status} run`);

  const nowIso = new Date().toISOString();
  const run: ExecutionRun = { ...existing, status: 'COMPLETED', updated_at: nowIso, completed_at: nowIso };
  const completed: OrdinaryImplementationRecord = {
    plan_id: meta.planId,
    status: 'completed',
    completed_at: nowCst(),
    commit: input.commit,
  };
  if (record?.started_at !== undefined) completed.started_at = record.started_at;
  await writeOrdinaryRecord(recordPath, completed);
  await persistRun(paths, run, warnings);
  await appendEventSafe(paths, run, 'workflow.completed', config, warnings);
  await persistCheckpoint(paths, run, config, warnings);
  await dropLock(paths, warnings);

  return { recovered: false, run: withAuthoritativeStart(run, completed.started_at), warnings };
}

/** Shared input for pause, cancel and failure transitions. */
export interface RunTransitionInput {
  planDirectory: string;
  summary?: string;
  config?: ExecutionConfig;
}

/** Outcome of a run transition. */
export interface RunTransitionResult {
  run: ExecutionRun;
  warnings: string[];
}

function summaryPayload(summary: string | undefined): Record<string, unknown> | undefined {
  return summary === undefined ? undefined : { summary: redactFailureSummary(summary) };
}

/** Pause a running run: record the interruption and pause events, checkpoint, and release the lock. */
export async function pauseRun(input: RunTransitionInput): Promise<RunTransitionResult> {
  const config = input.config ?? DEFAULT_EXECUTION_CONFIG;
  const paths = executionPaths(input.planDirectory);
  const warnings: string[] = [];
  const existing = await loadRun(paths, warnings);
  if (!existing) throw new Error('No execution run to pause');
  if (existing.status !== 'RUNNING') throw new Error(`Cannot pause a ${existing.status} run`);

  const run: ExecutionRun = { ...existing, status: 'PAUSED', updated_at: new Date().toISOString() };
  const payload = summaryPayload(input.summary);
  await persistRun(paths, run, warnings);
  await appendEventSafe(paths, run, 'execution.interrupted', config, warnings, payload === undefined ? {} : { payload });
  await appendEventSafe(paths, run, 'workflow.paused', config, warnings, payload === undefined ? {} : { payload });
  await persistCheckpoint(paths, run, config, warnings);
  await dropLock(paths, warnings);
  return { run, warnings };
}

/** Cancel a non-terminal run and release its lock. */
export async function cancelRun(input: RunTransitionInput): Promise<RunTransitionResult> {
  const config = input.config ?? DEFAULT_EXECUTION_CONFIG;
  const paths = executionPaths(input.planDirectory);
  const warnings: string[] = [];
  const existing = await loadRun(paths, warnings);
  if (!existing) throw new Error('No execution run to cancel');
  if (isTerminal(existing.status)) throw new Error(`Cannot cancel a ${existing.status} run`);

  const run: ExecutionRun = { ...existing, status: 'CANCELLED', updated_at: new Date().toISOString() };
  const payload = summaryPayload(input.summary);
  await persistRun(paths, run, warnings);
  await appendEventSafe(paths, run, 'workflow.cancelled', config, warnings, payload === undefined ? {} : { payload });
  await persistCheckpoint(paths, run, config, warnings);
  await dropLock(paths, warnings);
  return { run, warnings };
}

/** Input accepted by the terminal failure transition. */
export interface FailRunInput {
  planDirectory: string;
  category: FailureCategory;
  summary?: string;
  config?: ExecutionConfig;
}

/** Fail a non-terminal run terminally, recording the failure and workflow events before releasing the lock. */
export async function failRun(input: FailRunInput): Promise<RunTransitionResult> {
  const config = input.config ?? DEFAULT_EXECUTION_CONFIG;
  if (!FAILURE_CATEGORIES.includes(input.category)) throw new Error(`Unknown failure category: ${String(input.category)}`);
  const paths = executionPaths(input.planDirectory);
  const warnings: string[] = [];
  const existing = await loadRun(paths, warnings);
  if (!existing) throw new Error('No execution run to fail');
  if (isTerminal(existing.status)) throw new Error(`Cannot fail a ${existing.status} run`);

  const nowIso = new Date().toISOString();
  const summary = redactFailureSummary(input.summary ?? '');
  const guidance = classifyFailure(input.category, existing.failure_count + 1, config);
  const run: ExecutionRun = {
    ...existing,
    status: 'FAILED',
    updated_at: nowIso,
    failure_count: existing.failure_count + 1,
    last_failure: { category: input.category, action: guidance.action, summary, recorded_at: nowIso },
  };
  const payload = summaryPayload(input.summary);
  await persistRun(paths, run, warnings);
  await appendEventSafe(paths, run, failureEventType(input.category), config, warnings, payload === undefined ? {} : { payload });
  await appendEventSafe(paths, run, 'workflow.failed', config, warnings, payload === undefined ? {} : { payload });
  await persistCheckpoint(paths, run, config, warnings);
  await dropLock(paths, warnings);
  return { run, warnings };
}

/** One lifecycle event mapped from a workspace checkpoint into repository-local telemetry. */
export interface WorkspaceTelemetryEvent {
  type: 'start' | 'task' | 'reviewed' | 'delivered' | 'finalized';
  purpose?: 'tasks' | 'finalization';
  taskId?: string;
  commit?: string;
  head?: string;
  validation?: string;
  repair?: string;
}

/** Everything the workspace observer needs to update exactly one repository slice's run. */
export interface WorkspaceTelemetryInput {
  planDirectory: string;
  repository: string;
  planId: string;
  planDigest: string;
  planCreatedAt: string;
  tasks: { id: string; repository: string }[];
  phases: string[][];
  globalPhase: number | null;
  event: WorkspaceTelemetryEvent;
}

/** Local task ids of one repository in one one-based global phase. */
function localTasksInPhase(input: WorkspaceTelemetryInput, phase: number): string[] {
  const repository = new Map(input.tasks.map((task) => [task.id, task.repository]));
  return (input.phases[phase - 1] ?? []).filter((id) => repository.get(id) === input.repository);
}

/** Every local task id paired with its one-based global phase. */
function localTaskPhases(input: WorkspaceTelemetryInput): { id: string; phase: number }[] {
  const repository = new Map(input.tasks.map((task) => [task.id, task.repository]));
  const entries: { id: string; phase: number }[] = [];
  input.phases.forEach((phase, index) => {
    for (const id of phase) if (repository.get(id) === input.repository) entries.push({ id, phase: index + 1 });
  });
  return entries;
}

/**
 * Mirror one successful workspace checkpoint into the local repository's execution run. The run,
 * events and checkpoints live only beside that repository's authoritative record. The per-update
 * lock serializes concurrent writers and is always released before returning, so a completed run
 * leaves no lock behind. Every telemetry problem is reported as a warning and never thrown.
 */
export async function recordWorkspaceCheckpoint(input: WorkspaceTelemetryInput): Promise<string[]> {
  const warnings: string[] = [];
  const paths = executionPaths(input.planDirectory);
  const config = DEFAULT_EXECUTION_CONFIG;
  const nowIso = new Date().toISOString();

  try {
    const acquisition = await acquireLock(paths, { command: 'workspace checkpoint' });
    if (!acquisition.acquired) {
      warnings.push(`Unable to acquire the execution lock: ${acquisition.reason}`);
      return warnings;
    }
    try {
      const existing = await loadRun(paths, warnings);
      if (existing !== undefined && (existing.plan_id !== input.planId || existing.plan_digest !== input.planDigest)) {
        warnings.push('Existing execution run contradicts the frozen plan identity');
        return warnings;
      }

      if (input.event.type === 'start') {
        // A repeated identical start is already recorded, so it stays byte-idempotent.
        if (existing !== undefined) return warnings;
        const purpose = input.event.purpose ?? 'tasks';
        const currentPhase = input.globalPhase ?? 1;
        const run: ExecutionRun = {
          run_id: randomUUID(),
          plan_id: input.planId,
          plan_digest: input.planDigest,
          status: 'RUNNING',
          plan_created_at: input.planCreatedAt,
          created_at: nowIso,
          updated_at: nowIso,
          started_at: nowIso,
          failure_count: 0,
          repository: input.repository,
        };
        const local = localTaskPhases(input);
        if (purpose === 'tasks') {
          run.phase = String(currentPhase);
          if (local.length > 0) {
            const states: Record<string, TaskState> = {};
            for (const entry of local) {
              states[entry.id] = entry.phase <= currentPhase
                ? { status: 'running', started_at: nowIso }
                : { status: 'pending' };
            }
            run.tasks = states;
          }
        }
        await persistRun(paths, run, warnings);
        await appendEventSafe(paths, run, 'workflow.started', config, warnings);
        if (purpose === 'tasks') {
          for (const taskId of localTasksInPhase(input, currentPhase)) {
            await appendEventSafe(paths, run, 'task.started', config, warnings, { taskId });
          }
        }
        await persistCheckpoint(paths, run, config, warnings);
        return warnings;
      }

      if (existing === undefined) {
        warnings.push('No execution run records this workspace checkpoint');
        return warnings;
      }
      if (existing.status !== 'RUNNING') {
        warnings.push(`Cannot record a workspace checkpoint for a ${existing.status} run`);
        return warnings;
      }
      const run: ExecutionRun = { ...existing, updated_at: nowIso };

      if (input.event.type === 'task') {
        const taskId = input.event.taskId;
        if (taskId === undefined) {
          warnings.push('A task checkpoint without a task id cannot be recorded');
          return warnings;
        }
        const completed: TaskState = { status: 'completed', completed_at: nowIso };
        if (input.event.commit !== undefined) completed.commit = input.event.commit;
        else if (input.event.head !== undefined) completed.head = input.event.head;
        run.tasks = { ...(run.tasks ?? {}), [taskId]: completed };

        // Opening the next global phase restarts its local tasks, including the task whose
        // completion arrived in this checkpoint, so the run mirrors the phase that just began.
        const opened: string[] = [];
        if (input.globalPhase !== null && String(input.globalPhase) !== run.phase) {
          run.phase = String(input.globalPhase);
          for (const openedId of localTasksInPhase(input, input.globalPhase)) {
            run.tasks[openedId] = { status: 'running', started_at: nowIso };
            opened.push(openedId);
          }
        }

        await persistRun(paths, run, warnings);
        await appendEventSafe(paths, run, 'task.completed', config, warnings, {
          taskId,
          payload: input.event.commit !== undefined ? { commit: input.event.commit } : { head: input.event.head ?? '' },
        });
        for (const openedId of opened) {
          await appendEventSafe(paths, run, 'task.started', config, warnings, { taskId: openedId });
        }
        await persistCheckpoint(paths, run, config, warnings);
        return warnings;
      }

      if (input.event.type === 'reviewed') {
        await persistRun(paths, run, warnings);
        if (input.event.validation !== undefined) {
          await appendEventSafe(paths, run, 'validation.completed', config, warnings, { payload: { result: input.event.validation } });
        }
        if (input.event.repair !== undefined) {
          await appendEventSafe(paths, run, 'repair.completed', config, warnings, { payload: { result: input.event.repair } });
        }
        const payload = input.event.commit === undefined ? undefined : { commit: input.event.commit };
        await appendEventSafe(paths, run, 'review.completed', config, warnings, payload === undefined ? {} : { payload });
        await persistCheckpoint(paths, run, config, warnings);
        return warnings;
      }

      if (input.event.type === 'delivered') {
        const rootDelivery = input.repository === 'workspace';
        const next: ExecutionRun = rootDelivery ? { ...run } : { ...run, status: 'COMPLETED', completed_at: nowIso };
        await persistRun(paths, next, warnings);
        const payload = input.event.commit === undefined ? undefined : { commit: input.event.commit };
        await appendEventSafe(paths, next, 'delivery.completed', config, warnings, payload === undefined ? {} : { payload });
        if (!rootDelivery) await appendEventSafe(paths, next, 'workflow.completed', config, warnings);
        await persistCheckpoint(paths, next, config, warnings);
        return warnings;
      }

      const finalized: ExecutionRun = { ...run, status: 'COMPLETED', completed_at: nowIso };
      await persistRun(paths, finalized, warnings);
      const payload = input.event.commit === undefined ? undefined : { commit: input.event.commit };
      await appendEventSafe(paths, finalized, 'delivery.completed', config, warnings, payload === undefined ? {} : { payload });
      await appendEventSafe(paths, finalized, 'workflow.completed', config, warnings);
      await persistCheckpoint(paths, finalized, config, warnings);
      return warnings;
    } finally {
      await dropLock(paths, warnings);
    }
  } catch (error) {
    warnings.push(`Unable to record workspace execution telemetry: ${errorMessage(error)}`);
    return warnings;
  }
}

/** Input accepted by failure recording, which keeps retryable runs alive. */
export interface RecordFailureInput {
  planDirectory: string;
  category: FailureCategory;
  summary?: string;
  taskId?: string;
  config?: ExecutionConfig;
}

/** Failure recording guidance plus the run state after the attempt was counted. */
export interface RecordFailureResult {
  action: FailureGuidance['action'];
  retryDelaySeconds?: number;
  failureCount: number;
  category: FailureCategory;
  run: ExecutionRun;
  warnings: string[];
}

/**
 * Record one failure attempt. Retryable failures keep the run running with bounded delay guidance,
 * non-retryable failures pause it and release the lock, and task-execution failures mark the task
 * failed for repair without entering a retry loop.
 */
export async function recordFailure(input: RecordFailureInput): Promise<RecordFailureResult> {
  const config = input.config ?? DEFAULT_EXECUTION_CONFIG;
  if (!FAILURE_CATEGORIES.includes(input.category)) {
    throw new Error(`Unknown failure category: ${String(input.category)}`);
  }
  const paths = executionPaths(input.planDirectory);
  const warnings: string[] = [];
  const existing = await loadRun(paths, warnings);
  if (!existing) throw new Error('No execution run accepts a failure');
  if (existing.status !== 'RUNNING' && existing.status !== 'PAUSED') {
    throw new Error(`Cannot record a failure for a ${existing.status} run`);
  }

  const failureCount = existing.failure_count + 1;
  const guidance = classifyFailure(input.category, failureCount, config);
  const nowIso = new Date().toISOString();
  const summary = redactFailureSummary(input.summary ?? '');
  const run: ExecutionRun = {
    ...existing,
    status: guidance.action === 'pause' ? 'PAUSED' : existing.status,
    updated_at: nowIso,
    failure_count: failureCount,
    last_failure: { category: input.category, action: guidance.action, summary, recorded_at: nowIso },
  };

  let markTaskFailed = false;
  if (input.category === 'task_execution' && input.taskId !== undefined) {
    const state = run.tasks?.[input.taskId];
    if (state !== undefined && state.status !== 'failed') {
      run.tasks = { ...run.tasks, [input.taskId]: { ...state, status: 'failed', completed_at: nowIso } };
      markTaskFailed = true;
    }
  }

  const payload = summaryPayload(input.summary);
  const failureOptions: { taskId?: string; payload?: Record<string, unknown> } = {};
  if (input.taskId !== undefined) failureOptions.taskId = input.taskId;
  if (payload !== undefined) failureOptions.payload = payload;

  await persistRun(paths, run, warnings);
  await appendEventSafe(paths, run, failureEventType(input.category), config, warnings, failureOptions);
  if (markTaskFailed && input.taskId !== undefined) {
    await appendEventSafe(paths, run, 'task.failed', config, warnings, { taskId: input.taskId });
  }
  if (guidance.action === 'pause' && existing.status !== 'PAUSED') {
    await appendEventSafe(paths, run, 'workflow.paused', config, warnings, payload === undefined ? {} : { payload });
    await dropLock(paths, warnings);
  }
  await persistCheckpoint(paths, run, config, warnings);

  const result: RecordFailureResult = {
    action: guidance.action,
    failureCount,
    category: input.category,
    run,
    warnings,
  };
  if (guidance.retryDelaySeconds !== undefined) result.retryDelaySeconds = guidance.retryDelaySeconds;
  return result;
}
