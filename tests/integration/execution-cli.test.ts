import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  changedPaths,
  frozenPlan,
  snapshotTree,
  temporary,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
} from '../helpers.js';

// CLI boundary: the `execution` command group is the program-owned, read-only-queryable overlay
// for a frozen-plan run. Mutation commands write local state under the plan directory; query
// commands (status/show/events/history/analytics) write nothing and run no Git or network call.
// These tests drive the real CLI process and assert concrete values and ordering.

const TIMEOUT = 90_000;
const PLAN_ID = '20261117-cli-flow';
const OTHER_PLAN_ID = '20261118-cli-other';
const TASK_A = 'task-001-a';
const TASK_B = 'task-002-b';

const SHA_ONE = 'a'.repeat(40);
const SHA_TWO = 'b'.repeat(40);
const SHA_THREE = 'c'.repeat(40);
const SHA_OTHER = '9'.repeat(40);

interface CliResult { code: number; stdout: string; stderr: string }
type Json = Record<string, any>;

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

/** Drive the real CLI exactly as an operator would. No stdin is supplied. */
async function runCli(args: string[]): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end();
  });
}

function execution(...args: string[]): Promise<CliResult> {
  return runCli(['execution', ...args]);
}

function parseJson<T extends Json = Json>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

function expectRefusal(result: CliResult): Json {
  expect(result.code, outputOf(result)).toBe(1);
  const parsed = parseJson(result);
  expect(parsed.valid).toBe(false);
  expect(typeof parsed.error, outputOf(result)).toBe('string');
  return parsed;
}

function splitSpec(planId = PLAN_ID): WorkspacePlanFixtureSpec {
  return {
    planId,
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    // No workspaceRepos and no manifest: an ordinary frozen split plan.
    tasks: [
      { id: TASK_A, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/a.ts'] },
      { id: TASK_B, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/b.ts'] },
    ],
    phases: [[TASK_A], [TASK_B]],
  };
}

interface SplitFixture { root: string; planDirectory: string }

async function splitFixture(planId = PLAN_ID): Promise<SplitFixture> {
  const root = await temporary('ai-workflow-execution-cli-');
  const planDirectory = await workspacePlanFixture(root, splitSpec(planId));
  return { root, planDirectory };
}

async function startSplit(planId = PLAN_ID): Promise<SplitFixture> {
  const fixture = await splitFixture(planId);
  await startRun(fixture.planDirectory);
  return fixture;
}

/** Start a run for an already-created plan directory. */
async function startRun(planDirectory: string): Promise<void> {
  const started = await execution('start', '--plan', planDirectory);
  expect(started.code, outputOf(started)).toBe(0);
  expect(parseJson(started).valid).toBe(true);
}

/** Add another frozen split plan under an existing project root. */
async function addSplit(root: string, planId: string): Promise<string> {
  return workspacePlanFixture(root, splitSpec(planId));
}

async function readRecord(planDirectory: string): Promise<Json> {
  return parseYaml(await readFile(join(planDirectory, 'implementation.yaml'), 'utf8')) as Json;
}

async function readEvents(planDirectory: string): Promise<Json[]> {
  const text = await readFile(join(planDirectory, 'execution', 'events.jsonl'), 'utf8');
  return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Json);
}

function eventType(event: Json): string {
  const value = event.type ?? event.event;
  return typeof value === 'string' ? value : '';
}

const FORBIDDEN_EVENT_KEYS = ['prompt', 'reasoning', 'tool_call', 'tool_calls', 'toolCall', 'toolCalls', 'token_text', 'tokenText'];

function assertNoSensitiveEventKeys(events: Json[]): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Json)) {
      for (const forbidden of FORBIDDEN_EVENT_KEYS) {
        expect(key === forbidden, `event contains forbidden key ${key}`).toBe(false);
      }
      visit(nested);
    }
  };
  visit(events);
}

