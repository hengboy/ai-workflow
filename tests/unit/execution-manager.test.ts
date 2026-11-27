import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../../src/utils/frontmatter.js';
import { readPlan } from '../../src/workflow/parse.js';
import { DEFAULT_EXECUTION_CONFIG } from '../../src/execution/config.js';
import { executionPaths } from '../../src/execution/paths.js';
import { readEvents, readLatestCheckpoint, readLock, readRun, writeRun } from '../../src/execution/store.js';
import type { ExecutionCheckpoint, ExecutionEvent, ExecutionRun } from '../../src/execution/types.js';
import { readOrdinaryRecord, writeOrdinaryRecord } from '../../src/execution/record.js';
import { cancelRun, completeRun, failRun, pauseRun, recordFailure, recordTask, startRun } from '../../src/execution/manager.js';
import * as executionManager from '../../src/execution/manager.js';
import { changedPaths, frozenPlan, snapshotTree, temporary, workspacePlanFixture, writePlanTriplet } from '../helpers.js';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';

// Public boundary under test: the lenient authoritative-record reader/writer and the
// run-lifecycle manager. Frozen plan/task fixtures are produced by the shared helpers so
// their self-referential digests are genuine and `readPlan` accepts them.

const CST_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;

type Paths = ReturnType<typeof executionPaths>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = await temporary('ai-workflow-exec-manager-');
  roots.push(root);
  return root;
}

function sha(letter: string): string {
  return letter.repeat(40);
}

async function eventTypes(paths: Paths): Promise<string[]> {
  return (await readEvents(paths)).events.map((event) => event.type);
}

async function eventsOfType(paths: Paths, type: ExecutionEvent['type'], taskId?: string): Promise<ExecutionEvent[]> {
  return (await readEvents(paths)).events.filter(
    (event) => event.type === type && (taskId === undefined || event.task_id === taskId),
  );
}

async function latestCheckpoint(paths: Paths): Promise<ExecutionCheckpoint> {
  const result = await readLatestCheckpoint(paths);
  expect(result.status, 'latest checkpoint is readable').toBe('ok');
  if (result.status !== 'ok') throw new Error('latest checkpoint is not readable');
  return result.checkpoint;
}

async function lastEventId(paths: Paths): Promise<string | undefined> {
  return (await readEvents(paths)).events.at(-1)?.event_id;
}

async function planMeta(planDirectory: string): Promise<{ planId: string; digest: string; createdAt: string }> {
  const plan = await readPlan(planDirectory);
  const { attributes } = parseMarkdown(await readFile(join(planDirectory, 'plan.md'), 'utf8'));
  return { planId: plan.planId, digest: plan.digest, createdAt: String(attributes.created_at) };
}

function baseRun(planId: string, digest: string, overrides: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    run_id: 'run-existing',
    plan_id: planId,
    plan_digest: digest,
    status: 'CREATED',
    plan_created_at: '2026-08-31T00:00:00.000Z',
    created_at: '2026-08-31T00:00:01.000Z',
    updated_at: '2026-08-31T00:00:01.000Z',
    failure_count: 0,
    ...overrides,
  };
}

async function writeExistingRun(planDirectory: string, overrides: Partial<ExecutionRun> = {}): Promise<ExecutionRun> {
  const meta = await planMeta(planDirectory);
  const run = baseRun(meta.planId, meta.digest, overrides);
  await writeRun(executionPaths(planDirectory), run);
  return run;
}

const T1 = 'task-001-build';
const T2 = 'task-002-test';
const T3 = 'task-003-package';

async function splitFixture(): Promise<{ planDirectory: string; paths: Paths }> {
  const root = await newRoot();
  const planDirectory = await workspacePlanFixture(root, {
    planId: '20260930-two-phase',
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    tasks: [
      { id: T1, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], dependsOn: [], readScope: ['MEMORY.md'], writeScope: ['src/build.ts'] },
      { id: T2, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], dependsOn: [], readScope: ['MEMORY.md'], writeScope: ['src/build.test.ts'] },
      { id: T3, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], dependsOn: [T1, T2], readScope: ['MEMORY.md'], writeScope: ['src/package.ts'] },
    ],
    phases: [[T1, T2], [T3]],
  });
  return { planDirectory, paths: executionPaths(planDirectory) };
}

