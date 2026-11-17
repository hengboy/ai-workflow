import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdown } from '../../src/utils/frontmatter.js';
import { readPlan } from '../../src/workflow/parse.js';
import { DEFAULT_EXECUTION_CONFIG } from '../../src/execution/config.js';
import { executionPaths } from '../../src/execution/paths.js';
import { readEvents, readLatestCheckpoint, readLock, readRun, writeRun } from '../../src/execution/store.js';
import type { ExecutionEvent, ExecutionRun } from '../../src/execution/types.js';
import { readOrdinaryRecord, writeOrdinaryRecord } from '../../src/execution/record.js';
import { cancelRun, completeRun, failRun, pauseRun, recordTask, startRun } from '../../src/execution/manager.js';
import { frozenPlan, temporary, workspacePlanFixture } from '../helpers.js';

// Public boundary under test: the lenient authoritative-record reader/writer and the
// run-lifecycle manager. Frozen plan/task fixtures are produced by the shared helpers so
// their self-referential digests are genuine and `readPlan` accepts them.

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
    expect(result.run.plan_created_at).toBe(meta.createdAt);
    expect(await readRun(paths)).toEqual(result.run);

    const record = await readOrdinaryRecord(join(planDirectory, 'implementation.yaml'), meta.planId);
    expect(record?.status).toBe('in-progress');
    expect(record?.started_at).toMatch(/\+08:00$/);
    expect(result.warnings).toEqual([]);
    expect(await eventTypes(paths)).toEqual(['workflow.started']);
    expect(await readLock(paths)).toBeDefined();
    expect((await readLatestCheckpoint(paths)).status).toBe('ok');
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
    expect(done.run.completed_at).toBeDefined();
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
