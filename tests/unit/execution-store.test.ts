import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_EXECUTION_CONFIG, readExecutionConfig } from '../../src/execution/config.js';
import { executionPaths, isPlanDirectory } from '../../src/execution/paths.js';
import { assertExecutionRecord, validateExecutionRecord } from '../../src/execution/validate.js';
import {
  ExecutionTelemetryError,
  acquireLock,
  appendEvent,
  ensureExecutionPaths,
  isProcessAlive,
  readEvents,
  readLatestCheckpoint,
  readLock,
  readRun,
  releaseLock,
  writeCheckpoint,
  writeRun,
} from '../../src/execution/store.js';
import type { ExecutionCheckpoint, ExecutionEvent, ExecutionLock, ExecutionRun } from '../../src/execution/types.js';
import { temporary } from '../helpers.js';

// Public boundary under test: the durable execution store, its path/config/validation
// helpers and the single-coordinator lock. Fixtures are built inline so the tests do not
// depend on future manager modules.

const PLAN_ID = '20260101-execution-store';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type ExecutionPaths = ReturnType<typeof executionPaths>;

function at(minute: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
}

async function planFixture(): Promise<{ root: string; planDirectory: string; paths: ExecutionPaths }> {
  const root = await temporary('ai-workflow-execution-');
  roots.push(root);
  const planDirectory = join(root, '.ai-workflow', 'plans', PLAN_ID);
  await mkdir(planDirectory, { recursive: true });
  await writeFile(join(planDirectory, 'spec.md'), '# Specification\n');
  await writeFile(join(planDirectory, 'plan.md'), '# Implementation Plan\n');
  return { root, planDirectory, paths: executionPaths(planDirectory) };
}

function runFixture(overrides: Record<string, unknown> = {}): ExecutionRun {
  return {
    run_id: 'run-1',
    plan_id: PLAN_ID,
    plan_digest: DIGEST,
    status: 'RUNNING',
    plan_created_at: at(0),
    created_at: at(1),
    updated_at: at(2),
    failure_count: 0,
    phase: 'phase-1',
    tasks: { 'task-1': { status: 'pending' } },
    ...overrides,
  } as ExecutionRun;
}

function eventRecord(index: number): ExecutionEvent {
  return {
    event_id: `event-${index}`,
    run_id: 'run-1',
    plan_id: PLAN_ID,
    type: 'task.completed',
    timestamp: at(index),
    payload: { index },
  };
}

function checkpointFixture(index: number, overrides: Record<string, unknown> = {}): ExecutionCheckpoint {
  return {
    checkpoint_id: `checkpoint-${index}`,
    run_id: 'run-1',
    plan_id: PLAN_ID,
    plan_digest: DIGEST,
    task_states: { 'task-1': { status: index > 1 ? 'completed' : 'running' } },
    attempt_counts: { 'task-1': 0 },
    phase: 'phase-1',
    last_persisted_event_id: `event-${index}`,
    created_at: at(index),
    ...overrides,
  } as ExecutionCheckpoint;
}

function lockFixture(overrides: Record<string, unknown> = {}): ExecutionLock {
  return {
    owner_id: 'owner-1',
    pid: process.pid,
    host: 'host-a',
    acquired_at: at(0),
    command: 'execution start',
    ...overrides,
  } as ExecutionLock;
}