describe('ordinary implementation record reader and writer', () => {
  it('returns undefined when no record exists', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const path = join(planDirectory, 'implementation.yaml');
    expect(await readOrdinaryRecord(path, '20260831-example')).toBeUndefined();
  });

  it('writes deterministic YAML that preserves fields without inventing started_at', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const path = join(planDirectory, 'implementation.yaml');

    await writeOrdinaryRecord(path, { plan_id: '20260831-example', status: 'in-progress' });
    const firstBytes = await readFile(path, 'utf8');
    expect(firstBytes).not.toContain('started_at');
    await writeOrdinaryRecord(path, { plan_id: '20260831-example', status: 'in-progress' });
    expect(await readFile(path, 'utf8')).toBe(firstBytes);
    expect(await readOrdinaryRecord(path, '20260831-example')).toEqual({
      plan_id: '20260831-example',
      status: 'in-progress',
    });

    await writeOrdinaryRecord(path, {
      plan_id: '20260831-example',
      status: 'completed',
      started_at: '2026-08-31T01:00:00+08:00',
      completed_at: '2026-08-31T02:00:00+08:00',
      commit: sha('c'),
    });
    expect(await readOrdinaryRecord(path, '20260831-example')).toEqual({
      plan_id: '20260831-example',
      status: 'completed',
      started_at: '2026-08-31T01:00:00+08:00',
      completed_at: '2026-08-31T02:00:00+08:00',
      commit: sha('c'),
    });
  });

  it('parses a completed legacy record without started_at and rejects wrong identity or status', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const path = join(planDirectory, 'implementation.yaml');
    await writeOrdinaryRecord(path, {
      plan_id: '20260831-example',
      status: 'completed',
      completed_at: '2026-08-31T02:00:00+08:00',
      commit: sha('d'),
    });
    const legacy = await readOrdinaryRecord(path, '20260831-example');
    expect(legacy?.status).toBe('completed');
    expect(legacy?.started_at).toBeUndefined();

    await expect(readOrdinaryRecord(path, 'another-plan')).rejects.toThrow();
    await writeOrdinaryRecord(path, { plan_id: '20260831-example', status: 'unknown' } as never);
    await expect(readOrdinaryRecord(path, '20260831-example')).rejects.toThrow();
  });
});

