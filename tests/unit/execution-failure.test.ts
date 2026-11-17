import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionConfig } from '../../src/execution/config.js';
import { DEFAULT_EXECUTION_CONFIG } from '../../src/execution/config.js';
import { executionPaths } from '../../src/execution/paths.js';
import { readEvents, readLock, readRun } from '../../src/execution/store.js';
import type { ExecutionEvent, FailureCategory } from '../../src/execution/types.js';
import { classifyFailure, redactFailureSummary } from '../../src/execution/failure.js';
import { completeRun, failRun, recordFailure, startRun } from '../../src/execution/manager.js';
import { frozenPlan, temporary } from '../helpers.js';

// Public boundary under test: failure classification, bounded redaction and the
// manager's failure transitions. The classifier takes the Retry-After override as an
// optional fourth argument; the cast keeps the test independent of how narrowly the
// implementation declares that parameter.

type Classification = { action: 'retry' | 'pause' | 'repair'; retryDelaySeconds?: number };
type ClassifyFailure = (
  category: FailureCategory,
  failureCount: number,
  config: ExecutionConfig,
  retryAfterSeconds?: number,
) => Classification;
const classify = classifyFailure as ClassifyFailure;

const CONFIG: ExecutionConfig = { ...DEFAULT_EXECUTION_CONFIG, maxRetries: 2, retryBaseDelayMs: 1000 };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(withTasks = false): Promise<{ planDirectory: string; paths: ReturnType<typeof executionPaths> }> {
  const root = await temporary('ai-workflow-exec-failure-');
  roots.push(root);
  const planDirectory = await frozenPlan(root, withTasks);
  return { planDirectory, paths: executionPaths(planDirectory) };
}

async function started(planDirectory: string): Promise<void> {
  await startRun({ planDirectory, config: CONFIG });
}

async function eventTypes(paths: ReturnType<typeof executionPaths>): Promise<string[]> {
  return (await readEvents(paths)).events.map((event) => event.type);
}

async function eventsOfType(paths: ReturnType<typeof executionPaths>, type: ExecutionEvent['type']): Promise<ExecutionEvent[]> {
  return (await readEvents(paths)).events.filter((event) => event.type === type);
}

describe('failure classification', () => {
  it('maps retryable categories to bounded retries and then pause with exact exponential delays', () => {
    const retryable: FailureCategory[] = ['model_unavailable', 'network_timeout', 'network_disconnect', 'rate_limit'];
    for (const category of retryable) {
      expect(classify(category, 1, CONFIG)).toEqual({ action: 'retry', retryDelaySeconds: 1 });
      expect(classify(category, 2, CONFIG)).toEqual({ action: 'retry', retryDelaySeconds: 2 });
      expect(classify(category, 3, CONFIG)).toEqual({ action: 'pause' });
      expect(classify(category, 5, CONFIG).action).toBe('pause');
    }
  });

  it('honors a different base delay in seconds', () => {
    const config: ExecutionConfig = { ...CONFIG, retryBaseDelayMs: 250 };
    expect(classify('network_timeout', 1, config)).toEqual({ action: 'retry', retryDelaySeconds: 0.25 });
    expect(classify('network_timeout', 2, config)).toEqual({ action: 'retry', retryDelaySeconds: 0.5 });
  });

  it('pauses immediately for quota, authentication, process-exit and session-loss failures', () => {
    for (const category of ['quota', 'authentication', 'agent_process_exit', 'session_lost'] as const) {
      expect(classify(category, 1, CONFIG)).toEqual({ action: 'pause' });
      expect(classify(category, 4, CONFIG).action).toBe('pause');
    }
  });

  it('routes task_execution to repair without a retry delay', () => {
    expect(classify('task_execution', 1, CONFIG)).toEqual({ action: 'repair' });
    expect(classify('task_execution', 3, CONFIG)).toEqual({ action: 'repair' });
  });

  it('lets an explicit non-negative integer Retry-After win and ignores invalid values', () => {
    expect(classify('rate_limit', 1, CONFIG, 12)).toEqual({ action: 'retry', retryDelaySeconds: 12 });
    expect(classify('rate_limit', 2, CONFIG, 0)).toEqual({ action: 'retry', retryDelaySeconds: 0 });
    expect(classify('rate_limit', 1, CONFIG, -5)).toEqual({ action: 'retry', retryDelaySeconds: 1 });
    expect(classify('rate_limit', 1, CONFIG, 2.5)).toEqual({ action: 'retry', retryDelaySeconds: 1 });
    expect(classify('quota', 1, CONFIG, 99).action).toBe('pause');
  });
});

