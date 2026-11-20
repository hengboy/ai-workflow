import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { changedPaths, frozenPlan, snapshotTree, temporary, workspacePlanFixture } from '../helpers.js';

// Host session-recording boundary (REQ-006 / AC-010 / AC-011).
//   pnpm exec tsx src/cli.ts execution record --host opencode
// reads one JSON object on stdin and always exits 0 so a host hook never breaks. It binds only
// a single unambiguous RUNNING run in the actual adopted root resolved from the payload cwd.
// These tests drive the real CLI process and observe through `execution events|analytics|show`.

const TIMEOUT = 120_000;
const PLAN_ID = '20260831-example'; // the valid plan id created by frozenPlan()
const SESSION_ID = 'session-abc-123';
const PARENT_ID = 'session-parent-9';

type Json = Record<string, any>;
interface CliResult { code: number; stdout: string; stderr: string }

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

/** Drive the real CLI. `input` is written verbatim (strings) or as JSON (objects) to stdin. */
function runCli(args: string[], input?: string | Record<string, unknown>): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input === undefined) child.stdin.end();
    else {
      child.stdin.write(typeof input === 'string' ? input : JSON.stringify(input));
      child.stdin.end();
    }
  });
}

function execution(...args: string[]): Promise<CliResult> {
  return runCli(['execution', ...args]);
}

function record(input: string | Record<string, unknown>, host = 'opencode'): Promise<CliResult> {
  return runCli(['execution', 'record', '--host', host], input);
}

function parseJson<T extends Json = Json>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