describe('startRun', () => {
  it('starts an unsplit plan without fabricating tasks and writes the authoritative record', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const paths = executionPaths(planDirectory);
    const meta = await planMeta(planDirectory);

    const result = await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    expect(result.adopted).toBe(false);
    expect(result.tasks.length).toBe(0);
    expect(result.run.status).toBe('RUNNING');
    expect(result.run.plan_id).toBe(meta.planId);
    expect(result.run.plan_digest).toBe(meta.digest);
    expect(result.run.plan_created_at).toBe('2026-08-31T08:00:00+08:00');
    expect(result.run.created_at).toMatch(CST_TIMESTAMP);
    expect(result.run.updated_at).toMatch(CST_TIMESTAMP);
    expect(result.run.started_at).toMatch(CST_TIMESTAMP);
    expect(await readRun(paths)).toEqual(result.run);

    const record = await readOrdinaryRecord(join(planDirectory, 'implementation.yaml'), meta.planId);
    expect(record?.status).toBe('in-progress');
    expect(record?.started_at).toMatch(/\+08:00$/);
    expect(result.warnings).toEqual([]);
    expect(await eventTypes(paths)).toEqual(['workflow.started']);
    for (const event of (await readEvents(paths)).events) {
      expect(event.timestamp).toMatch(CST_TIMESTAMP);
    }
    const startedCheckpoint = await latestCheckpoint(paths);
    expect(startedCheckpoint.created_at).toMatch(CST_TIMESTAMP);
    const lock = await readLock(paths);
    expect(lock).toBeDefined();
    expect(lock?.acquired_at).toMatch(CST_TIMESTAMP);
  });

  it('normalizes a non-UTC created_at offset to the UTC instant before persisting the run', async () => {
    const root = await newRoot();
    const planDirectory = join(root, '.ai-workflow/plans/20260831-offset');
    const specBody = '# Specification\n\n## REQ-001 Works\n\n## AC-001 Observable';
    const planBody = '# Implementation Plan\n\nImplement REQ-001 and verify AC-001.';
    const attributes = { plan_id: '20260831-offset', status: 'frozen', created_at: '2026-08-31T00:00:00.000+08:00', supersedes: null, requirement_count: 1, acceptance_criteria_count: 1, digest: 'sha256:placeholder' };
    const frozen: (body: string) => string = (body) => renderFrozenMarkdown(attributes, body);
    await writePlanTriplet(planDirectory, 'spec.md', specBody, specBody, frozen);
    await writePlanTriplet(planDirectory, 'plan.md', planBody, planBody, frozen);
    const paths = executionPaths(planDirectory);

    const result = await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    expect(result.run.status).toBe('RUNNING');
    expect(result.run.plan_created_at).toBe('2026-08-31T00:00:00+08:00');
    expect(await readRun(paths)).toEqual(result.run);
    expect(result.warnings).toEqual([]);
  });

  it('adopts a CREATED run, preserving run_id, plan_id and plan_digest', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const prior = await writeExistingRun(planDirectory, { status: 'CREATED' });

    const result = await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    expect(result.adopted).toBe(true);
    expect(result.run.run_id).toBe(prior.run_id);
    expect(result.run.plan_id).toBe(prior.plan_id);
    expect(result.run.plan_digest).toBe(prior.plan_digest);
    expect(result.run.status).toBe('RUNNING');
  });

  it('refuses a second start while a run is active or already completed', async () => {
    for (const status of ['RUNNING', 'PAUSED', 'INTERRUPTED', 'RESUMING', 'COMPLETED'] as const) {
      const root = await newRoot();
      const planDirectory = await frozenPlan(root, false);
      await writeExistingRun(planDirectory, { status });
      await expect(startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG })).rejects.toThrow();
    }
  });

  it('errors on a directory that is not a frozen plan', async () => {
    const root = await newRoot();
    await expect(startRun({ planDirectory: join(root, 'missing'), config: DEFAULT_EXECUTION_CONFIG })).rejects.toThrow();
  });
});