describe('execution start', () => {
  it('starts a run, writes the authoritative record and one checkpoint, and emits workflow.started', async () => {
    const { planDirectory } = await splitFixture();

    const result = await execution('start', '--plan', planDirectory);

    expect(result.code, outputOf(result)).toBe(0);
    const body = parseJson(result);
    expect(body.valid).toBe(true);
    expect(body.plan_id).toBe(PLAN_ID);
    expect(body.plan_digest).toMatch(/^sha256:/);
    expect(typeof body.run_id).toBe('string');
    expect(body.run_id.length).toBeGreaterThan(0);
    expect(body.status).toBe('RUNNING');
    expect(body.phase).toBeDefined();
    expect(body.tasks).toEqual([TASK_A, TASK_B]);
    expect(body.adopted).toBe(false);
    expect(Array.isArray(body.warnings)).toBe(true);

    const record = await readRecord(planDirectory);
    expect(record.status).toBe('in-progress');
    expect(record.started_at).toBeTruthy();

    const tree = await snapshotTree(planDirectory);
    const paths = [...tree.keys()];
    expect(paths).toContain('implementation.yaml');
    expect(paths).toContain('execution/run.json');
    expect(paths).toContain('execution/events.jsonl');
    expect(paths).toContain('execution/lock.json');
    expect(paths.filter((path) => path.includes('checkpoint'))).toHaveLength(1);

    const events = await readEvents(planDirectory);
    expect(events.map(eventType)).toContain('workflow.started');
    assertNoSensitiveEventKeys(events);
  }, TIMEOUT);

  it('binds an optional --repository and refuses a second start of the active run', async () => {
    const { planDirectory } = await splitFixture();

    const first = await execution('start', '--plan', planDirectory, '--repository', 'app');
    expect(first.code, outputOf(first)).toBe(0);
    expect(parseJson(first).valid).toBe(true);

    const second = await execution('start', '--plan', planDirectory);
    expectRefusal(second);

    const status = parseJson(await execution('status', '--plan', planDirectory));
    expect(status.runs[0].repository).toBe('app');
  }, TIMEOUT);
});

describe('execution task', () => {
  it('records a split task, is idempotent on an identical repeat, and opens the next phase', async () => {
    const { planDirectory } = await startSplit();

    const first = await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_ONE);
    expect(first.code, outputOf(first)).toBe(0);
    const body = parseJson(first);
    expect(body.valid).toBe(true);
    expect(body.plan_id).toBe(PLAN_ID);
    expect(typeof body.run_id).toBe('string');
    expect(body.status).toBe('RUNNING');
    expect(body.phase).toBeDefined();
    expect(body.task_id).toBe(TASK_A);
    expect(body.task_status).toBe('completed');
    expect(body.idempotent).toBe(false);
    expect(body.opened_phase).toEqual([TASK_B]);
    expect(Array.isArray(body.warnings)).toBe(true);

    const repeat = await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_ONE);
    expect(repeat.code, outputOf(repeat)).toBe(0);
    const repeatBody = parseJson(repeat);
    expect(repeatBody.idempotent).toBe(true);
    expect(repeatBody.task_status).toBe('completed');

    const events = await readEvents(planDirectory);
    expect(events.filter((event) => eventType(event) === 'task.completed')).toHaveLength(1);
    assertNoSensitiveEventKeys(events);
  }, TIMEOUT);

  it('accepts --head and refuses a contradictory commit or an unknown task', async () => {
    const { planDirectory } = await startSplit();

    const head = await execution('task', TASK_A, '--plan', planDirectory, '--head', SHA_ONE);
    expect(head.code, outputOf(head)).toBe(0);
    expect(parseJson(head).task_status).toBe('completed');

    const contradictory = await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_OTHER);
    expectRefusal(contradictory);

    const unknown = await execution('task', 'task-999-ghost', '--plan', planDirectory, '--commit', SHA_ONE);
    expectRefusal(unknown);
  }, TIMEOUT);
});

describe('execution complete', () => {
  it('completes with validation and review events ordered before workflow.completed, and is idempotent', async () => {
    const { planDirectory } = await startSplit();
    await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_ONE);
    await execution('task', TASK_B, '--plan', planDirectory, '--commit', SHA_TWO);

    const result = await execution('complete', '--plan', planDirectory, '--commit', SHA_THREE, '--validation', 'passed', '--review', 'PASS');
    expect(result.code, outputOf(result)).toBe(0);
    const body = parseJson(result);
    expect(body.valid).toBe(true);
    expect(body.plan_id).toBe(PLAN_ID);
    expect(typeof body.run_id).toBe('string');
    expect(body.status).toBe('COMPLETED');
    expect(body.commit).toBe(SHA_THREE);
    expect(body.recovered).toBe(false);
    expect(Array.isArray(body.warnings)).toBe(true);

    const types = (await readEvents(planDirectory)).map(eventType);
    const validation = types.indexOf('validation.completed');
    const review = types.indexOf('review.completed');
    const completed = types.indexOf('workflow.completed');
    expect(validation).toBeGreaterThanOrEqual(0);
    expect(review).toBeGreaterThan(validation);
    expect(completed).toBeGreaterThan(review);

    const repeat = await execution('complete', '--plan', planDirectory, '--commit', SHA_THREE);
    expect(repeat.code, outputOf(repeat)).toBe(0);
    expect(parseJson(repeat).status).toBe('COMPLETED');

    const mismatched = await execution('complete', '--plan', planDirectory, '--commit', SHA_OTHER);
    expectRefusal(mismatched);
  }, TIMEOUT);
});