interface EventInput {
  run_id: string;
  plan_id: string;
  type: ExecutionEvent['type'];
  task_id?: string;
  invocation_id?: string;
  payload?: Record<string, unknown>;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function thrownMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to throw');
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('execution configuration', () => {
  it('exposes the documented defaults', () => {
    expect(DEFAULT_EXECUTION_CONFIG).toEqual({
      maxRetries: 2,
      retryBaseDelayMs: 1000,
      checkpointHistory: 10,
      maxEventLineBytes: 65536,
    });
    expect(readExecutionConfig({})).toEqual(DEFAULT_EXECUTION_CONFIG);
  });

  it('reads each numeric environment override independently', () => {
    expect(readExecutionConfig({ AI_WORKFLOW_EXECUTION_MAX_RETRIES: '5' })).toEqual({
      ...DEFAULT_EXECUTION_CONFIG,
      maxRetries: 5,
    });
    expect(readExecutionConfig({ AI_WORKFLOW_EXECUTION_RETRY_DELAY_MS: '250' })).toEqual({
      ...DEFAULT_EXECUTION_CONFIG,
      retryBaseDelayMs: 250,
    });
    expect(readExecutionConfig({ AI_WORKFLOW_EXECUTION_CHECKPOINT_HISTORY: '3' })).toEqual({
      ...DEFAULT_EXECUTION_CONFIG,
      checkpointHistory: 3,
    });
    expect(readExecutionConfig({ AI_WORKFLOW_EXECUTION_MAX_EVENT_BYTES: '4096' })).toEqual({
      ...DEFAULT_EXECUTION_CONFIG,
      maxEventLineBytes: 4096,
    });
    expect(
      readExecutionConfig({
        AI_WORKFLOW_EXECUTION_MAX_RETRIES: '7',
        AI_WORKFLOW_EXECUTION_RETRY_DELAY_MS: '500',
        AI_WORKFLOW_EXECUTION_CHECKPOINT_HISTORY: '4',
        AI_WORKFLOW_EXECUTION_MAX_EVENT_BYTES: '8192',
      }),
    ).toEqual({ maxRetries: 7, retryBaseDelayMs: 500, checkpointHistory: 4, maxEventLineBytes: 8192 });
  });

  it('falls back to the default for missing, negative or non-integer values', () => {
    for (const value of ['-1', '2.5', 'abc', '']) {
      expect(readExecutionConfig({ AI_WORKFLOW_EXECUTION_MAX_RETRIES: value }).maxRetries).toBe(2);
      expect(readExecutionConfig({ AI_WORKFLOW_EXECUTION_RETRY_DELAY_MS: value }).retryBaseDelayMs).toBe(1000);
      expect(readExecutionConfig({ AI_WORKFLOW_EXECUTION_CHECKPOINT_HISTORY: value }).checkpointHistory).toBe(10);
      expect(readExecutionConfig({ AI_WORKFLOW_EXECUTION_MAX_EVENT_BYTES: value }).maxEventLineBytes).toBe(65536);
    }
    expect(
      readExecutionConfig({
        AI_WORKFLOW_EXECUTION_MAX_RETRIES: '-3',
        AI_WORKFLOW_EXECUTION_RETRY_DELAY_MS: 'not-a-number',
        AI_WORKFLOW_EXECUTION_CHECKPOINT_HISTORY: '-10',
        AI_WORKFLOW_EXECUTION_MAX_EVENT_BYTES: '1.5',
      }),
    ).toEqual(DEFAULT_EXECUTION_CONFIG);
  });
});

describe('execution paths', () => {
  it('derives every execution path from the plan directory', async () => {
    const { planDirectory, paths } = await planFixture();
    expect(paths).toEqual({
      planId: PLAN_ID,
      planDirectory,
      directory: join(planDirectory, 'execution'),
      run: join(planDirectory, 'execution', 'run.json'),
      events: join(planDirectory, 'execution', 'events.jsonl'),
      checkpoints: join(planDirectory, 'execution', 'checkpoints'),
      lock: join(planDirectory, 'execution', 'lock.json'),
    });
  });

  it('recognizes only a directory holding both spec.md and plan.md', async () => {
    const { root, planDirectory } = await planFixture();
    expect(await isPlanDirectory(planDirectory)).toBe(true);

    const specOnly = join(root, 'spec-only');
    await mkdir(specOnly);
    await writeFile(join(specOnly, 'spec.md'), '# Specification\n');
    expect(await isPlanDirectory(specOnly)).toBe(false);

    const planOnly = join(root, 'plan-only');
    await mkdir(planOnly);
    await writeFile(join(planOnly, 'plan.md'), '# Implementation Plan\n');
    expect(await isPlanDirectory(planOnly)).toBe(false);

    const empty = join(root, 'empty');
    await mkdir(empty);
    expect(await isPlanDirectory(empty)).toBe(false);
    expect(await isPlanDirectory(join(root, 'missing'))).toBe(false);
  });
});

describe('execution record validation', () => {
  const validCases: Array<['run' | 'event' | 'checkpoint' | 'lock', unknown]> = [
    ['run', runFixture()],
    ['event', eventRecord(1)],
    ['checkpoint', checkpointFixture(1)],
    ['lock', lockFixture()],
  ];

  it('accepts a valid record of every kind', () => {
    for (const [kind, value] of validCases) {
      expect(validateExecutionRecord(kind, value)).toEqual({ valid: true, errors: [] });
    }
  });

  it('rejects an unknown root field of every kind', () => {
    const cases: Array<['run' | 'event' | 'checkpoint' | 'lock', Record<string, unknown>]> = [
      ['run', { ...runFixture(), unexpected_root: true }],
      ['event', { ...eventRecord(1), unexpected_root: true }],
      ['checkpoint', { ...checkpointFixture(1), unexpected_root: true }],
      ['lock', { ...lockFixture(), unexpected_root: true }],
    ];
    for (const [kind, value] of cases) {
      const result = validateExecutionRecord(kind, value);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('unexpected_root');
    }
  });

  it('rejects a missing required field and an invalid enum value', () => {
    const missingStatus = { ...runFixture() } as Record<string, unknown>;
    delete missingStatus.status;
    expect(validateExecutionRecord('run', missingStatus).valid).toBe(false);
    expect(validateExecutionRecord('run', runFixture({ status: 'BOGUS' })).valid).toBe(false);
    expect(validateExecutionRecord('event', eventRecord(1)).valid).toBe(true);
  });

  it('reports the path and the offending field when asserting a record', () => {
    const path = join('/tmp', 'plan', 'execution', 'run.json');
    const message = thrownMessage(() =>
      assertExecutionRecord('run', { ...runFixture(), unexpected_root: true }, path),
    );
    expect(message).toContain(path);
    expect(message).toContain('unexpected_root');
  });
});

describe('run storage', () => {
  it('round-trips a valid run', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    const run = runFixture();
    await writeRun(paths, run);
    expect(await readRun(paths)).toEqual(run);
  });

  it('refuses invalid run content without writing run.json', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    await expect(writeRun(paths, runFixture({ status: 'BOGUS' }))).rejects.toThrow();
    expect(await fileExists(paths.run)).toBe(false);
  });