describe('task derivation and two-phase flow', () => {
  it('opens only the first phase and never rewrites frozen plan files', async () => {
    const { planDirectory, paths } = await splitFixture();
    const specBefore = await readFile(join(planDirectory, 'spec.md'), 'utf8');
    const orderBefore = await readFile(join(planDirectory, 'tasks', 'execution-order.yaml'), 'utf8');

    const result = await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    expect(result.run.phase).toBe('1');
    expect(Object.keys(result.run.tasks ?? {}).sort()).toEqual([T1, T2, T3]);
    expect(result.run.tasks?.[T1]?.status).toBe('running');
    expect(result.run.tasks?.[T2]?.status).toBe('running');
    expect(result.run.tasks?.[T3]?.status).toBe('pending');
    expect(await eventsOfType(paths, 'task.started', T1)).toHaveLength(1);
    expect(await eventsOfType(paths, 'task.started', T2)).toHaveLength(1);
    expect(await eventsOfType(paths, 'task.started', T3)).toHaveLength(0);
    expect(await readFile(join(planDirectory, 'spec.md'), 'utf8')).toBe(specBefore);
    expect(await readFile(join(planDirectory, 'tasks', 'execution-order.yaml'), 'utf8')).toBe(orderBefore);
  });

  it('records tasks idempotently, refuses contradictions and opens the next phase on the last peer', async () => {
    const { planDirectory, paths } = await splitFixture();
    await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    const first = await recordTask({ planDirectory, taskId: T1, commit: sha('a') });
    expect(first.idempotent).toBe(false);
    expect(first.run.phase).toBe('1');
    expect(first.run.tasks?.[T1]?.status).toBe('completed');
    expect(first.run.tasks?.[T1]?.commit).toBe(sha('a'));
    expect(first.run.tasks?.[T2]?.status).toBe('running');
    expect(await eventsOfType(paths, 'task.completed', T1)).toHaveLength(1);
    expect(await eventsOfType(paths, 'task.started', T3)).toHaveLength(0);

    const duplicate = await recordTask({ planDirectory, taskId: T1, commit: sha('a') });
    expect(duplicate.idempotent).toBe(true);
    expect(await eventsOfType(paths, 'task.completed', T1)).toHaveLength(1);
    await expect(recordTask({ planDirectory, taskId: T1, commit: sha('b') })).rejects.toThrow();

    await expect(recordTask({ planDirectory, taskId: T3, head: sha('e') })).rejects.toThrow();

    const opened = await recordTask({ planDirectory, taskId: T2, head: sha('f'), });
    expect(opened.idempotent).toBe(false);
    expect(opened.run.phase).toBe('2');
    expect(opened.run.tasks?.[T2]?.status).toBe('completed');
    expect(opened.run.tasks?.[T2]?.head).toBe(sha('f'));
    expect(opened.run.tasks?.[T3]?.status).toBe('running');
    expect(opened.openedPhase ?? []).toContain(T3);
    expect(await eventsOfType(paths, 'task.started', T3)).toHaveLength(1);
    expect(await readLatestCheckpoint(paths)).toMatchObject({ status: 'ok' });
  });

  it('validates commit/head shape and rejects unknown tasks', async () => {
    const { planDirectory } = await splitFixture();
    await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    await expect(recordTask({ planDirectory, taskId: T1 })).rejects.toThrow();
    await expect(recordTask({ planDirectory, taskId: T1, commit: sha('a'), head: sha('b') })).rejects.toThrow();
    await expect(recordTask({ planDirectory, taskId: T1, commit: 'ABCDEF' })).rejects.toThrow();
    await expect(recordTask({ planDirectory, taskId: T1, commit: 'A'.repeat(40) })).rejects.toThrow();
    await expect(recordTask({ planDirectory, taskId: 'task-999-unknown', commit: sha('a') })).rejects.toThrow();
  });

  it('keeps task state usable when a checkpoint write fails', async () => {
    const { planDirectory, paths } = await splitFixture();
    await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });
    await rm(paths.checkpoints, { recursive: true, force: true });
    await writeFile(paths.checkpoints, 'blocked');

    const result = await recordTask({ planDirectory, taskId: T1, commit: sha('a') });
    expect(result.run.tasks?.[T1]?.status).toBe('completed');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(await eventsOfType(paths, 'task.completed', T1)).toHaveLength(1);
  });
});