describe('execution pause and cancel', () => {
  it('pause releases the lock and records execution.interrupted then workflow.paused', async () => {
    const { planDirectory } = await startSplit();

    const result = await execution('pause', '--plan', planDirectory, '--summary', 'awaiting user');
    expect(result.code, outputOf(result)).toBe(0);
    expect(parseJson(result).status).toBe('PAUSED');

    const types = (await readEvents(planDirectory)).map(eventType);
    expect(types.indexOf('execution.interrupted')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('workflow.paused')).toBeGreaterThan(types.indexOf('execution.interrupted'));

    const shown = parseJson(await execution('show', '--plan', planDirectory));
    expect(shown.lock === null || shown.lock.state === 'none').toBe(true);
  }, TIMEOUT);

  it('cancel records workflow.cancelled and releases the lock', async () => {
    const { planDirectory } = await startSplit();

    const result = await execution('cancel', '--plan', planDirectory);
    expect(result.code, outputOf(result)).toBe(0);
    expect(parseJson(result).status).toBe('CANCELLED');

    const types = (await readEvents(planDirectory)).map(eventType);
    expect(types).toContain('workflow.cancelled');

    const shown = parseJson(await execution('show', '--plan', planDirectory));
    expect(shown.lock === null || shown.lock.state === 'none').toBe(true);
  }, TIMEOUT);
});

describe('execution failure', () => {
  it('returns retry (exit 2) twice then pause, and honours --retry-after', async () => {
    const { planDirectory } = await startSplit();

    const first = await execution('failure', '--plan', planDirectory, '--category', 'network_timeout', '--summary', 'timed out');
    expect(first.code, outputOf(first)).toBe(2);
    const firstBody = parseJson(first);
    expect(firstBody.valid).toBe(true);
    expect(firstBody.category).toBe('network_timeout');
    expect(firstBody.action).toBe('retry');
    expect(firstBody.failure_count).toBe(1);

    const delayed = await execution('failure', '--plan', planDirectory, '--category', 'network_timeout', '--retry-after', '30');
    expect(delayed.code, outputOf(delayed)).toBe(2);
    expect(parseJson(delayed).retry_delay_seconds).toBe(30);

    const third = await execution('failure', '--plan', planDirectory, '--category', 'network_timeout');
    expect(third.code, outputOf(third)).toBe(0);
    const thirdBody = parseJson(third);
    expect(thirdBody.action).toBe('pause');
    expect(thirdBody.failure_count).toBe(3);
    expect(thirdBody.status).toBe('PAUSED');
    assertNoSensitiveEventKeys(await readEvents(planDirectory));
  }, TIMEOUT);

  it('quota and authentication pause without retry while failure_count increments', async () => {
    const quotaFixture = await startSplit();
    const quota = await execution('failure', '--plan', quotaFixture.planDirectory, '--category', 'quota');
    expect(quota.code, outputOf(quota)).toBe(0);
    const quotaBody = parseJson(quota);
    expect(quotaBody.category).toBe('quota');
    expect(quotaBody.action).toBe('pause');
    expect(quotaBody.status).toBe('PAUSED');

    const authFixture = await startSplit();
    const auth = await execution('failure', '--plan', authFixture.planDirectory, '--category', 'authentication');
    expect(auth.code, outputOf(auth)).toBe(0);
    const authBody = parseJson(auth);
    expect(authBody.category).toBe('authentication');
    expect(authBody.action).toBe('pause');
    expect(authBody.failure_count).toBe(1);
  }, TIMEOUT);

  it('task_execution returns repair and --terminal fails the run and releases the lock', async () => {
    const { planDirectory } = await startSplit();

    const repair = await execution('failure', '--plan', planDirectory, '--category', 'task_execution', '--task', TASK_A);
    expect(repair.code, outputOf(repair)).toBe(0);
    expect(parseJson(repair).action).toBe('repair');

    const terminal = await execution('failure', '--plan', planDirectory, '--category', 'network_timeout', '--terminal');
    expect(terminal.code, outputOf(terminal)).toBe(0);
    const terminalBody = parseJson(terminal);
    expect(terminalBody.status).toBe('FAILED');

    const shown = parseJson(await execution('show', '--plan', planDirectory));
    expect(shown.lock === null || shown.lock.state === 'none').toBe(true);
  }, TIMEOUT);
});