describe('redaction and bounded summaries', () => {
  it('removes API keys, bearer tokens, passwords and token assignments', () => {
    const text = [
      'failure with sk-abcdefghijklmnopqrstuvwxyz',
      'api_key=SUPERSECRETVALUE',
      'apikey: OTHERSECRETVALUE',
      'Bearer BEARERVALUE123',
      'password: hunter2password',
      'token=TOKENVALUE123',
      'but the ordinary detail survives',
    ].join(' ');
    const redacted = redactFailureSummary(text);

    expect(redacted).toContain('[REDACTED]');
    for (const secret of [
      'sk-abcdefghijklmnopqrstuvwxyz',
      'SUPERSECRETVALUE',
      'OTHERSECRETVALUE',
      'BEARERVALUE123',
      'hunter2password',
      'TOKENVALUE123',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('ordinary detail survives');
  });

  it('bounds length to 500 by default and to an explicit limit, leaving short text intact', () => {
    expect(redactFailureSummary('x'.repeat(900)).length).toBeLessThanOrEqual(500);
    expect(redactFailureSummary('y'.repeat(200), 80).length).toBeLessThanOrEqual(80);
    expect(redactFailureSummary('plain failure')).toBe('plain failure');
  });
});

describe('recordFailure lifecycle effects', () => {
  it('returns retry guidance, keeps RUNNING and stores a redacted bounded summary', async () => {
    const { planDirectory, paths } = await fixture(false);
    await started(planDirectory);

    const first = await recordFailure({
      planDirectory,
      category: 'network_timeout',
      summary: 'temporary outage',
    });
    expect(first.action).toBe('retry');
    expect(first.retryDelaySeconds).toBe(1);
    expect(first.failureCount).toBe(1);
    expect(first.category).toBe('network_timeout');
    expect(first.run.status).toBe('RUNNING');
    expect(first.run.last_failure?.category).toBe('network_timeout');
    expect(first.run.last_failure?.summary).toBe('temporary outage');
    expect(await eventsOfType(paths, 'failure.network_timeout')).toHaveLength(1);

    const second = await recordFailure({ planDirectory, category: 'network_timeout' });
    expect(second.action).toBe('retry');
    expect(second.retryDelaySeconds).toBe(2);
    expect(second.failureCount).toBe(2);

    const third = await recordFailure({ planDirectory, category: 'network_timeout' });
    expect(third.action).toBe('pause');
    expect(third.failureCount).toBe(3);
    expect(third.run.status).toBe('PAUSED');
    expect(await readLock(paths)).toBeUndefined();
  });

  it('redacts the persisted summary and bounds it to 500 characters', async () => {
    const { planDirectory } = await fixture(false);
    await started(planDirectory);
    const text = `Bearer BIGSECRETVALUE and ${'z'.repeat(900)}`;

    const result = await recordFailure({ planDirectory, category: 'authentication', summary: text });

    expect(result.action).toBe('pause');
    expect(result.run.last_failure?.summary).not.toContain('BIGSECRETVALUE');
    expect(result.run.last_failure?.summary.length).toBeLessThanOrEqual(500);
  });

  it('routes task_execution to repair, marks the task failed and never starts a retry loop', async () => {
    const { planDirectory, paths } = await fixture(true);
    await started(planDirectory);
    const taskId = 'task-001-example';

    const first = await recordFailure({ planDirectory, category: 'task_execution', summary: 'task crashed', taskId });
    expect(first.action).toBe('repair');
    expect(first.run.status).toBe('RUNNING');
    expect(first.run.tasks?.[taskId]?.status).toBe('failed');
    expect(await eventsOfType(paths, 'task.failed')).toHaveLength(1);
    expect(await eventsOfType(paths, 'failure.task_execution')).toHaveLength(1);
    expect(await eventsOfType(paths, 'workflow.paused')).toHaveLength(0);

    for (let count = 2; count <= 4; count += 1) {
      const repeated = await recordFailure({ planDirectory, category: 'task_execution', taskId });
      expect(repeated.action).toBe('repair');
      expect(repeated.failureCount).toBe(count);
      expect(repeated.run.status).toBe('RUNNING');
    }
    expect(await eventsOfType(paths, 'workflow.paused')).toHaveLength(0);
    expect(await eventsOfType(paths, 'task.failed')).toHaveLength(1);
  });

  it('pauses on a non-retryable failure, releasing the lock, and repeats without a repair loop', async () => {
    const { planDirectory, paths } = await fixture(false);
    await started(planDirectory);

    const first = await recordFailure({ planDirectory, category: 'quota', summary: 'quota exhausted' });
    expect(first.action).toBe('pause');
    expect(first.run.status).toBe('PAUSED');
    expect(first.run.last_failure?.summary).toBe('quota exhausted');
    expect(await eventTypes(paths)).toEqual([
      'workflow.started',
      'failure.quota',
      'workflow.paused',
    ]);
    expect(await readLock(paths)).toBeUndefined();

    const repeated = await recordFailure({ planDirectory, category: 'quota' });
    expect(repeated.action).toBe('pause');
    expect(repeated.failureCount).toBe(2);
    expect(await eventsOfType(paths, 'task.failed')).toHaveLength(0);
    expect(await eventsOfType(paths, 'workflow.failed')).toHaveLength(0);
  });

  it('records a terminal workflow.failed and refuses restart or completion at this layer', async () => {
    const { planDirectory, paths } = await fixture(false);
    await started(planDirectory);

    const terminal = await failRun({ planDirectory, category: 'authentication', summary: 'bad credentials' });
    expect(terminal.run.status).toBe('FAILED');
    const types = await eventTypes(paths);
    expect(types).toContain('failure.authentication');
    expect(types).toContain('workflow.failed');
    expect(await readLock(paths)).toBeUndefined();
    expect((await readRun(paths)).status).toBe('FAILED');

    await expect(startRun({ planDirectory, config: CONFIG })).rejects.toThrow();
    await expect(completeRun({ planDirectory, commit: 'a'.repeat(40) })).rejects.toThrow();
    await expect(failRun({ planDirectory, category: 'quota' })).rejects.toThrow();
  });

  it('refuses to record a failure for a non-running run', async () => {
    const { planDirectory } = await fixture(false);
    await expect(recordFailure({ planDirectory, category: 'quota' })).rejects.toThrow();
  });
});