function sessionPayload(
  event: 'session.created' | 'session.deleted' | 'session.error',
  cwd: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { event, cwd, session_id: SESSION_ID, ...extra };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture { root: string; planDirectory: string; runId: string }

async function runningFixture(): Promise<Fixture> {
  const root = await temporary('ai-workflow-exec-hooks-');
  roots.push(root);
  const planDirectory = await frozenPlan(root);
  const started = await execution('start', '--plan', planDirectory);
  expect(started.code, outputOf(started)).toBe(0);
  const body = parseJson(started);
  expect(body.plan_id).toBe(PLAN_ID);
  return { root, planDirectory, runId: body.run_id };
}

async function queryEvents(root: string): Promise<Json[]> {
  const result = await execution('events', '--project', root);
  expect(result.code, outputOf(result)).toBe(0);
  const body = parseJson(result);
  expect(body.valid).toBe(true);
  return body.events as Json[];
}

async function queryAnalytics(root: string): Promise<Json> {
  const result = await execution('analytics', '--project', root);
  expect(result.code, outputOf(result)).toBe(0);
  const body = parseJson(result);
  expect(body.valid).toBe(true);
  return body;
}

async function readRun(planDirectory: string): Promise<Json> {
  return JSON.parse(await readFile(join(planDirectory, 'execution', 'run.json'), 'utf8')) as Json;
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

function agentEvents(events: Json[], type: string): Json[] {
  return events.filter((event) => event.type === type);
}

describe('execution record host session invocations', () => {
  it('AC-010: appends one agent.invoked then one agent.completed with a shared invocation id', async () => {
    const { root, planDirectory, runId } = await runningFixture();

    const created = await record(sessionPayload('session.created', root, {
      parent_session_id: PARENT_ID,
      role: 'primary',
      model: 'test-model',
    }));
    expect(created.code, outputOf(created)).toBe(0);
    expect(parseJson(created)).toMatchObject({
      recorded: true,
      event: 'agent.invoked',
      invocation_id: SESSION_ID,
      run_id: runId,
    });

    const completed = await record(sessionPayload('session.deleted', root));
    expect(completed.code, outputOf(completed)).toBe(0);
    expect(parseJson(completed)).toMatchObject({
      recorded: true,
      event: 'agent.completed',
      invocation_id: SESSION_ID,
      run_id: runId,
    });

    const events = await queryEvents(root);
    const invoked = agentEvents(events, 'agent.invoked');
    const done = agentEvents(events, 'agent.completed');
    expect(invoked).toHaveLength(1);
    expect(done).toHaveLength(1);
    const invokedEvent = invoked[0]!;
    const doneEvent = done[0]!;
    expect(invokedEvent.invocation_id, 'invocation identity is the session id').toBe(SESSION_ID);
    expect(doneEvent.invocation_id, 'completion shares the invocation id').toBe(SESSION_ID);
    expect(events.indexOf(invokedEvent), 'invoked precedes completed').toBeLessThan(events.indexOf(doneEvent));
    assertNoSensitiveEventKeys(events);

    const run = await readRun(planDirectory);
    expect(run.agent).toMatchObject({
      invocation_id: SESSION_ID,
      host: 'opencode',
      session_id: SESSION_ID,
      parent_session_id: PARENT_ID,
      role: 'primary',
      model: 'test-model',
    });
  }, TIMEOUT);

  it('AC-011: absent token and cost stay out of stored fields and report N/A', async () => {
    const { root, planDirectory } = await runningFixture();
    const created = await record(sessionPayload('session.created', root, { role: 'primary' }));
    expect(created.code, outputOf(created)).toBe(0);
    expect(parseJson(created).recorded).toBe(true);
    const completed = await record(sessionPayload('session.deleted', root));
    expect(completed.code, outputOf(completed)).toBe(0);

    const run = await readRun(planDirectory);
    expect(Object.hasOwn(run.agent, 'tokens'), 'tokens stay absent from run.agent').toBe(false);
    expect(Object.hasOwn(run.agent, 'cost'), 'cost stays absent from run.agent').toBe(false);
    for (const event of await queryEvents(root)) {
      expect(Object.hasOwn(event.payload ?? {}, 'tokens'), 'tokens stay absent from event payload').toBe(false);
      expect(Object.hasOwn(event.payload ?? {}, 'cost'), 'cost stays absent from event payload').toBe(false);
    }

    const analytics = await queryAnalytics(root);
    expect(analytics.runs).toHaveLength(1);
    expect(analytics.runs[0].token_usage).toBe('N/A');
    expect(analytics.runs[0].model_cost).toBe('N/A');
  }, TIMEOUT);

  it('AC-010: host-supplied tokens and cost are recorded and reported by analytics', async () => {
    const { root, planDirectory } = await runningFixture();
    const created = await record(sessionPayload('session.created', root, { model: 'test-model', tokens: 321, cost: 0.75 }));
    expect(created.code, outputOf(created)).toBe(0);
    expect(parseJson(created).recorded).toBe(true);
    const completed = await record(sessionPayload('session.deleted', root));
    expect(completed.code, outputOf(completed)).toBe(0);

    const run = await readRun(planDirectory);
    expect(run.agent.tokens).toBe(321);
    expect(run.agent.cost).toBe(0.75);
    const analytics = await queryAnalytics(root);
    expect(analytics.runs[0].token_usage).toBe(321);
    expect(analytics.runs[0].model_cost).toBe(0.75);
  }, TIMEOUT);

  it('AC-010: repeated creation, deletion and error stay idempotent', async () => {
    const { root } = await runningFixture();
    for (let index = 0; index < 2; index += 1) {
      const created = await record(sessionPayload('session.created', root, { role: 'primary' }));
      expect(created.code, outputOf(created)).toBe(0);
    }
    for (const event of ['session.deleted', 'session.error'] as const) {
      const completed = await record(sessionPayload(event, root));
      expect(completed.code, outputOf(completed)).toBe(0);
    }

    const events = await queryEvents(root);
    expect(agentEvents(events, 'agent.invoked')).toHaveLength(1);
    expect(agentEvents(events, 'agent.completed')).toHaveLength(1);
    assertNoSensitiveEventKeys(events);
  }, TIMEOUT);

  it('AC-011: no-ops exit 0, return an explicit reason and write no execution files', async () => {
    interface Case {
      name: string;
      setup: () => Promise<{ root: string; cwd: string; host?: string; input: string | Record<string, unknown> }>;
    }

    async function zeroRuns(): Promise<{ root: string; cwd: string; input: Record<string, unknown> }> {
      const root = await temporary('ai-workflow-exec-hooks-none-');
      roots.push(root);
      await frozenPlan(root); // adopted root, but no run was started
      return { root, cwd: root, input: sessionPayload('session.created', root) };
    }

    async function twoRuns(): Promise<{ root: string; cwd: string; input: Record<string, unknown> }> {
      const root = await temporary('ai-workflow-exec-hooks-two-');
      roots.push(root);
      await frozenPlan(root);
      const first = await execution('start', '--plan', join(root, '.ai-workflow/plans', PLAN_ID));
      expect(first.code, outputOf(first)).toBe(0);
      const secondDirectory = await workspacePlanFixture(root, {
        planId: '20261117-second',
        requirements: ['REQ-001'],
        acceptanceCriteria: ['AC-001'],
        tasks: [{ id: 'task-002-second', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] }],
        phases: [['task-002-second']],
      });
      const second = await execution('start', '--plan', secondDirectory);
      expect(second.code, outputOf(second)).toBe(0);
      return { root, cwd: root, input: sessionPayload('session.created', root) };
    }

    const cases: Case[] = [
      { name: 'zero active runs', setup: zeroRuns },
      { name: 'two active runs', setup: twoRuns },
      {
        name: 'unknown host',
        setup: async () => {
          const fixture = await runningFixture();
          return { root: fixture.root, cwd: fixture.root, host: 'unknown-host', input: sessionPayload('session.created', fixture.root) };
        },
      },
      {
        name: 'malformed JSON',
        setup: async () => {
          const fixture = await runningFixture();
          return { root: fixture.root, cwd: fixture.root, input: '{ this is not json' };
        },
      },
      {
        name: 'missing session id',
        setup: async () => {
          const fixture = await runningFixture();
          return { root: fixture.root, cwd: fixture.root, input: { event: 'session.created', cwd: fixture.root } };
        },
      },
      {
        name: 'missing invocation completion',
        setup: async () => {
          const fixture = await runningFixture();
          return { root: fixture.root, cwd: fixture.root, input: sessionPayload('session.deleted', fixture.root) };
        },
      },
    ];

    for (const testCase of cases) {
      const { root, host, input } = await testCase.setup();
      const before = await snapshotTree(root);
      const result = await record(input, host);
      expect(result.code, `${testCase.name}: host transport must always exit 0\n${outputOf(result)}`).toBe(0);
      const body = parseJson(result);
      expect(body.recorded, `${testCase.name}: recorded is false`).toBe(false);
      expect(typeof body.reason, `${testCase.name}: explicit reason`).toBe('string');
      expect(body.warnings, `${testCase.name}: warnings are empty`).toEqual([]);
      expect(changedPaths(before, await snapshotTree(root)), `${testCase.name}: writes no file`).toEqual([]);
    }
  }, 180_000);
});

describe('OpenCode plugin execution-record wiring', () => {
  const templates = [
    ['v1', 'templates/hooks/opencode.js'],
    ['v2', 'templates/hooks/opencode-v2.js'],
  ];

  it.each(templates)('%s keeps synchronization and adds fire-and-forget execution recording', async (_label, relativePath) => {
    const source = await readFile(join(process.cwd(), relativePath), 'utf8');

    // Existing synchronization behavior and gate output stay intact.
    expect(source, `${relativePath}: keeps the sync-hook spawn`).toContain('sync-hook');
    expect(source, `${relativePath}: keeps the gate decision validation`).toMatch(/allow[^\n]*deny[^\n]*skip/);
    expect(source, `${relativePath}: keeps the synchronization path`).toContain('synchronize(');

    // The internal record transport is spawned, not awaited, on all three session events.
    expect(source, `${relativePath}: references the execution command`).toMatch(/['"]execution['"]/);
    expect(source, `${relativePath}: references the record subcommand`).toMatch(/['"]record['"]/);
    expect(source, `${relativePath}: binds the opencode host`).toContain('--host');
    for (const type of ['session.created', 'session.deleted', 'session.error']) {
      expect(source, `${relativePath}: records ${type}`).toContain(type);
    }
    if (relativePath === 'templates/hooks/opencode-v2.js') {
      expect(source, `${relativePath}: records session.execution.failed`).toContain('session.execution.failed');
    }
    const spawnLine = source.split('\n').find((line) => /spawn\(/.test(line) && /record/.test(line));
    expect(spawnLine, `${relativePath}: record transport spawns the CLI`).toBeDefined();
    expect(spawnLine, `${relativePath}: record spawn is fire-and-forget`).not.toMatch(/\bawait\b/);
    expect(/\.catch\(|\.on\(['"]error['"]/.test(source), `${relativePath}: record failures are swallowed`).toBe(true);
  });
});