  it('rejects reading a corrupt run.json', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    await writeFile(paths.run, '{"run_id":');
    await expect(readRun(paths)).rejects.toThrow();
  });
});

describe('event stream', () => {
  it('appends one generated event object per line with a UTC+08:00 timestamp', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    const first: EventInput = { run_id: 'run-1', plan_id: PLAN_ID, type: 'workflow.started' };
    const second: EventInput = {
      run_id: 'run-1',
      plan_id: PLAN_ID,
      type: 'task.completed',
      task_id: 'task-1',
      invocation_id: 'invocation-1',
      payload: { phase: 'phase-1' },
    };
    await appendEvent(paths, first);
    await appendEvent(paths, second);

    const contents = await readFile(paths.events, 'utf8');
    expect(contents.endsWith('\n')).toBe(true);
    const lines = contents.split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(3);
    const storedFirst = JSON.parse(lines[0] as string) as ExecutionEvent;
    const storedSecond = JSON.parse(lines[1] as string) as ExecutionEvent;

    expect(storedFirst.run_id).toBe('run-1');
    expect(storedFirst.plan_id).toBe(PLAN_ID);
    expect(storedFirst.type).toBe('workflow.started');
    expect(storedFirst.event_id).toBeTypeOf('string');
    expect(storedFirst.event_id.length).toBeGreaterThan(0);
    expect(storedFirst.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    expect(storedSecond.task_id).toBe('task-1');
    expect(storedSecond.invocation_id).toBe('invocation-1');
    expect(storedSecond.payload).toEqual({ phase: 'phase-1' });
    expect(storedSecond.event_id).not.toBe(storedFirst.event_id);
    expect(validateExecutionRecord('event', storedFirst)).toEqual({ valid: true, errors: [] });
    expect(validateExecutionRecord('event', storedSecond)).toEqual({ valid: true, errors: [] });
  });

  it('starts a new line when the existing stream has no trailing newline', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    const partial = '{"event_id":"partial"';
    await writeFile(paths.events, partial);
    await appendEvent(paths, { run_id: 'run-1', plan_id: PLAN_ID, type: 'workflow.started' });

    const contents = await readFile(paths.events, 'utf8');
    expect(contents.startsWith(`${partial}\n`)).toBe(true);
    expect(contents.endsWith('\n')).toBe(true);
    const lines = contents.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(partial);
    const appended = JSON.parse(lines[1] as string) as ExecutionEvent;
    expect(appended.run_id).toBe('run-1');
    expect(appended.event_id).not.toBe('partial');

    const read = await readEvents(paths);
    expect(read.events.map((event) => event.event_id)).toEqual([appended.event_id]);
    expect(read.warnings.length).toBeGreaterThan(0);
    expect(read.truncated).toBe(false);
  });

  it('refuses an event line over the configured byte limit and writes nothing', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    const config = { ...DEFAULT_EXECUTION_CONFIG, maxEventLineBytes: 120 };
    const oversized: EventInput = {
      run_id: 'run-1',
      plan_id: PLAN_ID,
      type: 'workflow.started',
      payload: { text: 'x'.repeat(400) },
    };

    const error = await captureError(() => appendEvent(paths, oversized, config));
    expect(error).toBeInstanceOf(ExecutionTelemetryError);
    expect(error).toBeInstanceOf(Error);
    expect(await fileExists(paths.events)).toBe(false);

    await appendEvent(paths, { run_id: 'run-1', plan_id: PLAN_ID, type: 'workflow.started' });
    const before = await readFile(paths.events);
    await expect(appendEvent(paths, oversized, config)).rejects.toBeInstanceOf(ExecutionTelemetryError);
    expect(await readFile(paths.events)).toEqual(before);
  });

  it('returns an empty result for a missing stream', async () => {
    const { paths } = await planFixture();
    expect(await readEvents(paths)).toEqual({ events: [], warnings: [], truncated: false });
  });

  it('ignores and reports an unterminated trailing line', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    const terminated = JSON.stringify(eventRecord(1));
    const unterminated = JSON.stringify(eventRecord(2));
    await writeFile(paths.events, `${terminated}\n${unterminated}`);

    const result = await readEvents(paths);
    expect(result.events.map((event) => event.event_id)).toEqual(['event-1']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('ignores and reports a malformed terminated line', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    await writeFile(
      paths.events,
      `${JSON.stringify(eventRecord(1))}\n{ not json }\n${JSON.stringify(eventRecord(3))}\n`,
    );

    const result = await readEvents(paths);
    expect(result.events.map((event) => event.event_id)).toEqual(['event-1', 'event-3']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('returns only the newest limited events and reports truncation', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    for (let index = 0; index < 5; index += 1) {
      await appendEvent(paths, {
        run_id: 'run-1',
        plan_id: PLAN_ID,
        type: 'task.completed',
        payload: { index },
      });
    }

    const limited = await readEvents(paths, { limit: 2 });
    expect(limited.events.map((event) => (event.payload as { index: number }).index)).toEqual([3, 4]);
    expect(limited.truncated).toBe(true);
    expect(limited.warnings).toEqual([]);

    const all = await readEvents(paths);
    expect(all.events).toHaveLength(5);
    expect(all.truncated).toBe(false);

    const wide = await readEvents(paths, { limit: 99 });
    expect(wide.events).toHaveLength(5);
    expect(wide.truncated).toBe(false);
  });
});

describe('checkpoint storage', () => {
  it('returns absent when no checkpoint directory exists', async () => {
    const { paths } = await planFixture();
    const result = await readLatestCheckpoint(paths);
    expect(result.status).toBe('absent');
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('keeps the newest ten checkpoints by default', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    for (let index = 1; index <= 12; index += 1) {
      await writeCheckpoint(paths, checkpointFixture(index));
    }
    expect(await readdir(paths.checkpoints)).toHaveLength(10);
    const latest = await readLatestCheckpoint(paths);
    expect(latest.status).toBe('ok');
    if (latest.status !== 'ok') throw new Error(`expected ok, received ${latest.status}`);
    expect(latest.checkpoint.checkpoint_id).toBe('checkpoint-12');
    expect(latest.warnings).toEqual([]);
  });

  it('honors an explicit checkpoint history and removes older files', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    const config = { ...DEFAULT_EXECUTION_CONFIG, checkpointHistory: 2 };
    for (let index = 1; index <= 4; index += 1) {
      await writeCheckpoint(paths, checkpointFixture(index), config);
    }
    expect(await readdir(paths.checkpoints)).toHaveLength(2);
    const latest = await readLatestCheckpoint(paths);
    expect(latest.status).toBe('ok');
    if (latest.status !== 'ok') throw new Error(`expected ok, received ${latest.status}`);
    expect(latest.checkpoint.checkpoint_id).toBe('checkpoint-4');
  });

  it('falls back to the newest valid checkpoint when the newest file is corrupt', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    await writeCheckpoint(paths, checkpointFixture(1));
    await writeCheckpoint(paths, checkpointFixture(2));

    let newest: string | undefined;
    for (const entry of await readdir(paths.checkpoints)) {
      const value = JSON.parse(await readFile(join(paths.checkpoints, entry), 'utf8')) as ExecutionCheckpoint;
      if (value.checkpoint_id === 'checkpoint-2') newest = entry;
    }
    expect(newest).toBeDefined();
    await writeFile(join(paths.checkpoints, newest as string), '{ corrupt');

    const result = await readLatestCheckpoint(paths);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(`expected ok, received ${result.status}`);
    expect(result.checkpoint.checkpoint_id).toBe('checkpoint-1');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('reports manual recovery when files exist but none validate', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    await writeCheckpoint(paths, checkpointFixture(1));
    const entries = await readdir(paths.checkpoints);
    expect(entries).toHaveLength(1);
    await writeFile(join(paths.checkpoints, entries[0] as string), '{ broken');

    const result = await readLatestCheckpoint(paths);
    expect(result.status).toBe('manual');
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('execution lock', () => {
  it('creates the lock with the requested owner fields', async () => {
    const { paths } = await planFixture();
    const request = {
      command: 'ai-workflow execution start',
      owner_id: 'owner-1',
      host: 'host-a',
      pid: 4321,
      acquired_at: at(0),
    };
    const result = await acquireLock(paths, request);
    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error('expected the lock to be acquired');
    expect(result.recovered).toBe(false);
    expect(result.lock).toEqual(request);
    expect(validateExecutionRecord('lock', result.lock)).toEqual({ valid: true, errors: [] });
    expect(await readLock(paths)).toEqual(request);
  });

  it('writes a +08:00 acquired_at when the request omits it', async () => {
    const { paths } = await planFixture();
    const result = await acquireLock(paths, { command: 'execution start' });
    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error('expected the lock to be acquired');
    expect(result.lock.acquired_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    expect((await readLock(paths))?.acquired_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  });

  it('refuses a lock held by a live process on the same host', async () => {
    const { paths } = await planFixture();
    const first = await acquireLock(paths, {
      command: 'execution start',
      owner_id: 'owner-1',
      host: 'host-a',
      pid: 111,
      acquired_at: at(0),
    });
    expect(first.acquired).toBe(true);
    const before = await readFile(paths.lock, 'utf8');

    const second = await acquireLock(
      paths,
      { command: 'execution resume', owner_id: 'owner-2', host: 'host-a', pid: 222 },
      { host: 'host-a', isAlive: () => true },
    );
    expect(second.acquired).toBe(false);
    expect(second.acquired ? undefined : second.reason).toBe('live');
    expect(await readFile(paths.lock, 'utf8')).toBe(before);
  });

  it('recovers a same-host lock whose process is dead', async () => {
    const { paths } = await planFixture();
    const first = await acquireLock(paths, {
      command: 'execution start',
      owner_id: 'owner-1',
      host: 'host-a',
      pid: 424242,
      acquired_at: at(0),
    });
    expect(first.acquired).toBe(true);

    const second = await acquireLock(
      paths,
      { command: 'execution resume', owner_id: 'owner-2', host: 'host-a', pid: 333, acquired_at: at(5) },
      { host: 'host-a', isAlive: () => false },
    );
    expect(second.acquired).toBe(true);
    if (!second.acquired) throw new Error('expected the stale lock to be recovered');
    expect(second.recovered).toBe(true);
    expect(second.lock.owner_id).toBe('owner-2');
    expect(second.lock.pid).toBe(333);
    expect(await readLock(paths)).toEqual(second.lock);
  });

  it('requires manual action for a lock held on another host', async () => {
    const { paths } = await planFixture();
    const first = await acquireLock(paths, {
      command: 'execution start',
      owner_id: 'owner-1',
      host: 'host-a',
      pid: 111,
      acquired_at: at(0),
    });
    expect(first.acquired).toBe(true);
    const before = await readFile(paths.lock, 'utf8');

    const second = await acquireLock(
      paths,
      { command: 'execution resume', owner_id: 'owner-2', host: 'host-b', pid: 222 },
      { host: 'host-b', isAlive: () => true },
    );
    expect(second.acquired).toBe(false);
    expect(second.acquired ? undefined : second.reason).toBe('other-host');
    expect(await readFile(paths.lock, 'utf8')).toBe(before);
  });

  it('refuses to overwrite an unreadable lock', async () => {
    const { paths } = await planFixture();
    await ensureExecutionPaths(paths);
    await writeFile(paths.lock, 'not json');
    const before = await readFile(paths.lock, 'utf8');

    const result = await acquireLock(paths, { command: 'execution start' }, { host: 'host-a' });
    expect(result.acquired).toBe(false);
    expect(result.acquired ? undefined : result.reason).toBe('unreadable');
    expect(await readFile(paths.lock, 'utf8')).toBe(before);
  });

  it('reads and releases the lock idempotently', async () => {
    const { paths } = await planFixture();
    expect(await readLock(paths)).toBeUndefined();

    const acquired = await acquireLock(paths, { command: 'execution start' });
    expect(acquired.acquired).toBe(true);
    expect(await readLock(paths)).toEqual(acquired.acquired ? acquired.lock : undefined);

    expect(await releaseLock(paths)).toBe(true);
    expect(await readLock(paths)).toBeUndefined();
    expect(await fileExists(paths.lock)).toBe(false);
    expect(await releaseLock(paths)).toBe(false);
  });

  it('detects a live process and a dead process', async () => {
    expect(isProcessAlive(process.pid)).toBe(true);

    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await once(child, 'exit');
    expect(child.pid).toBeTypeOf('number');
    expect(isProcessAlive(child.pid as number)).toBe(false);
  });
});

describe('execution storage permissions and location', () => {
  it('writes every execution file owner-only inside the plan execution directory', async () => {
    const { planDirectory, paths } = await planFixture();
    await ensureExecutionPaths(paths);
    await writeRun(paths, runFixture());
    await appendEvent(paths, { run_id: 'run-1', plan_id: PLAN_ID, type: 'workflow.started' });
    await writeCheckpoint(paths, checkpointFixture(1));
    const acquired = await acquireLock(paths, { command: 'execution start' });
    expect(acquired.acquired).toBe(true);

    const checkpointFiles = (await readdir(paths.checkpoints)).map((entry) => join(paths.checkpoints, entry));
    expect(checkpointFiles.length).toBe(1);
    for (const file of [paths.run, paths.events, paths.lock, ...checkpointFiles]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.checkpoints)).mode & 0o777).toBe(0o700);
    expect((await readdir(planDirectory)).sort()).toEqual(['execution', 'plan.md', 'spec.md']);
  });
});
