import { readdir, readFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { executionPaths, isPlanDirectory, type ExecutionPaths } from './paths.js';
import type { CheckpointReadResult, EventReadResult } from './store.js';
import { isProcessAlive, readEvents, readLatestCheckpoint, readLock, readRun } from './store.js';
import type { ExecutionEvent, ExecutionRun, RunStatus } from './types.js';

const UNAVAILABLE = 'N/A' as const;
const DEFAULT_EVENT_LIMIT = 200;

/** Failure event types counted as a retry attempt. */
const RETRYABLE_FAILURE_EVENTS = new Set<string>([
  'failure.model_unavailable',
  'failure.network_timeout',
  'failure.network_disconnect',
  'failure.rate_limit',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function secondsBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const startMs = parseTimestamp(start);
  const endMs = parseTimestamp(end);
  if (startMs === undefined || endMs === undefined) return undefined;
  return round((endMs - startMs) / 1000, 3);
}

/** Execution path state of one plan directory. */
type ExecutionKind = 'directory' | 'file' | 'unreadable';

/** A plan directory that has an execution path, with the path kind discovered. */
interface PlanLocation {
  planDirectory: string;
  planId: string;
  kind: ExecutionKind;
}

/** The lock state reported by a read-only query. */
export type LockState = 'none' | 'held' | 'stale' | 'other-host' | 'unreadable';

/** Read-only lock projection including the recorded owner details when available. */
export interface LockProjection {
  state: LockState;
  owner_id?: string;
  pid?: number;
  host?: string;
  acquired_at?: string;
  command?: string;
}

/** Per-task counts reported for a run that has task state. */
export interface TaskCountProjection {
  total: number;
  completed: number;
  running: number;
  pending: number;
  failed: number;
}

/** One run entry of the project-wide status report. */
export interface StatusRunEntry {
  plan_id: string;
  plan_directory: string;
  run_id: string | null;
  repository: string | null;
  status: RunStatus | 'UNKNOWN';
  phase: string | null;
  updated_at: string | null;
  last_failure: ExecutionRun['last_failure'] | null;
  lock: LockProjection;
  tasks: TaskCountProjection | typeof UNAVAILABLE;
  degraded: boolean;
  warnings: string[];
}

export interface ExecutionStatusResult {
  valid: true;
  runs: StatusRunEntry[];
  warnings: string[];
}

/** Checkpoint projection: recovery status plus the recorded identity when readable. */
export interface CheckpointProjection {
  status: 'ok' | 'absent' | 'manual';
  warnings: string[];
  checkpoint_id?: string;
  phase?: string;
  repository?: string;
}

export interface ExecutionShowResult {
  valid: true;
  run: StatusRunEntry;
  checkpoint: CheckpointProjection;
  events: { count: number; truncated: boolean; warnings: string[] };
  diagnostics: { degraded: boolean; warnings: string[] };
  lock: LockProjection;
}

export interface ExecutionEventsResult {
  valid: true;
  plan_id: string;
  run_id: string;
  events: ExecutionEvent[];
  truncated: boolean;
  warnings: string[];
}

/** One run entry of the history report. */
export interface HistoryRunEntry {
  plan_id: string;
  plan_directory: string;
  run_id: string;
  repository: string | null;
  status: RunStatus;
  phase: string | null;
  started_at: string | null;
  completed_at: string | null;
  failure_count: number;
}

export interface ExecutionHistoryResult {
  valid: true;
  runs: HistoryRunEntry[];
  warnings: string[];
}

/** Metrics derived exclusively from stored run and event data. */
export interface AnalyticsMetric {
  plan_id: string;
  run_id: string;
  repository: string | null;
  workflow_duration_seconds: number | typeof UNAVAILABLE;
  task_success_rate: number | typeof UNAVAILABLE;
  average_task_duration_seconds: number | typeof UNAVAILABLE;
  retry_count: number;
  interruption_count: number;
  recovery_success_rate: number | typeof UNAVAILABLE;
  token_usage: number | typeof UNAVAILABLE;
  model_cost: number | typeof UNAVAILABLE;
  validation_result: string;
  review_result: string;
  warnings: string[];
}

export interface ExecutionAnalyticsResult {
  valid: true;
  scope: 'plan' | 'project';
  runs: AnalyticsMetric[];
  warnings: string[];
}

/** Query target: one plan directory or one project root. */
export interface QueryScope {
  project?: string;
  plan?: string;
}

type ScopeTarget = { kind: 'plan'; plan: string } | { kind: 'project'; project: string };

function resolveScope(scope: QueryScope): ScopeTarget {
  if (scope.plan !== undefined && scope.project !== undefined) {
    throw new Error('Use either --plan or --project, not both');
  }
  if (scope.plan !== undefined) return { kind: 'plan', plan: scope.plan };
  return { kind: 'project', project: resolve(scope.project ?? process.cwd()) };
}

async function executionKind(planDirectory: string): Promise<ExecutionKind | 'missing'> {
  try {
    const info = await stat(join(planDirectory, 'execution'));
    return info.isDirectory() ? 'directory' : 'file';
  } catch (error) {
    return isMissing(error) ? 'missing' : 'unreadable';
  }
}

/** Bounded submodule roots declared by the project's `.gitmodules`. */
async function declaredSubmoduleRoots(root: string): Promise<string[]> {
  let source: string;
  try {
    source = await readFile(join(root, '.gitmodules'), 'utf8');
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    const value = match?.[1];
    if (value === undefined) continue;
    const candidate = resolve(root, value);
    try {
      const info = await stat(candidate);
      if (info.isDirectory() && !roots.includes(candidate)) roots.push(candidate);
    } catch {
      // A declared but absent child repository contributes no run history.
    }
  }
  return roots;
}

/** Discover every plan directory under a project and its declared submodules that owns an execution path. */
async function projectLocations(root: string): Promise<PlanLocation[]> {
  const locations: PlanLocation[] = [];
  const seen = new Set<string>();
  for (const base of [root, ...(await declaredSubmoduleRoots(root))]) {
    const plansRoot = join(base, '.ai-workflow', 'plans');
    let entries;
    try {
      entries = await readdir(plansRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const planDirectory = join(plansRoot, entry.name);
      if (seen.has(planDirectory)) continue;
      const kind = await executionKind(planDirectory);
      if (kind === 'missing') continue;
      seen.add(planDirectory);
      locations.push({ planDirectory, planId: entry.name, kind });
    }
  }
  locations.sort((left, right) => (left.planDirectory < right.planDirectory ? -1 : left.planDirectory > right.planDirectory ? 1 : 0));
  return locations;
}

async function explicitPlanLocation(plan: string, requireExecution: boolean): Promise<PlanLocation | undefined> {
  const planDirectory = resolve(plan);
  if (!(await isPlanDirectory(planDirectory))) throw new Error(`Invalid plan directory: ${planDirectory}`);
  const kind = await executionKind(planDirectory);
  if (kind === 'missing') {
    if (requireExecution) throw new Error(`No execution run found at ${join(planDirectory, 'execution')}`);
    return undefined;
  }
  return { planDirectory, planId: basename(planDirectory), kind };
}

async function requirePlanLocation(plan: string): Promise<PlanLocation> {
  const location = await explicitPlanLocation(plan, true);
  if (location === undefined) throw new Error(`No execution run found for ${resolve(plan)}`);
  return location;
}

async function singleProjectLocation(root: string): Promise<PlanLocation> {
  const locations = await projectLocations(root);
  const location = locations[0];
  if (location === undefined) throw new Error('No execution run found for the project');
  if (locations.length > 1) throw new Error('Multiple execution runs found; select one with --plan');
  return location;
}

async function lockProjection(paths: ExecutionPaths, checkLiveness: boolean): Promise<LockProjection> {
  let lock;
  try {
    lock = await readLock(paths);
  } catch {
    return { state: 'unreadable' };
  }
  if (lock === undefined) return { state: 'none' };
  const projection: LockProjection = {
    state: 'held',
    owner_id: lock.owner_id,
    pid: lock.pid,
    host: lock.host,
    acquired_at: lock.acquired_at,
    command: lock.command,
  };
  if (lock.host !== hostname()) return { ...projection, state: 'other-host' };
  if (checkLiveness && !isProcessAlive(lock.pid)) return { ...projection, state: 'stale' };
  return projection;
}

function taskCounts(run: ExecutionRun | undefined): TaskCountProjection | typeof UNAVAILABLE {
  const states = run?.tasks;
  if (states === undefined) return UNAVAILABLE;
  const entries = Object.values(states);
  if (entries.length === 0) return UNAVAILABLE;
  const counts: TaskCountProjection = { total: entries.length, completed: 0, running: 0, pending: 0, failed: 0 };
  for (const state of entries) counts[state.status] += 1;
  return counts;
}

async function statusEntry(location: PlanLocation): Promise<StatusRunEntry> {
  const paths = executionPaths(location.planDirectory);
  const warnings: string[] = [];
  let degraded = false;
  let run: ExecutionRun | undefined;

  if (location.kind === 'file') {
    degraded = true;
    warnings.push(`Execution path ${paths.directory} is a file, not a directory`);
  } else if (location.kind === 'unreadable') {
    degraded = true;
    warnings.push(`Execution path ${paths.directory} is unreadable`);
  } else {
    try {
      run = await readRun(paths);
    } catch (error) {
      degraded = true;
      warnings.push(isMissing(error) ? `Execution run ${paths.run} is missing` : `Unable to read the execution run: ${errorMessage(error)}`);
    }
  }

  const lock = location.kind === 'directory' ? await lockProjection(paths, true) : { state: 'unreadable' as const };
  if (lock.state === 'unreadable') {
    degraded = true;
    warnings.push(`Execution lock ${paths.lock} is unreadable`);
  }

  return {
    plan_id: run?.plan_id ?? location.planId,
    plan_directory: location.planDirectory,
    run_id: run?.run_id ?? null,
    repository: run?.repository ?? null,
    status: run?.status ?? 'UNKNOWN',
    phase: run?.phase ?? null,
    updated_at: run?.updated_at ?? null,
    last_failure: run?.last_failure ?? null,
    lock,
    tasks: taskCounts(run),
    degraded,
    warnings,
  };
}

function collectWarnings(entries: StatusRunEntry[]): string[] {
  const warnings = new Set<string>();
  for (const entry of entries) for (const warning of entry.warnings) warnings.add(warning);
  return [...warnings];
}

/** Project-scope status: every readable run entry, sorted by plan directory. */
export async function executionStatus(scope: QueryScope): Promise<ExecutionStatusResult> {
  const target = resolveScope(scope);
  if (target.kind === 'plan') {
    const location = await explicitPlanLocation(target.plan, false);
    const runs = location === undefined ? [] : [await statusEntry(location)];
    return { valid: true, runs, warnings: collectWarnings(runs) };
  }
  const locations = await projectLocations(target.project);
  const runs: StatusRunEntry[] = [];
  for (const location of locations) runs.push(await statusEntry(location));
  return { valid: true, runs, warnings: collectWarnings(runs) };
}

function checkpointProjection(result: CheckpointReadResult): CheckpointProjection {
  const projection: CheckpointProjection = { status: result.status, warnings: result.warnings };
  if (result.status === 'ok') {
    projection.checkpoint_id = result.checkpoint.checkpoint_id;
    if (result.checkpoint.phase !== undefined) projection.phase = result.checkpoint.phase;
    if (result.checkpoint.repository !== undefined) projection.repository = result.checkpoint.repository;
  }
  return projection;
}

/** Single-run inspection of the run, newest checkpoint, bounded event tail and diagnostics. */
export async function executionShow(scope: QueryScope): Promise<ExecutionShowResult> {
  const target = resolveScope(scope);
  const location = target.kind === 'plan' ? await requirePlanLocation(target.plan) : await singleProjectLocation(target.project);
  const paths = executionPaths(location.planDirectory);
  const entry = await statusEntry(location);
  const lock = location.kind === 'directory' ? await lockProjection(paths, true) : { state: 'unreadable' as const };

  let checkpoint: CheckpointProjection;
  let events: { count: number; truncated: boolean; warnings: string[] };
  if (location.kind === 'directory') {
    checkpoint = checkpointProjection(await readLatestCheckpoint(paths));
    const stream = await readEvents(paths);
    events = { count: stream.events.length, truncated: stream.truncated, warnings: stream.warnings };
  } else {
    const warning = `Execution path ${paths.directory} is not a directory`;
    checkpoint = { status: 'absent', warnings: [warning] };
    events = { count: 0, truncated: false, warnings: [warning] };
  }

  const warnings = new Set<string>(entry.warnings);
  for (const warning of checkpoint.warnings) warnings.add(warning);
  for (const warning of events.warnings) warnings.add(warning);
  if (lock.state === 'unreadable') warnings.add(`Execution lock ${paths.lock} is unreadable`);
  const diagnostics = [...warnings];

  return {
    valid: true,
    run: entry,
    checkpoint,
    events,
    diagnostics: { degraded: entry.degraded || diagnostics.length > 0, warnings: diagnostics },
    lock,
  };
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid limit: ${raw}`);
  return parsed;
}

/** Bounded event tail for one run. */
export async function executionEvents(query: QueryScope & { limit?: string }): Promise<ExecutionEventsResult> {
  const target = resolveScope(query);
  const location = target.kind === 'plan' ? await requirePlanLocation(target.plan) : await singleProjectLocation(target.project);
  const paths = executionPaths(location.planDirectory);
  if (location.kind !== 'directory') throw new Error(`Execution path ${paths.directory} is not a directory`);
  const run = await readRun(paths);
  const limit = parseLimit(query.limit, DEFAULT_EVENT_LIMIT);
  const stream: EventReadResult = await readEvents(paths, { limit });
  return {
    valid: true,
    plan_id: run.plan_id,
    run_id: run.run_id,
    events: stream.events,
    truncated: stream.truncated,
    warnings: stream.warnings,
  };
}

function historyEntry(location: PlanLocation, run: ExecutionRun): HistoryRunEntry {
  return {
    plan_id: run.plan_id,
    plan_directory: location.planDirectory,
    run_id: run.run_id,
    repository: run.repository ?? null,
    status: run.status,
    phase: run.phase ?? null,
    started_at: run.started_at ?? null,
    completed_at: run.completed_at ?? null,
    failure_count: run.failure_count,
  };
}

/** Per-run history across one plan or a project, sorted by plan directory. */
export async function executionHistory(scope: QueryScope): Promise<ExecutionHistoryResult> {
  const target = resolveScope(scope);
  const locations: PlanLocation[] = [];
  if (target.kind === 'plan') {
    const location = await explicitPlanLocation(target.plan, false);
    if (location !== undefined) locations.push(location);
  } else {
    locations.push(...(await projectLocations(target.project)));
  }

  const runs: HistoryRunEntry[] = [];
  const warnings: string[] = [];
  for (const location of locations) {
    if (location.kind !== 'directory') {
      warnings.push(`Execution path ${executionPaths(location.planDirectory).directory} is not a directory`);
      continue;
    }
    try {
      runs.push(historyEntry(location, await readRun(executionPaths(location.planDirectory))));
    } catch (error) {
      warnings.push(`Unable to read the execution run at ${location.planDirectory}: ${errorMessage(error)}`);
    }
  }
  runs.sort((left, right) => (left.plan_directory < right.plan_directory ? -1 : left.plan_directory > right.plan_directory ? 1 : 0));
  return { valid: true, runs, warnings };
}

function taskMetrics(tasks: ExecutionRun['tasks']): {
  successRate: number | typeof UNAVAILABLE;
  averageDuration: number | typeof UNAVAILABLE;
} {
  if (tasks === undefined) return { successRate: UNAVAILABLE, averageDuration: UNAVAILABLE };
  const entries = Object.values(tasks);
  if (entries.length === 0) return { successRate: UNAVAILABLE, averageDuration: UNAVAILABLE };
  const completed = entries.filter((state) => state.status === 'completed').length;
  const durations: number[] = [];
  for (const state of entries) {
    const duration = secondsBetween(state.started_at, state.completed_at);
    if (duration !== undefined) durations.push(duration);
  }
  const average = durations.length === 0 ? UNAVAILABLE : round(durations.reduce((total, value) => total + value, 0) / durations.length, 3);
  return { successRate: round(completed / entries.length, 4), averageDuration: average };
}

function lastPayloadString(events: ExecutionEvent[], type: ExecutionEvent['type']): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== type) continue;
    const value = event.payload?.['result'];
    return typeof value === 'string' ? value : UNAVAILABLE;
  }
  return UNAVAILABLE;
}

function sumPayloadNumber(events: ExecutionEvent[], field: string): number | undefined {
  let total: number | undefined;
  for (const event of events) {
    const value = event.payload?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
}

function buildMetric(run: ExecutionRun, events: ExecutionEvent[], warnings: string[]): AnalyticsMetric {
  const tasks = taskMetrics(run.tasks);
  const agentEvents = events.filter((event) => event.type === 'agent.invoked' || event.type === 'agent.completed');
  const tokenUsage = sumPayloadNumber(agentEvents, 'tokens') ?? run.agent?.tokens ?? UNAVAILABLE;
  const modelCost = sumPayloadNumber(agentEvents, 'cost') ?? run.agent?.cost ?? UNAVAILABLE;
  const retryCount = events.filter((event) => RETRYABLE_FAILURE_EVENTS.has(event.type)).length;
  const interruptionCount = events.filter((event) => event.type === 'execution.interrupted').length;
  const resumedCount = events.filter((event) => event.type === 'execution.resumed').length;

  return {
    plan_id: run.plan_id,
    run_id: run.run_id,
    repository: run.repository ?? null,
    workflow_duration_seconds: secondsBetween(run.started_at, run.completed_at) ?? UNAVAILABLE,
    task_success_rate: tasks.successRate,
    average_task_duration_seconds: tasks.averageDuration,
    retry_count: retryCount,
    interruption_count: interruptionCount,
    recovery_success_rate: interruptionCount === 0 ? UNAVAILABLE : round(resumedCount / interruptionCount, 4),
    token_usage: tokenUsage,
    model_cost: modelCost,
    validation_result: lastPayloadString(events, 'validation.completed'),
    review_result: lastPayloadString(events, 'review.completed'),
    warnings,
  };
}

/** Analytics derived only from stored run and event data; unavailable values stay `N/A`. */
export async function executionAnalytics(scope: QueryScope): Promise<ExecutionAnalyticsResult> {
  const target = resolveScope(scope);
  const locations: PlanLocation[] = [];
  if (target.kind === 'plan') {
    const location = await requirePlanLocation(target.plan);
    if (location.kind !== 'directory') throw new Error(`Execution path ${executionPaths(location.planDirectory).directory} is not a directory`);
    locations.push(location);
  } else {
    locations.push(...(await projectLocations(target.project)));
  }

  const runs: AnalyticsMetric[] = [];
  const warnings: string[] = [];
  for (const location of locations) {
    if (location.kind !== 'directory') {
      warnings.push(`Execution path ${executionPaths(location.planDirectory).directory} is not a directory`);
      continue;
    }
    const paths = executionPaths(location.planDirectory);
    try {
      const run = await readRun(paths);
      const metricWarnings: string[] = [];
      let events: ExecutionEvent[] = [];
      try {
        const stream = await readEvents(paths);
        events = stream.events;
        metricWarnings.push(...stream.warnings);
      } catch (error) {
        metricWarnings.push(`Unable to read the execution events: ${errorMessage(error)}`);
      }
      runs.push(buildMetric(run, events, metricWarnings));
    } catch (error) {
      warnings.push(`Unable to read the execution run at ${location.planDirectory}: ${errorMessage(error)}`);
    }
  }
  runs.sort((left, right) => {
    if (left.plan_id !== right.plan_id) return left.plan_id < right.plan_id ? -1 : 1;
    return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0;
  });
  return { valid: true, scope: target.kind === 'plan' ? 'plan' : 'project', runs, warnings };
}