describe('completion, pause and terminal transitions', () => {
  it('completes a run, releases the lock and is idempotent for the same commit', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const paths = executionPaths(planDirectory);
    const started = await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });
    const startedAt = (await readOrdinaryRecord(join(planDirectory, 'implementation.yaml'), '20260831-example'))?.started_at;

    const done = await completeRun({ planDirectory, commit: sha('c') });
    expect(done.recovered).toBe(false);
    expect(done.run.status).toBe('COMPLETED');
    expect(done.run.completed_at).toMatch(CST_TIMESTAMP);
    expect(done.run.updated_at).toMatch(CST_TIMESTAMP);
    expect(done.run.started_at).toBe(startedAt);
    expect(done.warnings).toEqual([]);
    const record = await readOrdinaryRecord(join(planDirectory, 'implementation.yaml'), '20260831-example');
    expect(record?.status).toBe('completed');
    expect(record?.commit).toBe(sha('c'));
    expect(record?.started_at).toBe(startedAt);
    expect(await eventTypes(paths)).toEqual(['workflow.started', 'workflow.completed']);
    expect(await readLock(paths)).toBeUndefined();

    const repeated = await completeRun({ planDirectory, commit: sha('c') });
    expect(repeated.run.status).toBe('COMPLETED');
    expect(await eventTypes(paths)).toEqual(['workflow.started', 'workflow.completed']);
    expect(started.run.status).toBe('RUNNING');
  });

  it('refuses a different completion commit and completion of a non-running run', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });
    await expect(completeRun({ planDirectory, commit: sha('c') })).resolves.toBeDefined();
    await expect(completeRun({ planDirectory, commit: sha('d') })).rejects.toThrow();

    const pausedRoot = await newRoot();
    const pausedPlan = await frozenPlan(pausedRoot, false);
    await startRun({ planDirectory: pausedPlan, config: DEFAULT_EXECUTION_CONFIG });
    await pauseRun({ planDirectory: pausedPlan });
    await expect(completeRun({ planDirectory: pausedPlan, commit: sha('c') })).rejects.toThrow();
  });

  it('recovers a legacy completed record without inventing started_at', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const legacyStartedAt = '2026-08-31T01:02:03+08:00';
    await writeOrdinaryRecord(join(planDirectory, 'implementation.yaml'), {
      plan_id: '20260831-example',
      status: 'completed',
      started_at: legacyStartedAt,
      completed_at: '2026-08-31T02:02:03+08:00',
      commit: sha('c'),
    });

    const result = await completeRun({ planDirectory, commit: sha('c') });
    expect(result.recovered).toBe(true);
    expect(result.run.status).toBe('COMPLETED');
    expect(result.run.started_at).toBe(legacyStartedAt);
  });

  it('refuses a mismatched commit for legacy recovery', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    await writeOrdinaryRecord(join(planDirectory, 'implementation.yaml'), {
      plan_id: '20260831-example',
      status: 'completed',
      started_at: '2026-08-31T01:02:03+08:00',
      commit: sha('c'),
    });
    await expect(completeRun({ planDirectory, commit: sha('d') })).rejects.toThrow();
  });

  it('pauses with both events, a checkpoint and lock release', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const paths = executionPaths(planDirectory);
    await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    const result = await pauseRun({ planDirectory, summary: 'awaiting user' });

    expect(result.run.status).toBe('PAUSED');
    expect(await eventTypes(paths)).toEqual(['workflow.started', 'execution.interrupted', 'workflow.paused']);
    expect((await readLatestCheckpoint(paths)).status).toBe('ok');
    expect(await readLock(paths)).toBeUndefined();
  });

  it('cancels and fails a run terminally and refuses a second terminal transition', async () => {
    for (const category of [undefined, 'authentication'] as const) {
      const root = await newRoot();
      const planDirectory = await frozenPlan(root, false);
      const paths = executionPaths(planDirectory);
      await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

      const result = category === undefined
        ? await cancelRun({ planDirectory, summary: 'stopped' })
        : await failRun({ planDirectory, category, summary: 'bad credentials' });

      expect(result.run.status).toBe(category === undefined ? 'CANCELLED' : 'FAILED');
      const types = await eventTypes(paths);
      expect(types).toContain(category === undefined ? 'workflow.cancelled' : 'workflow.failed');
      if (category !== undefined) expect(types).toContain('failure.authentication');
      expect(await readLock(paths)).toBeUndefined();
      await expect(cancelRun({ planDirectory })).rejects.toThrow();
    }
  });
});

describe('non-blocking telemetry failure', () => {
  it('keeps the authoritative record in-progress when the execution directory is unwritable', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    await writeFile(join(planDirectory, 'execution'), 'blocked');

    const result = await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    expect(result.run.status).toBe('RUNNING');
    expect(result.warnings.length).toBeGreaterThan(0);
    const record = await readOrdinaryRecord(join(planDirectory, 'implementation.yaml'), '20260831-example');
    expect(record?.status).toBe('in-progress');
  });
});

