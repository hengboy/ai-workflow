import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
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
  type WorkspaceTaskFixture,
} from '../helpers.js';

// End-to-end CLI evidence for the execution overlay. Each case drives the real CLI process and
// asserts only files and JSON that an operator can observe. Query commands are read-only.
// No case touches a screenshot, the network, or a product source file.

const TIMEOUT = 90_000;
const HOST = hostname();
const DEAD_PID = 2_000_000_000;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const TASK_A = 'task-001-a';
const TASK_B = 'task-002-b';
const PLAN_NORMAL = '20261117-e2e-normal';
const PLAN_RESUME = '20261117-e2e-resume';
const PLAN_CORRUPT = '20261117-e2e-corrupt';
const PLAN_LEGACY = '20261117-e2e-legacy';
const PLAN_MISMATCH = '20261117-e2e-mismatch';
const PLAN_WORKSPACE = '20261117-e2e-workspace';
const PLAN_ANALYTICS = '20261117-e2e-analytics';
const PLAN_COST = '20261117-e2e-cost';

type Json = Record<string, any>;
interface CliResult { code: number; stdout: string; stderr: string }

function outputOf(result: CliResult): string { return `${result.stdout}\n${result.stderr}`; }

/** Drive the real CLI exactly as an operator would, with an optional environment override. */
async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], { env });
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

/** Drive a CLI command that consumes one JSON event on stdin. */
async function runCliStdin(args: string[], input: string): Promise<CliResult> {
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
    child.stdin.end(input);
  });
}

function execution(...args: string[]): Promise<CliResult> { return runCli(['execution', ...args]); }

function parseJson<T extends Json = Json>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

async function expectOk(result: CliResult): Promise<Json> {
  expect(result.code, outputOf(result)).toBe(0);
  const body = parseJson(result);
  expect(body.valid, outputOf(result)).toBe(true);
  return body;
}

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, 'utf8')) as Json;
}

async function readEventLines(planDirectory: string): Promise<string[]> {
  return (await readFile(join(planDirectory, 'execution', 'events.jsonl'), 'utf8')).split('\n');
}

function parseEvents(lines: string[]): Json[] {
  return lines.flatMap((line) => {
    if (line.trim().length === 0) return [];
    try { return [JSON.parse(line) as Json]; } catch { return []; }
  });
}

function eventTypes(events: Json[]): string[] {
  return events.map((event) => event.type ?? event.event ?? '');
}

