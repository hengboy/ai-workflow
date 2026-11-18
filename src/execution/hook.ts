import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ExecutionPaths } from './paths.js';
import { executionPaths } from './paths.js';
import { appendEvent, readEvents, readRun, writeRun } from './store.js';
import type { ExecutionRun } from './types.js';
import { nowCst } from '../workspace/record.js';

/** Host events that may open or close a recorded agent invocation. */
const HOST_EVENTS = ['session.created', 'session.deleted', 'session.error'] as const;
type HostEventType = (typeof HOST_EVENTS)[number];
type HostRecordEvent = HostEventType | 'agent.invoked' | 'agent.completed';

/** Deterministic result printed by the internal host transport. */
export interface HostRecordResult {
  recorded: boolean;
  event?: HostRecordEvent;
  invocation_id?: string;
  run_id?: string;
  reason?: string;
  warnings: string[];
}

/** One active repository run together with the paths that own it. */
interface ActiveRun {
  paths: ExecutionPaths;
  run: ExecutionRun;
}

function noOp(reason: string): HostRecordResult {
  return { recorded: false, reason, warnings: [] };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Walk upwards from a session directory to the nearest adopted project root. */
async function adoptedRoot(directory: string): Promise<string | undefined> {
  let root = resolve(directory);
  while (true) {
    try {
      await stat(join(root, '.ai-workflow'));
      return root;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}

/**
 * Every RUNNING run whose overlay lives beside a plan in the adopted root. Unreadable,
 * absent or non-running overlays contribute nothing, so a broken plan can never block
 * an unambiguous sibling.
 */
async function runningRuns(root: string): Promise<ActiveRun[]> {
  const plansRoot = join(root, '.ai-workflow', 'plans');
  let entries;
  try {
    entries = await readdir(plansRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const active: ActiveRun[] = [];
  for (const entry of entries.slice().sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue;
    const paths = executionPaths(join(plansRoot, entry.name));
    try {
      const run = await readRun(paths);
      if (run.status === 'RUNNING') active.push({ paths, run });
    } catch {
      // A plan without a readable run contributes no active binding.
    }
  }
  return active;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function tokenField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function costField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Build the durable agent binding from the fields a host actually supplies. */
function agentBinding(host: string, data: Record<string, unknown>, sessionId: string): NonNullable<ExecutionRun['agent']> {
  const binding: NonNullable<ExecutionRun['agent']> = {
    invocation_id: sessionId,
    host,
    session_id: sessionId,
  };
  const parentSessionId = stringField(data, 'parent_session_id');
  if (parentSessionId !== undefined) binding.parent_session_id = parentSessionId;
  const role = stringField(data, 'role');
  if (role !== undefined) binding.role = role;
  const model = stringField(data, 'model');
  if (model !== undefined) binding.model = model;
  const tokens = tokenField(data['tokens']);
  if (tokens !== undefined) binding.tokens = tokens;
  const cost = costField(data['cost']);
  if (cost !== undefined) binding.cost = cost;
  return binding;
}

/** Record one invocation start and its durable agent binding. */
async function recordInvocation(active: ActiveRun, host: string, data: Record<string, unknown>, sessionId: string): Promise<HostRecordResult> {
  const stream = await readEvents(active.paths);
  if (stream.events.some((event) => event.type === 'agent.invoked' && event.invocation_id === sessionId)) {
    return noOp('invocation already recorded');
  }

  const run: ExecutionRun = {
    ...active.run,
    agent: agentBinding(host, data, sessionId),
    updated_at: nowCst(),
  };
  await writeRun(active.paths, run);
  await appendEvent(active.paths, {
    run_id: run.run_id,
    plan_id: run.plan_id,
    type: 'agent.invoked',
    invocation_id: sessionId,
  });
  return { recorded: true, event: 'agent.invoked', invocation_id: sessionId, run_id: run.run_id, warnings: [] };
}

/** Record completion only when the same invocation started and has not completed yet. */
async function recordCompletion(
  active: ActiveRun,
  sessionId: string,
  outcome?: 'error',
): Promise<HostRecordResult> {
  const stream = await readEvents(active.paths);
  const invoked = stream.events.some((event) => event.type === 'agent.invoked' && event.invocation_id === sessionId);
  if (!invoked) return noOp('no matching invocation');
  const completed = stream.events.some((event) => event.type === 'agent.completed' && event.invocation_id === sessionId);
  if (completed) return noOp('completion already recorded');

  await appendEvent(active.paths, {
    run_id: active.run.run_id,
    plan_id: active.run.plan_id,
    type: 'agent.completed',
    invocation_id: sessionId,
    ...(outcome === undefined ? {} : { payload: { outcome } }),
  });
  return { recorded: true, event: 'agent.completed', invocation_id: sessionId, run_id: active.run.run_id, warnings: [] };
}

/**
 * Consume one JSON host event from stdin and mirror it into the single unambiguous
 * running repository. Every outcome, including malformed input, an unknown host or an
 * absent or ambiguous run, resolves without writing and without throwing.
 */
export async function recordHostSession(host: string, raw: string): Promise<HostRecordResult> {
  try {
    if (host !== 'opencode') return noOp('unknown host');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return noOp('malformed host event');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return noOp('malformed host event');
    const data = parsed as Record<string, unknown>;

    const event = data['event'];
    if (typeof event !== 'string' || !HOST_EVENTS.includes(event as HostEventType)) return noOp('unknown host event');
    const cwd = stringField(data, 'cwd');
    if (cwd === undefined) return noOp('missing session directory');
    const sessionId = stringField(data, 'session_id');
    if (sessionId === undefined) return noOp('missing session id');

    const root = await adoptedRoot(cwd);
    if (root === undefined) return noOp('no adopted project root');

    const active = await runningRuns(root);
    if (active.length === 0) return noOp('no active run');
    if (active.length > 1) return noOp('multiple active runs');
    const target = active[0];
    if (target === undefined) return noOp('no active run');

    if (event === 'session.created') return await recordInvocation(target, host, data, sessionId);
    return await recordCompletion(target, sessionId, event === 'session.error' ? 'error' : undefined);
  } catch {
    return noOp('host session could not be recorded');
  }
}