describe('execution status', () => {
  it('reports runs sorted by plan_directory with the full run entry shape', async () => {
    const root = await temporary('ai-workflow-execution-cli-');
    const otherDirectory = await addSplit(root, OTHER_PLAN_ID);
    const mainDirectory = await addSplit(root, PLAN_ID);
    await startRun(otherDirectory);
    await startRun(mainDirectory);

    const result = await execution('status', '--project', root);
    expect(result.code, outputOf(result)).toBe(0);
    const body = parseJson(result);
    expect(body.valid).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0].plan_directory < body.runs[1].plan_directory).toBe(true);
    expect(body.runs.map((run: Json) => run.plan_id).sort()).toEqual([PLAN_ID, OTHER_PLAN_ID]);
    for (const run of body.runs) {
      for (const key of ['plan_id', 'plan_directory', 'run_id', 'repository', 'status', 'phase', 'updated_at', 'last_failure', 'degraded', 'warnings']) {
        expect(Object.hasOwn(run, key), `run entry has ${key}`).toBe(true);
      }
      expect(['none', 'held', 'stale', 'other-host', 'unreadable']).toContain(run.lock.state);
      expect(run.status).toBe('RUNNING');
      expect(run.tasks).toMatchObject({ total: 2 });
      expect(Array.isArray(run.warnings)).toBe(true);
      expect(typeof run.degraded).toBe('boolean');
    }
    expect(mainDirectory).toBeTruthy();
  }, TIMEOUT);

  it('returns an empty valid run list for a project with no runs and refuses an invalid --plan', async () => {
    const empty = await temporary('ai-workflow-execution-empty-');
    const emptyResult = await execution('status', '--project', empty);
    expect(emptyResult.code, outputOf(emptyResult)).toBe(0);
    expect(parseJson(emptyResult)).toMatchObject({ valid: true, runs: [], warnings: [] });

    const { planDirectory } = await splitFixture();
    const invalid = await execution('status', '--plan', join(planDirectory, 'missing'));
    expectRefusal(invalid);
  }, TIMEOUT);
});

describe('execution show', () => {
  it('shows a single run selected by --project and refuses zero or ambiguous runs', async () => {
    const { root, planDirectory } = await startSplit();

    const shown = await execution('show', '--project', root);
    expect(shown.code, outputOf(shown)).toBe(0);
    const body = parseJson(shown);
    expect(body.valid).toBe(true);
    expect(body.run.plan_id).toBe(PLAN_ID);
    expect(['ok', 'absent', 'manual']).toContain(body.checkpoint.status);
    expect(Array.isArray(body.checkpoint.warnings)).toBe(true);
    expect(typeof body.events.count).toBe('number');
    expect(typeof body.events.truncated).toBe('boolean');
    expect(Array.isArray(body.events.warnings)).toBe(true);
    expect(typeof body.diagnostics.degraded).toBe('boolean');
    expect(Array.isArray(body.diagnostics.warnings)).toBe(true);
    expect(body.lock.state).toBe('stale');

    const empty = await temporary('ai-workflow-execution-empty-');
    const zero = await execution('show', '--project', empty);
    expect(zero.code, outputOf(zero)).toBe(1);
    expect(parseJson(zero).valid).toBe(false);
    expect(typeof parseJson(zero).error, outputOf(zero)).toBe('string');

    await startRun(await addSplit(root, OTHER_PLAN_ID));
    const ambiguous = await execution('show', '--project', root);
    expect(ambiguous.code, outputOf(ambiguous)).toBe(1);
    expect(parseJson(ambiguous).valid).toBe(false);
    expect(typeof parseJson(ambiguous).error, outputOf(ambiguous)).toBe('string');

    expect(planDirectory).toBeTruthy();
  }, TIMEOUT);
});

describe('execution events', () => {
  it('bounds the stream by --limit and reports truncation, without sensitive keys', async () => {
    const { planDirectory } = await startSplit();
    await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_ONE);
    await execution('task', TASK_B, '--plan', planDirectory, '--commit', SHA_TWO);
    await execution('complete', '--plan', planDirectory, '--commit', SHA_THREE, '--validation', 'passed');

    const all = parseJson(await execution('events', '--plan', planDirectory));
    expect(all.valid).toBe(true);
    expect(all.plan_id).toBe(PLAN_ID);
    expect(typeof all.run_id).toBe('string');
    expect(all.events.length).toBeGreaterThan(2);
    assertNoSensitiveEventKeys(all.events);

    const limited = parseJson(await execution('events', '--plan', planDirectory, '--limit', '2'));
    expect(limited.events).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    assertNoSensitiveEventKeys(limited.events);
  }, TIMEOUT);
});

describe('execution history', () => {
  it('lists per-run history and returns an empty list for an empty project', async () => {
    const { root, planDirectory } = await startSplit();
    await execution('complete', '--plan', planDirectory, '--commit', SHA_ONE);

    const result = await execution('history', '--project', root);
    expect(result.code, outputOf(result)).toBe(0);
    const body = parseJson(result);
    expect(body.valid).toBe(true);
    expect(body.runs).toHaveLength(1);
    for (const key of ['plan_id', 'plan_directory', 'run_id', 'repository', 'status', 'phase', 'started_at', 'completed_at', 'failure_count']) {
      expect(Object.hasOwn(body.runs[0], key), `history run has ${key}`).toBe(true);
    }
    expect(body.runs[0].status).toBe('COMPLETED');
    expect(body.runs[0].completed_at).toBeTruthy();

    const empty = await temporary('ai-workflow-execution-empty-');
    const emptyResult = await execution('history', '--project', empty);
    expect(emptyResult.code, outputOf(emptyResult)).toBe(0);
    expect(parseJson(emptyResult).runs).toEqual([]);
  }, TIMEOUT);
});