describe('checkpoint recovery state', () => {
  it('persists the last event id at start and after transitions', async () => {
    const { planDirectory, paths } = await splitFixture();
    await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    const startedCheckpoint = await latestCheckpoint(paths);
    const startedEventId = await lastEventId(paths);
    expect(startedEventId).toBeDefined();
    expect(startedCheckpoint.last_persisted_event_id).toBeTruthy();
    expect(startedCheckpoint.last_persisted_event_id).toBe(startedEventId);

    await recordTask({ planDirectory, taskId: T1, commit: sha('a') });
    const afterTask = await latestCheckpoint(paths);
    expect(afterTask.last_persisted_event_id).toBe(await lastEventId(paths));

    await recordFailure({ planDirectory, category: 'task_execution', taskId: T2, summary: 'build failed' });
    await recordFailure({ planDirectory, category: 'network_timeout', summary: 'timed out' });
    const afterFailure = await latestCheckpoint(paths);
    expect(afterFailure.last_persisted_event_id).toBeTruthy();
    expect(afterFailure.last_persisted_event_id).toBe(await lastEventId(paths));
  });

  it('records concrete attempt counts for a task failure and a global failure', async () => {
    const { planDirectory, paths } = await splitFixture();
    await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    await recordFailure({ planDirectory, category: 'task_execution', taskId: T2, summary: 'build failed' });
    await recordFailure({ planDirectory, category: 'network_timeout', summary: 'timed out' });

    const checkpoint = await latestCheckpoint(paths);
    expect(checkpoint.attempt_counts[T2]).toBe(1);
    expect(checkpoint.attempt_counts.network_timeout).toBe(1);
  });
});

describe('failed-task repair re-entry', () => {
  it('records a repaired task as completed and opens the next phase on the last peer', async () => {
    const { planDirectory, paths } = await splitFixture();
    await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });

    const failed = await recordFailure({ planDirectory, category: 'task_execution', taskId: T2, summary: 'build failed' });
    expect(failed.run.tasks?.[T2]?.status).toBe('failed');
    await recordTask({ planDirectory, taskId: T1, commit: sha('a') });

    const repaired = await recordTask({ planDirectory, taskId: T2, commit: sha('b') });
    expect(repaired.idempotent).toBe(false);
    expect(repaired.run.tasks?.[T2]?.status).toBe('completed');
    expect(repaired.run.tasks?.[T2]?.commit).toBe(sha('b'));
    expect(repaired.run.tasks?.[T3]?.status).toBe('running');
    expect(repaired.openedPhase).toContain(T3);
    expect(await eventsOfType(paths, 'task.completed', T2)).toHaveLength(1);
    expect(await eventsOfType(paths, 'task.started', T3)).toHaveLength(1);
  });
});