async function executionSnapshot(planDirectory: string): Promise<Map<string, string>> {
  try { return await snapshotTree(join(planDirectory, 'execution')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

function splitSpec(planId: string): WorkspacePlanFixtureSpec {
  return {
    planId,
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    // No workspaceRepos and no manifest: an ordinary frozen split plan with two phases.
    tasks: [
      { id: TASK_A, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/a.ts'] },
      { id: TASK_B, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/b.ts'] },
    ],
    phases: [[TASK_A], [TASK_B]],
  };
}

async function splitFixture(planId: string): Promise<{ root: string; planDirectory: string }> {
  const root = await temporary('ai-workflow-e2e-');
  const planDirectory = await workspacePlanFixture(root, splitSpec(planId));
  return { root, planDirectory };
}

/** Frozen-plan bytes that a recovery or telemetry failure is never allowed to rewrite. */
async function frozenBytes(planDirectory: string): Promise<Map<string, string>> {
  const tree = await snapshotTree(planDirectory);
  return new Map([...tree].filter(([path]) => !path.startsWith('execution/') && path !== 'implementation.yaml'));
}

async function assertFrozenBytesUnchanged(before: Map<string, string>, planDirectory: string): Promise<void> {
  const after = await snapshotTree(planDirectory);
  for (const [path, hash] of before) expect(after.get(path), `${path} is unchanged`).toBe(hash);
}

describe('execution end-to-end CLI evidence', () => {
  it('runs a two-phase ordinary split plan through completion with consistent, byte-identical queries', async () => {
    const { root, planDirectory } = await splitFixture(PLAN_NORMAL);
    const started = await expectOk(await execution('start', '--plan', planDirectory, '--repository', 'app'));
    expect(started.status).toBe('RUNNING');
    expect(started.plan_id).toBe(PLAN_NORMAL);
    expect(started.plan_digest).toMatch(/^sha256:/);
    const runId = started.run_id as string;
    const digest = started.plan_digest as string;

    const firstTask = await expectOk(await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_A));
    expect(firstTask.status).toBe('RUNNING');
    expect(firstTask.opened_phase).toEqual([TASK_B]);
    expect((await expectOk(await execution('task', TASK_B, '--plan', planDirectory, '--commit', SHA_B))).status).toBe('RUNNING');

    const completed = await expectOk(await execution('complete', '--plan', planDirectory, '--commit', SHA_C, '--validation', 'passed', '--review', 'PASS'));
    expect(completed).toMatchObject({ status: 'COMPLETED', run_id: runId, plan_id: PLAN_NORMAL, recovered: false, commit: SHA_C });

    const events = parseEvents(await readEventLines(planDirectory));
    expect(eventTypes(events)).toEqual([
      'workflow.started', 'task.started', 'task.completed', 'task.started', 'task.completed',
      'validation.completed', 'review.completed', 'workflow.completed',
    ]);
    expect(events.every((event) => event.run_id === runId && event.plan_id === PLAN_NORMAL)).toBe(true);
    expect(events[1]?.task_id).toBe(TASK_A);
    expect(events[2]?.task_id).toBe(TASK_A);
    expect(events[3]?.task_id).toBe(TASK_B);
    expect(events[4]?.task_id).toBe(TASK_B);
    expect(events[5]?.payload.result).toBe('passed');
    expect(events[6]?.payload.result).toBe('PASS');

    const run = await readJson(join(planDirectory, 'execution', 'run.json'));
    expect(run).toMatchObject({ run_id: runId, plan_id: PLAN_NORMAL, plan_digest: digest, status: 'COMPLETED' });
    const record = parseYaml(await readFile(join(planDirectory, 'implementation.yaml'), 'utf8')) as Json;
    expect(record).toMatchObject({ plan_id: PLAN_NORMAL, status: 'completed', commit: SHA_C });
    expect(record.started_at).toBeTruthy();
    expect(record.completed_at).toMatch(/\+08:00$/);
    expect((await snapshotTree(join(planDirectory, 'execution'))).has('lock.json')).toBe(false);

    const queries: Array<[string[], Json]> = [
      [['status', '--project', root], { plan_id: PLAN_NORMAL, run_id: runId, status: 'COMPLETED' }],
      [['show', '--plan', planDirectory], { plan_id: PLAN_NORMAL, run_id: runId, status: 'COMPLETED' }],
      [['events', '--plan', planDirectory], { plan_id: PLAN_NORMAL, run_id: runId }],
      [['history', '--project', root], { plan_id: PLAN_NORMAL, run_id: runId, status: 'COMPLETED' }],
    ];
    for (const [args, expected] of queries) {
      const body = await expectOk(await execution(...args));
      if (args[0] === 'events') {
        expect(body.events).toHaveLength(events.length);
      } else if (args[0] === 'show') {
        expect(body.run).toMatchObject(expected);
        expect(body.lock.state).toBe('none');
      } else {
        expect(body.runs).toHaveLength(1);
        expect(body.runs[0]).toMatchObject(expected);
      }
    }
    for (const [args] of queries) {
      const first = await execution(...args);
      const second = await execution(...args);
      expect(first.code, outputOf(first)).toBe(0);
      expect(second.code, outputOf(second)).toBe(0);
      expect(second.stdout, `${args[0]} is byte-identical`).toBe(first.stdout);
    }
  }, TIMEOUT);

  it('resumes a same-host dead-pid lock without a new run id or an authoritative rewrite', async () => {
    const { planDirectory } = await splitFixture(PLAN_RESUME);
    const started = await expectOk(await execution('start', '--plan', planDirectory, '--repository', 'app'));
    const runId = started.run_id as string;
    const digest = started.plan_digest as string;
    await expectOk(await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_A));

    const lockPath = join(planDirectory, 'execution', 'lock.json');
    const lock = await readJson(lockPath);
    await writeFile(lockPath, `${JSON.stringify({ ...lock, host: HOST, pid: DEAD_PID }, null, 2)}\n`);
    const recordBefore = await readFile(join(planDirectory, 'implementation.yaml'));
    const frozenBefore = await frozenBytes(planDirectory);

    const resumed = await expectOk(await execution('resume', '--plan', planDirectory));
    expect(resumed.decision).toBe('resume');
    expect(resumed.run_id).toBe(runId);
    expect(resumed.plan_id).toBe(PLAN_RESUME);
    expect(resumed.status).toBe('RUNNING');
    expect(resumed.completed_tasks).toEqual([TASK_A]);
    expect(resumed.pending_tasks).toEqual([TASK_B]);
    expect(resumed.pending_tasks).not.toContain(TASK_A);

    const types = eventTypes(parseEvents(await readEventLines(planDirectory)));
    const interrupted = types.indexOf('execution.interrupted');
    expect(interrupted).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('execution.resumed')).toBeGreaterThan(interrupted);

    const shown = await expectOk(await execution('show', '--plan', planDirectory));
    expect(shown.lock.state).toBe('stale');
    const reacquired = await readJson(lockPath);
    expect(reacquired.host).toBe(HOST);
    expect(reacquired.pid).toBeGreaterThan(0);
    expect(reacquired.pid).not.toBe(DEAD_PID);
    expect(await readJson(join(planDirectory, 'execution', 'run.json'))).toMatchObject({
      run_id: runId, plan_id: PLAN_RESUME, plan_digest: digest, status: 'RUNNING',
    });
    expect(await readFile(join(planDirectory, 'implementation.yaml'))).toEqual(recordBefore);
    await assertFrozenBytesUnchanged(frozenBefore, planDirectory);
  }, TIMEOUT);

  it('reports an ignored malformed tail and falls back past a corrupt checkpoint without rewriting authoritative files', async () => {
    const { planDirectory } = await splitFixture(PLAN_CORRUPT);
    await expectOk(await execution('start', '--plan', planDirectory));
    await expectOk(await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_A));
    const recordBefore = await readFile(join(planDirectory, 'implementation.yaml'));
    const frozenBefore = await frozenBytes(planDirectory);

    const eventsPath = join(planDirectory, 'execution', 'events.jsonl');
    await writeFile(eventsPath, `${await readFile(eventsPath, 'utf8')}{broken json line`);
    const checkpoints = join(planDirectory, 'execution', 'checkpoints');
    const initial = (await readdir(checkpoints)).filter((name) => name.endsWith('.json')).sort();
    expect(initial.length).toBeGreaterThanOrEqual(2);
    const corruptedName = initial[initial.length - 1]!;
    await writeFile(join(checkpoints, corruptedName), '{corrupt checkpoint\n');

    const recorded = await expectOk(await execution('task', TASK_B, '--plan', planDirectory, '--commit', SHA_B));
    expect(recorded.status).toBe('RUNNING');
    // The task writes a newer valid checkpoint; corrupt it too so fallback is observable in the query.
    const afterTask = (await readdir(checkpoints)).filter((name) => name.endsWith('.json')).sort();
    const newestName = afterTask[afterTask.length - 1]!;
    await writeFile(join(checkpoints, newestName), '{corrupt checkpoint\n');

    const eventsResult = await execution('events', '--plan', planDirectory);
    expect(eventsResult.code, outputOf(eventsResult)).toBe(0);
    const eventsBody = parseJson(eventsResult);
    expect(eventsBody.valid).toBe(true);
    expect(eventsBody.warnings.some((warning: string) => /event stream line \d+.*(malformed|unterminated).*ignored/i.test(warning))).toBe(true);
    expect(eventsBody.events).toHaveLength(5);
    expect(eventTypes(eventsBody.events as Json[])).toEqual([
      'workflow.started', 'task.started', 'task.completed', 'task.started', 'task.completed',
    ]);
    const lines = await readEventLines(planDirectory);
    expect(lines).toContain('{broken json line');
    expect((JSON.parse(lines[lines.length - 2]!) as Json).type).toBe('task.completed');

    const showResult = await execution('show', '--plan', planDirectory);
    expect(showResult.code, outputOf(showResult)).toBe(0);
    const shown = parseJson(showResult);
    expect(shown.checkpoint.status).toBe('ok');
    expect(shown.checkpoint.warnings.join('\n')).toMatch(/checkpoint .* (unreadable|invalid)/i);
    expect(shown.checkpoint.checkpoint_id).toBeTruthy();
    expect(shown.checkpoint.checkpoint_id).not.toBe(corruptedName);
    expect(shown.events.warnings.some((warning: string) => /ignored/i.test(warning))).toBe(true);
    expect(shown.diagnostics.degraded).toBe(true);
    expect(await readFile(join(planDirectory, 'implementation.yaml'))).toEqual(recordBefore);
    await assertFrozenBytesUnchanged(frozenBefore, planDirectory);
  }, TIMEOUT);

  it('recovers a legacy completed record with its own timestamp and refuses a mismatched commit byte-for-byte', async () => {
    const startedAt = '2026-11-17T02:00:00.000Z';
    const completedAt = '2026-11-17T03:00:00.000Z';
    const legacyRecord = (planId: string, commit: string): string => [
      `plan_id: ${planId}`, 'status: completed',
      `started_at: '${startedAt}'`, `completed_at: '${completedAt}'`, `commit: ${commit}`, '',
    ].join('\n');

    const matching = await splitFixture(PLAN_LEGACY);
    const recordPath = join(matching.planDirectory, 'implementation.yaml');
    await writeFile(recordPath, legacyRecord(PLAN_LEGACY, SHA_A));
    const recordBefore = await readFile(recordPath);

    const recovered = await expectOk(await execution('complete', '--plan', matching.planDirectory, '--commit', SHA_A));
    expect(recovered.status).toBe('COMPLETED');
    expect(recovered.recovered).toBe(true);
    const run = await readJson(join(matching.planDirectory, 'execution', 'run.json'));
    expect(run.status).toBe('COMPLETED');
    expect(Date.parse(run.started_at as string)).toBe(Date.parse(startedAt));
    expect(Date.parse(run.completed_at as string)).toBe(Date.parse(completedAt));
    expect(eventTypes(parseEvents(await readEventLines(matching.planDirectory)))).toEqual(['workflow.completed']);
    expect(await readFile(recordPath)).toEqual(recordBefore);

    const mismatch = await splitFixture(PLAN_MISMATCH);
    await writeFile(join(mismatch.planDirectory, 'implementation.yaml'), legacyRecord(PLAN_MISMATCH, SHA_A));
    const before = await snapshotTree(mismatch.root);
    const refused = await execution('complete', '--plan', mismatch.planDirectory, '--commit', SHA_B);
    expect(refused.code, outputOf(refused)).toBe(1);
    expect(parseJson(refused).valid).toBe(false);
    expect(changedPaths(before, await snapshotTree(mismatch.root))).toEqual([]);
  }, TIMEOUT);

  it('creates three isolated runs for a root-and-two-child workspace plan', async () => {
    const root = await temporary('ai-workflow-e2e-workspace-');
    const planId = PLAN_WORKSPACE;
    const appPath = 'packages/app';
    const libPath = 'packages/lib';
    const WORKSPACE = { name: 'workspace', path: '.', dependsOn: [] };
    const APP = { name: 'app', path: appPath, dependsOn: [] };
    const LIB = { name: 'lib', path: libPath, dependsOn: [] };
    const tasks: WorkspaceTaskFixture[] = [
      { id: TASK_A, repo: 'app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/a.ts'] },
      { id: TASK_B, repo: 'lib', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/b.ts'] },
      { id: 'task-003-root', repo: 'workspace', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], writeScope: ['src/root.ts'] },
    ];
    const spec: WorkspacePlanFixtureSpec = {
      planId,
      requirements: ['REQ-001', 'REQ-002', 'REQ-003'],
      acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003'],
      workspaceRepos: [WORKSPACE, APP, LIB],
      tasks,
      phases: [[TASK_A, TASK_B, 'task-003-root']],
      manifest: {
        planId, role: 'workspace',
        repositories: [
          { ...WORKSPACE, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
          { ...APP, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
          { ...LIB, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        ],
      },
    };
    const planDirectory = await workspacePlanFixture(root, spec);
    for (const [repository, path] of [['app', appPath], ['lib', libPath]] as const) {
      const owned = tasks.filter((task) => task.repo === repository);
      await workspacePlanFixture(join(root, path), {
        planId,
        requirements: owned.map((task) => task.requirements[0]!),
        acceptanceCriteria: owned.map((task) => task.acceptanceCriteria[0]!),
        tasks: owned,
        phases: [owned.map((task) => task.id)],
        manifest: {
          planId, role: 'slice',
          repositories: [{
            name: repository, path, dependsOn: [],
            requirements: owned.map((task) => task.requirements[0]!),
            acceptanceCriteria: owned.map((task) => task.acceptanceCriteria[0]!),
          }],
        },
      });
    }
    const appPlan = join(root, appPath, '.ai-workflow', 'plans', planId);
    const libPlan = join(root, libPath, '.ai-workflow', 'plans', planId);
    const startEvent = (repository: string): Record<string, unknown> => ({
      event: 'start', purpose: 'tasks', source_root: root, repository,
      worktree: join(root, '.worktrees', planId), branch: `ai-workflow/${planId}`,
      target_branch: 'main', base_commit: SHA_A,
    });
    const checkpointOk = async (repository: string, event: unknown): Promise<void> => {
      const result = await runCliStdin(['workspace', 'checkpoint', '--plan', planDirectory, '--repo', repository], JSON.stringify(event));
      expect(result.code, outputOf(result)).toBe(0);
    };

    const siblingBefore = await executionSnapshot(libPlan);
    const rootBefore = await executionSnapshot(planDirectory);
    await checkpointOk('app', startEvent('app'));
    expect(changedPaths(siblingBefore, await executionSnapshot(libPlan))).toEqual([]);
    expect(changedPaths(rootBefore, await executionSnapshot(planDirectory))).toEqual([]);

    await checkpointOk('lib', startEvent('lib'));
    await checkpointOk('workspace', startEvent('workspace'));
    const appRun = await readJson(join(appPlan, 'execution', 'run.json'));
    const libRun = await readJson(join(libPlan, 'execution', 'run.json'));
    const rootRun = await readJson(join(planDirectory, 'execution', 'run.json'));
    expect(new Set([appRun.run_id, libRun.run_id, rootRun.run_id]).size).toBe(3);
    for (const [run, repository] of [[appRun, 'app'], [libRun, 'lib'], [rootRun, 'workspace']] as const) {
      expect(run).toMatchObject({ plan_id: planId, plan_digest: appRun.plan_digest, repository, status: 'RUNNING' });
    }
    for (const [project, run] of [[join(root, appPath), appRun], [join(root, libPath), libRun], [root, rootRun]] as const) {
      const status = await expectOk(await execution('status', '--project', project));
      expect(status.runs).toHaveLength(1);
      expect(status.runs[0]).toMatchObject({ plan_id: planId, run_id: run.run_id, repository: run.repository });
    }

    const libBeforeTask = await executionSnapshot(libPlan);
    const rootBeforeTask = await executionSnapshot(planDirectory);
    await checkpointOk('app', { event: 'task', task: TASK_A, kind: 'commit', commit: SHA_B });
    expect(changedPaths(libBeforeTask, await executionSnapshot(libPlan))).toEqual([]);
    expect(changedPaths(rootBeforeTask, await executionSnapshot(planDirectory))).toEqual([]);
    expect((await readJson(join(appPlan, 'execution', 'run.json'))).tasks[TASK_A]).toMatchObject({ status: 'completed', commit: SHA_B });
  }, TIMEOUT);

  it('derives analytics only from stored events and reports N/A for unrecorded values', async () => {
    const root = await temporary('ai-workflow-e2e-analytics-');
    const unsplitPlan = await frozenPlan(root, false);
    await expectOk(await execution('start', '--plan', unsplitPlan));
    await expectOk(await execution('complete', '--plan', unsplitPlan, '--commit', SHA_A));
    const unsplit = (await expectOk(await execution('analytics', '--plan', unsplitPlan))).runs[0];
    for (const key of ['task_success_rate', 'average_task_duration_seconds', 'recovery_success_rate', 'token_usage', 'model_cost', 'validation_result', 'review_result']) {
      expect(unsplit[key], `${key} is N/A without recorded data`).toBe('N/A');
    }
    expect(unsplit.retry_count).toBe(0);
    expect(unsplit.interruption_count).toBe(0);
    expect(typeof unsplit.workflow_duration_seconds).toBe('number');

    const { planDirectory } = await splitFixture(PLAN_ANALYTICS);
    await expectOk(await execution('start', '--plan', planDirectory));
    await expectOk(await execution('task', TASK_A, '--plan', planDirectory, '--commit', SHA_A));
    await expectOk(await execution('task', TASK_B, '--plan', planDirectory, '--commit', SHA_B));
    await expectOk(await execution('complete', '--plan', planDirectory, '--commit', SHA_C, '--validation', 'passed', '--review', 'PASS'));
    const metric = (await expectOk(await execution('analytics', '--plan', planDirectory))).runs[0];
    expect(metric).toMatchObject({
      task_success_rate: 1, retry_count: 0, interruption_count: 0,
      validation_result: 'passed', review_result: 'PASS',
      recovery_success_rate: 'N/A', token_usage: 'N/A', model_cost: 'N/A',
    });
  }, TIMEOUT);

  it('completes a full flow with network calls forced to fail and contains no periodic or model path', async () => {
    // The TypeScript loader connects to a local pipe for compilation; allow only that path.
    // Every TCP-style connect target (port number or options object) and every HTTP/HTTPS/fetch
    // call is denied, so any real network request from the CLI fails loudly.
    const guardDirectory = await temporary('ai-workflow-e2e-cost-guard-');
    const preload = join(guardDirectory, 'deny-network.cjs');
    await writeFile(preload, [
      "'use strict';",
      "const net = require('node:net');",
      "const http = require('node:http');",
      "const https = require('node:https');",
      "function deny(channel) { throw new Error('network access forbidden: ' + channel); }",
      "globalThis.fetch = () => deny('fetch');",
      "http.request = () => deny('http.request');",
      "http.get = () => deny('http.get');",
      "https.request = () => deny('https.request');",
      "https.get = () => deny('https.get');",
      "const originalConnect = net.Socket.prototype.connect;",
      "net.Socket.prototype.connect = function (...args) {",
      "  let target = args[0];",
      "  if (Array.isArray(target)) target = target[0];",
      "  const localPipe = (typeof target === 'string' && (target.startsWith('/') || target.endsWith('.pipe'))) ||",
      "    (target !== null && typeof target === 'object' && typeof target.path === 'string');",
      "  if (localPipe) return originalConnect.apply(this, args);",
      "  return deny('net.Socket.connect');",
      "};",
      '',
    ].join('\n'));
    const guardedEnv = { ...process.env, NODE_OPTIONS: `--require ${preload}` };
    const { root, planDirectory } = await splitFixture(PLAN_COST);
    const commands: string[][] = [
      ['execution', 'start', '--plan', planDirectory],
      ['execution', 'task', TASK_A, '--plan', planDirectory, '--commit', SHA_A],
      ['execution', 'task', TASK_B, '--plan', planDirectory, '--commit', SHA_B],
      ['execution', 'complete', '--plan', planDirectory, '--commit', SHA_C, '--validation', 'passed', '--review', 'PASS'],
      ['execution', 'status', '--project', root],
      ['execution', 'show', '--plan', planDirectory],
      ['execution', 'events', '--plan', planDirectory],
      ['execution', 'history', '--project', root],
      ['execution', 'analytics', '--plan', planDirectory],
    ];
    for (const args of commands) {
      const result = await runCli(args, guardedEnv);
      expect(result.code, `${args.join(' ')}\n${outputOf(result)}`).toBe(0);
    }

    const sourceDirectory = join(process.cwd(), 'src', 'execution');
    const sources = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);
    const forbidden: Array<[string, RegExp]> = [
      ['setInterval', /\bsetInterval\s*\(/],
      ['setTimeout', /\bsetTimeout\s*\(/],
      ['fetch(', /\bfetch\s*\(/],
      ['HTTP client', /\b(?:https?\.(?:request|get|connect)|axios|undici|node-fetch)\b/],
      ['model SDK', /@(?:anthropic-ai|openai|langchain)\b|\b(?:generateText|createMessage|chat\.completions)\b/],
    ];
    for (const name of sources) {
      const text = await readFile(join(sourceDirectory, name), 'utf8');
      for (const [label, pattern] of forbidden) expect(pattern.test(text), `${name} contains ${label}`).toBe(false);
    }
  }, TIMEOUT);
});

describe('execution status degraded projection', () => {
  it('marks a plan with a file execution path degraded and a normal plan healthy', async () => {
    const root = await temporary('ai-workflow-e2e-degraded-');
    const brokenPlan = await frozenPlan(root, false);
    await writeFile(join(brokenPlan, 'execution'), 'execution path is a regular file\n');

    const normalPlan = await workspacePlanFixture(root, splitSpec(PLAN_NORMAL));
    await expectOk(await execution('start', '--plan', normalPlan));

    const result = await execution('status', '--project', root);
    expect(result.code, outputOf(result)).toBe(0);
    const body = parseJson(result);
    const runs = body.runs as Json[];
    const broken = runs.find((run) => run.plan_directory === brokenPlan);
    expect(broken, 'plan with a file execution path is reported').toBeDefined();
    expect(broken?.degraded).toBe(true);
    expect(Array.isArray(broken?.warnings)).toBe(true);
    expect(broken?.warnings.length).toBeGreaterThan(0);
    const normal = runs.find((run) => run.plan_directory === normalPlan);
    expect(normal, 'normal plan is reported').toBeDefined();
    expect(normal?.degraded).toBe(false);
  }, TIMEOUT);
});