describe('execution analytics', () => {
  it('reports ' + "'N/A'" + ' for unavailable metrics on a run with no task or host data', async () => {
    const root = await temporary('ai-workflow-execution-unsplit-');
    const planDirectory = await frozenPlan(root, false); // no frozen tasks
    const started = await execution('start', '--plan', planDirectory);
    expect(started.code, outputOf(started)).toBe(0);
    const completed = await execution('complete', '--plan', planDirectory, '--commit', SHA_ONE);
    expect(completed.code, outputOf(completed)).toBe(0);

    const result = await execution('analytics', '--plan', planDirectory);
    expect(result.code, outputOf(result)).toBe(0);
    const body = parseJson(result);
    expect(body.valid).toBe(true);
    expect(body.scope).toBe('plan');
    expect(body.runs).toHaveLength(1);
    const metric = body.runs[0];
    for (const key of ['plan_id', 'run_id', 'repository', 'workflow_duration_seconds', 'task_success_rate', 'average_task_duration_seconds', 'retry_count', 'interruption_count', 'recovery_success_rate', 'token_usage', 'model_cost', 'validation_result', 'review_result', 'warnings']) {
      expect(Object.hasOwn(metric, key), `metric has ${key}`).toBe(true);
    }
    expect(metric.task_success_rate).toBe('N/A');
    expect(metric.average_task_duration_seconds).toBe('N/A');
    expect(metric.token_usage).toBe('N/A');
    expect(metric.model_cost).toBe('N/A');
  }, TIMEOUT);

  it('supports project scope', async () => {
    const { root, planDirectory } = await startSplit();
    await execution('complete', '--plan', planDirectory, '--commit', SHA_ONE);

    const result = await execution('analytics', '--project', root);
    expect(result.code, outputOf(result)).toBe(0);
    const body = parseJson(result);
    expect(body.valid).toBe(true);
    expect(body.scope).toBe('project');
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);
});

describe('execution query commands are read-only and deterministic', () => {
  it('write no path and print byte-identical JSON on repeated calls', async () => {
    const { root, planDirectory } = await startSplit();
    await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_ONE);
    await execution('complete', '--plan', planDirectory, '--commit', SHA_TWO, '--validation', 'passed', '--review', 'PASS');

    const queries: string[][] = [
      ['status', '--project', root],
      ['show', '--plan', planDirectory],
      ['events', '--plan', planDirectory],
      ['history', '--project', root],
      ['analytics', '--plan', planDirectory],
    ];
    for (const query of queries) {
      const before = await snapshotTree(root);
      const first = await execution(...query);
      expect(first.code, `${query[0]} query exits 0\n${outputOf(first)}`).toBe(0);
      const after = await snapshotTree(root);
      expect(changedPaths(before, after), `${query[0]} writes no path`).toEqual([]);
    }

    const statusA = await execution('status', '--project', root);
    const statusB = await execution('status', '--project', root);
    expect(statusA.stdout).toBe(statusB.stdout);
    const eventsA = await execution('events', '--plan', planDirectory);
    const eventsB = await execution('events', '--plan', planDirectory);
    expect(eventsA.stdout).toBe(eventsB.stdout);
  }, TIMEOUT);
});