describe('idempotent completion lock residue', () => {
  it('removes a same-host crash-residue lock on an idempotent repeat', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const paths = executionPaths(planDirectory);
    await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });
    await completeRun({ planDirectory, commit: sha('c') });
    expect(await readLock(paths)).toBeUndefined();

    await writeFile(paths.lock, `${JSON.stringify({
      owner_id: 'crash-residue-owner',
      pid: 2_000_000_000,
      host: hostname(),
      acquired_at: new Date().toISOString(),
      command: 'execution start',
    }, null, 2)}\n`);
    expect(await readLock(paths)).toBeDefined();

    const repeated = await completeRun({ planDirectory, commit: sha('c') });
    expect(repeated.run.status).toBe('COMPLETED');
    expect(await readLock(paths)).toBeUndefined();
  });
});
describe('boundary event recorder', () => {
  const ALLOWED_BOUNDARY_TYPES = [
    'review.started',
    'review.completed',
    'repair.completed',
    'validation.completed',
  ] as const;
  const CST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
  const SENSITIVE_KEYS = ['prompt', 'reasoning', 'tool_call', 'tool_calls', 'toolCall', 'toolCalls'];

  type Recorder = (input: Record<string, unknown>) => Promise<Record<string, any>>;

  function recorder(): Recorder {
    const fn = (executionManager as unknown as Record<string, unknown>).recordBoundaryEvent;
    expect(typeof fn, 'recordBoundaryEvent is exported by the manager').toBe('function');
    return fn as Recorder;
  }

  function boundaryTypes(): readonly string[] {
    const value = (executionManager as unknown as Record<string, unknown>).BOUNDARY_EVENT_TYPES;
    expect(Array.isArray(value), 'BOUNDARY_EVENT_TYPES is exported by the manager').toBe(true);
    return value as readonly string[];
  }

  async function storedEvents(paths: Paths): Promise<ExecutionEvent[]> {
    return (await readEvents(paths)).events;
  }

  function assertNoSensitive(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) assertNoSensitive(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      for (const forbidden of SENSITIVE_KEYS) {
        expect(key === forbidden, `stored event contains forbidden key ${key}`).toBe(false);
      }
      assertNoSensitive(nested);
    }
  }

  async function runningFixture(status: ExecutionRun['status'] = 'RUNNING') {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    const paths = executionPaths(planDirectory);
    const run = await writeExistingRun(planDirectory, { status });
    const recordPath = join(planDirectory, 'implementation.yaml');
    await writeOrdinaryRecord(recordPath, {
      plan_id: run.plan_id,
      status: 'in-progress',
      started_at: '2026-11-27T01:00:00+08:00',
    });
    const recordBefore = await readFile(recordPath, 'utf8');
    return { planDirectory, paths, run, recordPath, recordBefore };
  }

  it('exports exactly the four allowlisted boundary event types', () => {
    const actual = boundaryTypes();
    expect(new Set([...actual])).toEqual(new Set<string>(ALLOWED_BOUNDARY_TYPES));
    expect(actual).toHaveLength(ALLOWED_BOUNDARY_TYPES.length);
  });

  const successCases = [
    { type: 'review.started', flags: {}, payload: undefined },
    { type: 'review.started', flags: { boundary: 'delivery' }, payload: { boundary: 'delivery' } },
    { type: 'review.completed', flags: { result: 'PASS', boundary: 'delivery' }, payload: { result: 'PASS', boundary: 'delivery' } },
    { type: 'repair.completed', flags: { result: 'applied', boundary: 'delivery' }, payload: { result: 'applied', boundary: 'delivery' } },
    { type: 'validation.completed', flags: { result: 'failed', boundary: 'integration' }, payload: { result: 'failed', boundary: 'integration' } },
  ] as const;

  for (const { type, flags, payload } of successCases) {
    it(`records ${type} with ${JSON.stringify(flags)} as one UTC+08:00 event and a checkpoint`, async () => {
      const fixture = await runningFixture();
      const treeBefore = await snapshotTree(fixture.planDirectory);

      const result = await recorder()({
        planDirectory: fixture.planDirectory,
        type,
        ...flags,
        prompt: 'never-recorded',
        reasoning: 'never-recorded',
      });

      expect(result.valid, JSON.stringify(result)).toBe(true);
      expect(result.plan_id).toBe(fixture.run.plan_id);
      expect(result.run_id).toBe(fixture.run.run_id);
      expect(result.type).toBe(type);
      expect(typeof result.event_id).toBe('string');
      expect(result.event_id).not.toBeNull();
      expect(result.warnings).toEqual([]);

      const event = (await storedEvents(fixture.paths)).at(-1);
      expect(event).toBeDefined();
      if (event === undefined) throw new Error('no event was appended');
      expect(event.type).toBe(type);
      expect(event.event_id).toBe(result.event_id);
      expect(event.timestamp).toMatch(CST);
      if (payload === undefined) {
        expect(Object.hasOwn(event, 'payload')).toBe(false);
      } else {
        expect(event.payload).toEqual(payload);
        expect(Object.keys(event.payload ?? {})).toEqual(Object.keys(payload));
      }
      assertNoSensitive(event);

      const checkpoint = await latestCheckpoint(fixture.paths);
      expect(checkpoint.run_id).toBe(fixture.run.run_id);
      expect(checkpoint.last_persisted_event_id).toBe(result.event_id);

      const changed = changedPaths(treeBefore, await snapshotTree(fixture.planDirectory));
      expect(changed).toContain('execution/events.jsonl');
      expect(changed.some((path) => path.startsWith('execution/checkpoints/'))).toBe(true);
      expect(changed).not.toContain('implementation.yaml');
      expect(await readFile(fixture.recordPath, 'utf8')).toBe(fixture.recordBefore);
    });
  }

  it('trims result and boundary before validation and storage', async () => {
    const fixture = await runningFixture();

    const result = await recorder()({
      planDirectory: fixture.planDirectory,
      type: 'review.completed',
      result: '  PASS  ',
      boundary: '  delivery  ',
    });

    expect(result.valid, JSON.stringify(result)).toBe(true);
    const event = (await storedEvents(fixture.paths)).at(-1);
    expect(event?.payload).toEqual({ result: 'PASS', boundary: 'delivery' });
  });

  const refusals = [
    { label: 'an unlisted event type', status: 'RUNNING', input: { type: 'task.started', result: 'x' } },
    { label: 'validation.completed with no result', status: 'RUNNING', input: { type: 'validation.completed' } },
    { label: 'validation.completed with an empty result', status: 'RUNNING', input: { type: 'validation.completed', result: '' } },
    { label: 'validation.completed with a whitespace result', status: 'RUNNING', input: { type: 'validation.completed', result: '   ' } },
    { label: 'review.completed with a whitespace result', status: 'RUNNING', input: { type: 'review.completed', result: '   ' } },
    { label: 'an empty boundary', status: 'RUNNING', input: { type: 'review.started', boundary: '' } },
    { label: 'a whitespace-only boundary', status: 'RUNNING', input: { type: 'review.started', boundary: '   ' } },
    { label: 'a PAUSED run', status: 'PAUSED', input: { type: 'review.started' } },
    { label: 'a COMPLETED run', status: 'COMPLETED', input: { type: 'review.started' } },
  ] as const;

  for (const { label, status, input } of refusals) {
    it(`refuses ${label} with { valid: false, error } and zero disk writes`, async () => {
      const fixture = await runningFixture(status);
      const treeBefore = await snapshotTree(fixture.planDirectory);

      const result = await recorder()({ planDirectory: fixture.planDirectory, ...input });

      expect(result.valid, JSON.stringify(result)).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
      expect(changedPaths(treeBefore, await snapshotTree(fixture.planDirectory))).toEqual([]);
      expect(await readFile(fixture.recordPath, 'utf8')).toBe(fixture.recordBefore);
      expect(await storedEvents(fixture.paths)).toHaveLength(0);
    });
  }

  it('refuses a live execution lock with zero disk writes', async () => {
    const fixture = await runningFixture();
    await writeFile(fixture.paths.lock, `${JSON.stringify({
      owner_id: 'another-writer',
      pid: process.pid,
      host: hostname(),
      acquired_at: '2026-11-27T01:00:00+08:00',
      command: 'another command',
    }, null, 2)}\n`);
    const treeBefore = await snapshotTree(fixture.planDirectory);

    const result = await recorder()({ planDirectory: fixture.planDirectory, type: 'review.started' });

    expect(result.valid, JSON.stringify(result)).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(changedPaths(treeBefore, await snapshotTree(fixture.planDirectory))).toEqual([]);
    expect(await readFile(fixture.recordPath, 'utf8')).toBe(fixture.recordBefore);
  });

  it('warns with event_id null on a storage write failure and does not retry', async () => {
    const fixture = await runningFixture();
    await rm(fixture.paths.events, { force: true });
    await mkdir(fixture.paths.events, { recursive: true });
    const treeBefore = await snapshotTree(fixture.planDirectory);

    const result = await recorder()({
      planDirectory: fixture.planDirectory,
      type: 'review.completed',
      result: 'PASS',
    });

    expect(result.valid, JSON.stringify(result)).toBe(true);
    expect(result.plan_id).toBe(fixture.run.plan_id);
    expect(result.run_id).toBe(fixture.run.run_id);
    expect(result.type).toBe('review.completed');
    expect(result.event_id).toBeNull();
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning: unknown) => String(warning).toLowerCase().includes('event'))).toBe(true);
    expect(await readdir(fixture.paths.events)).toEqual([]);
    const changed = changedPaths(treeBefore, await snapshotTree(fixture.planDirectory));
    expect(changed).not.toContain('implementation.yaml');
    expect(changed).not.toContain('execution/events.jsonl');
    expect(await readFile(fixture.recordPath, 'utf8')).toBe(fixture.recordBefore);
  });
});