describe('execution start and completion boundary regressions', () => {
  it('refuses a blank repository without writing the record or run, then a normal start succeeds', async () => {
    const { planDirectory } = await splitFixture();
    expectRefusal(await execution('start', '--plan', planDirectory, '--repository', ''));

    const paths = [...(await snapshotTree(planDirectory)).keys()];
    expect(paths).not.toContain('implementation.yaml');
    expect(paths).not.toContain('execution/run.json');

    const normal = await execution('start', '--plan', planDirectory);
    expect(normal.code, outputOf(normal)).toBe(0);
    expect(parseJson(normal).valid).toBe(true);
  }, TIMEOUT);

  it('appends no validation or review events on a refused completion of a paused run', async () => {
    const { planDirectory } = await startSplit();
    const paused = await execution('pause', '--plan', planDirectory);
    expect(paused.code, outputOf(paused)).toBe(0);

    const recordBefore = await readFile(join(planDirectory, 'implementation.yaml'), 'utf8');
    const runBefore = await readFile(join(planDirectory, 'execution', 'run.json'), 'utf8');
    const eventsBefore = await readEvents(planDirectory);

    expectRefusal(await execution('complete', '--plan', planDirectory, '--commit', SHA_ONE, '--validation', 'x', '--review', 'y'));

    const eventsAfter = await readEvents(planDirectory);
    const types = eventsAfter.map(eventType);
    expect(types).not.toContain('validation.completed');
    expect(types).not.toContain('review.completed');
    expect(eventsAfter).toHaveLength(eventsBefore.length);
    expect(await readFile(join(planDirectory, 'implementation.yaml'), 'utf8')).toBe(recordBefore);
    expect(await readFile(join(planDirectory, 'execution', 'run.json'), 'utf8')).toBe(runBefore);
  }, TIMEOUT);

  it('shows a same-host dead-pid lock as stale, matching status', async () => {
    const { planDirectory } = await startSplit();
    const lockPath = join(planDirectory, 'execution', 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Json;
    await writeFile(lockPath, `${JSON.stringify({ ...lock, host: hostname(), pid: 2_000_000_000 }, null, 2)}\n`);

    const shownResult = await execution('show', '--plan', planDirectory);
    expect(shownResult.code, outputOf(shownResult)).toBe(0);
    const shown = parseJson(shownResult);
    expect(shown.lock.state).toBe('stale');

    const statusResult = await execution('status', '--plan', planDirectory);
    expect(statusResult.code, outputOf(statusResult)).toBe(0);
    const status = parseJson(statusResult);
    expect(status.runs[0].lock.state).toBe('stale');
    expect(shown.lock.state).toBe(status.runs[0].lock.state);
  }, TIMEOUT);
});
describe('execution event', () => {
  const EVENT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;

  async function successCase(type: string, flags: string[] = []) {
    const fixture = await startSplit();
    const recordPath = join(fixture.planDirectory, 'implementation.yaml');
    const recordBefore = await readFile(recordPath, 'utf8');
    const before = await snapshotTree(fixture.planDirectory);
    const result = await execution('event', type, '--plan', fixture.planDirectory, ...flags);
    expect(result.code, outputOf(result)).toBe(0);
    const body = parseJson(result);
    expect(body.valid).toBe(true);
    expect(body.plan_id).toBe(PLAN_ID);
    expect(typeof body.run_id).toBe('string');
    expect(body.run_id.length).toBeGreaterThan(0);
    expect(body.type).toBe(type);
    expect(typeof body.event_id).toBe('string');
    expect(body.event_id.length).toBeGreaterThan(0);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toEqual([]);
    return { ...fixture, recordPath, recordBefore, before, body };
  }

  const successCases = [
    { type: 'review.started', flags: [], payload: undefined },
    { type: 'review.started', flags: ['--boundary', 'delivery'], payload: { boundary: 'delivery' } },
    { type: 'review.completed', flags: ['--result', 'PASS', '--boundary', 'delivery'], payload: { result: 'PASS', boundary: 'delivery' } },
    { type: 'repair.completed', flags: ['--result', 'applied', '--boundary', 'delivery'], payload: { result: 'applied', boundary: 'delivery' } },
    { type: 'validation.completed', flags: ['--result', 'failed', '--boundary', 'integration'], payload: { result: 'failed', boundary: 'integration' } },
  ] as const;

  for (const { type, flags, payload } of successCases) {
    it(`records ${type} ${flags.join(' ')} as one UTC+08:00 event and leaves implementation.yaml unchanged`, async () => {
      const fixture = await successCase(type, [...flags]);
      const events = await readEvents(fixture.planDirectory);
      const event = events.at(-1);
      expect(event).toBeDefined();
      if (event === undefined) throw new Error('no event was appended');
      expect(event.type).toBe(type);
      expect(event.event_id).toBe(fixture.body.event_id);
      expect(event.timestamp).toMatch(EVENT_TIMESTAMP);
      if (payload === undefined) {
        expect(Object.hasOwn(event, 'payload')).toBe(false);
      } else {
        expect(event.payload).toEqual(payload);
        expect(Object.keys(event.payload ?? {})).toEqual(Object.keys(payload));
      }
      assertNoSensitiveEventKeys(events);

      const changed = changedPaths(fixture.before, await snapshotTree(fixture.planDirectory));
      expect(changed).toContain('execution/events.jsonl');
      expect(changed.some((path) => path.startsWith('execution/checkpoints/'))).toBe(true);
      expect(changed).not.toContain('implementation.yaml');
      expect(await readFile(fixture.recordPath, 'utf8')).toBe(fixture.recordBefore);
    }, TIMEOUT);
  }

  it('trims result and boundary values before storing them', async () => {
    const { planDirectory } = await startSplit();
    const result = await execution('event', 'review.completed', '--plan', planDirectory, '--result', '  PASS  ', '--boundary', '  delivery  ');
    expect(result.code, outputOf(result)).toBe(0);
    expect((await readEvents(planDirectory)).at(-1)?.payload).toEqual({ result: 'PASS', boundary: 'delivery' });
  }, TIMEOUT);

  const refusals = [
    { label: 'an unlisted type', args: ['task.started', '--result', 'x'] },
    { label: 'validation.completed without --result', args: ['validation.completed'] },
    { label: 'validation.completed with an empty --result', args: ['validation.completed', '--result', ''] },
    { label: 'validation.completed with a whitespace --result', args: ['validation.completed', '--result', '   '] },
    { label: 'review.completed with a whitespace --result', args: ['review.completed', '--result', '   '] },
    { label: 'review.started with an empty --boundary', args: ['review.started', '--boundary', ''] },
    { label: 'review.started with a whitespace --boundary', args: ['review.started', '--boundary', '   '] },
  ] as const;

  for (const { label, args } of refusals) {
    it(`refuses ${label} with exit 1 and zero disk writes`, async () => {
      const { planDirectory } = await startSplit();
      const recordPath = join(planDirectory, 'implementation.yaml');
      const recordBefore = await readFile(recordPath, 'utf8');
      const eventsBefore = await readEvents(planDirectory);
      const before = await snapshotTree(planDirectory);

      expectRefusal(await execution('event', ...args, '--plan', planDirectory));

      expect(changedPaths(before, await snapshotTree(planDirectory))).toEqual([]);
      expect(await readEvents(planDirectory)).toEqual(eventsBefore);
      expect(await readFile(recordPath, 'utf8')).toBe(recordBefore);
    }, TIMEOUT);
  }

  it('refuses on PAUSED and COMPLETED runs with zero disk writes', async () => {
    for (const transition of ['pause', 'complete'] as const) {
      const { planDirectory } = await startSplit();
      if (transition === 'pause') {
        expect((await execution('pause', '--plan', planDirectory)).code).toBe(0);
      } else {
        expect((await execution('complete', '--plan', planDirectory, '--commit', SHA_ONE)).code).toBe(0);
      }
      const recordPath = join(planDirectory, 'implementation.yaml');
      const recordBefore = await readFile(recordPath, 'utf8');
      const eventsBefore = await readEvents(planDirectory);
      const before = await snapshotTree(planDirectory);

      expectRefusal(await execution('event', 'review.started', '--plan', planDirectory));

      expect(changedPaths(before, await snapshotTree(planDirectory))).toEqual([]);
      expect(await readEvents(planDirectory)).toEqual(eventsBefore);
      expect(await readFile(recordPath, 'utf8')).toBe(recordBefore);
    }
  }, TIMEOUT);

  it('refuses when the execution lock is held by another live process', async () => {
    const { planDirectory } = await startSplit();
    const lockPath = join(planDirectory, 'execution', 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Json;
    await writeFile(lockPath, `${JSON.stringify({ ...lock, owner_id: 'another-writer', host: hostname(), pid: process.pid }, null, 2)}\n`);
    const before = await snapshotTree(planDirectory);

    expectRefusal(await execution('event', 'review.started', '--plan', planDirectory));

    expect(changedPaths(before, await snapshotTree(planDirectory))).toEqual([]);
  }, TIMEOUT);

  it('rejects an unknown CLI option with nonzero exit and zero disk writes', async () => {
    const { planDirectory } = await startSplit();
    const baseline = await execution('event', 'review.started', '--plan', planDirectory);
    expect(baseline.code, outputOf(baseline)).toBe(0);
    const before = await snapshotTree(planDirectory);

    const unknown = await execution('event', 'review.started', '--plan', planDirectory, '--bogus', 'value');

    expect(unknown.code, outputOf(unknown)).not.toBe(0);
    expect(outputOf(unknown), outputOf(unknown)).toContain('--bogus');
    expect(changedPaths(before, await snapshotTree(planDirectory))).toEqual([]);
  }, TIMEOUT);

  it('warns with event_id null on a storage write failure and leaves implementation.yaml byte-identical', async () => {
    const { planDirectory } = await startSplit();
    const recordPath = join(planDirectory, 'implementation.yaml');
    const recordBefore = await readFile(recordPath, 'utf8');
    const eventsPath = join(planDirectory, 'execution', 'events.jsonl');
    await rm(eventsPath);
    await mkdir(eventsPath);
    const before = await snapshotTree(planDirectory);

    const result = await execution('event', 'review.completed', '--plan', planDirectory, '--result', 'PASS');

    expect(result.code, outputOf(result)).toBe(0);
    const body = parseJson(result);
    expect(body.valid).toBe(true);
    expect(body.plan_id).toBe(PLAN_ID);
    expect(body.type).toBe('review.completed');
    expect(body.event_id).toBeNull();
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(await readdir(eventsPath)).toEqual([]);
    const changed = changedPaths(before, await snapshotTree(planDirectory));
    expect(changed).not.toContain('implementation.yaml');
    expect(await readFile(recordPath, 'utf8')).toBe(recordBefore);
  }, TIMEOUT);
});

describe('execution efficiency analytics fields (CLI)', () => {
  const T0 = Date.parse('2026-11-27T00:00:00.000Z');
  const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
  type Json = Record<string, any>;

  function baseRun(planId: string, overrides: Json = {}): Json {
    return {
      run_id: 'run-analytics',
      plan_id: planId,
      plan_digest: `sha256:${'a'.repeat(64)}`,
      status: 'COMPLETED',
      plan_created_at: at(0),
      created_at: at(0),
      updated_at: at(400),
      failure_count: 0,
      started_at: at(0),
      completed_at: at(400),
      ...overrides,
    };
  }

  function boundaryEvent(index: number, planId: string, type: string, seconds: number, payload?: Json): Json {
    return {
      event_id: `event-${index}`,
      run_id: 'run-analytics',
      plan_id: planId,
      type,
      timestamp: at(seconds),
      ...(payload === undefined ? {} : { payload }),
    };
  }

  async function storeFixture(planDirectory: string, run: Json, events: Json[]): Promise<void> {
    const directory = join(planDirectory, 'execution');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    await writeFile(
      join(directory, 'events.jsonl'),
      events.length === 0 ? '' : `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
  }

  it('AC-008: reports accurate five fields via --plan and --project with zero writes and byte-identical repeats', async () => {
    const root = await temporary('ai-workflow-exec-analytics-cli-');
    const planDirectory = await workspacePlanFixture(root, splitSpec(PLAN_ID));
    await storeFixture(
      planDirectory,
      baseRun(PLAN_ID, {
        tasks: {
          [TASK_A]: { status: 'completed', started_at: at(0), completed_at: at(30) },
          [TASK_B]: { status: 'completed', started_at: at(100), completed_at: at(145) },
        },
        agent: { invocation_id: 'inv-1', host: 'test-host', session_id: 'session-1', cost: 12 },
      }),
      [
        boundaryEvent(1, PLAN_ID, 'review.started', 200),
        boundaryEvent(2, PLAN_ID, 'review.completed', 210),
        boundaryEvent(3, PLAN_ID, 'repair.completed', 215),
        boundaryEvent(4, PLAN_ID, 'review.started', 300),
        boundaryEvent(5, PLAN_ID, 'review.completed', 330),
        boundaryEvent(6, PLAN_ID, 'validation.completed', 340, { result: 'failed' }),
        boundaryEvent(7, PLAN_ID, 'validation.completed', 350, { result: 'passed' }),
      ],
    );

    const before = await snapshotTree(root);
    const planFirst = await execution('analytics', '--plan', planDirectory);
    expect(planFirst.code, outputOf(planFirst)).toBe(0);
    const metric = parseJson(planFirst).runs[0];
    expect(metric.phase_wall_clock).toEqual([
      { phase: 1, duration_seconds: 30 },
      { phase: 2, duration_seconds: 45 },
    ]);
    expect(metric.review_duration_seconds).toBe(40);
    expect(metric.repair_rounds).toBe(1);
    expect(metric.integration_failure_rate).toBe(0.5);
    expect(metric.cost_per_accepted_task).toBe(6);

    const planSecond = await execution('analytics', '--plan', planDirectory);
    expect(planSecond.code, outputOf(planSecond)).toBe(0);
    expect(planSecond.stdout, '--plan repeats byte-identically').toBe(planFirst.stdout);

    const projectFirst = await execution('analytics', '--project', root);
    expect(projectFirst.code, outputOf(projectFirst)).toBe(0);
    const projectBody = parseJson(projectFirst);
    expect(projectBody.scope).toBe('project');
    expect(projectBody.runs).toHaveLength(1);
    expect(projectBody.runs[0]).toEqual(metric);
    const projectSecond = await execution('analytics', '--project', root);
    expect(projectSecond.code, outputOf(projectSecond)).toBe(0);
    expect(projectSecond.stdout, '--project repeats byte-identically').toBe(projectFirst.stdout);

    expect(changedPaths(before, await snapshotTree(root)), 'analytics writes no path').toEqual([]);
  }, TIMEOUT);

  it('AC-009: reports N/A and zero for a legacy unsplit run with no boundary events', async () => {
    const root = await temporary('ai-workflow-exec-analytics-legacy-');
    const planDirectory = await frozenPlan(root, false);
    const started = await execution('start', '--plan', planDirectory);
    expect(started.code, outputOf(started)).toBe(0);
    const completed = await execution('complete', '--plan', planDirectory, '--commit', SHA_ONE);
    expect(completed.code, outputOf(completed)).toBe(0);

    const result = await execution('analytics', '--plan', planDirectory);
    expect(result.code, outputOf(result)).toBe(0);
    const metric = parseJson(result).runs[0];
    expect(metric.phase_wall_clock).toBe('N/A');
    expect(metric.review_duration_seconds).toBe('N/A');
    expect(metric.repair_rounds).toBe(0);
    expect(metric.integration_failure_rate).toBe('N/A');
    expect(metric.cost_per_accepted_task).toBe('N/A');
  }, TIMEOUT);
});
