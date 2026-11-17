import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  changedPaths,
  snapshotTree,
  temporary,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
  type WorkspaceTaskFixture,
} from '../helpers.js';

// CLI boundary: `workspace checkpoint` is the only writer of workspace records, and every successful
// checkpoint must also create or update exactly one repository-local execution run. These tests drive
// the real CLI process and observe only local files and the execution query commands.

const TIMEOUT = 120_000;
const PLAN_ID = '20261117-execution-workspace';
const PLAN_CREATED_AT = '2026-09-30T00:00:00.000Z';

const SHA_BASE = 'a'.repeat(40);
const SHA_APP_ONE = 'b'.repeat(40);
const SHA_APP_TWO = 'c'.repeat(40);
const SHA_LIB_ONE = 'd'.repeat(40);
const SHA_ROOT_ONE = 'e'.repeat(40);
const SHA_REVIEW = 'f'.repeat(40);
const SHA_APP_DELIVERY = '1'.repeat(40);
const SHA_ROOT_DELIVERY = '2'.repeat(40);
const SHA_LIB_DELIVERY = '3'.repeat(40);
const SHA_FINAL = '4'.repeat(40);
const SHA_OTHER = '9'.repeat(40);

const TASK_APP_ONE = 'task-001-app';
const TASK_LIB_ONE = 'task-002-lib';
const TASK_ROOT_ONE = 'task-003-root';
const TASK_APP_TWO = 'task-004-app';
const TASK_LIB_TWO = 'task-005-lib';

const WORKSPACE_REPO = { name: 'workspace', path: '.', dependsOn: [] };
const APP_REPO = { name: 'app', path: 'packages/app', dependsOn: [] };
const LIB_REPO = { name: 'lib', path: 'packages/lib', dependsOn: [] };

type Json = Record<string, any>;
interface CliResult { code: number; stdout: string; stderr: string }
interface EventJson { type?: string; event?: string; task_id?: string; run_id?: string; payload?: Json }

interface Fixture {
  root: string;
  planDirectory: string;
  appRoot: string;
  libRoot: string;
  appPlan: string;
  libPlan: string;
  appRecord: string;
  libRecord: string;
  rootRecord: string;
}

function outputOf(result: CliResult): string { return `${result.stdout}\n${result.stderr}`; }

function parseJson<T extends Json = Json>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

function expectSuccess(result: CliResult): Json {
  expect(result.code, outputOf(result)).toBe(0);
  const body = parseJson(result);
  expect(body.valid, outputOf(result)).toBe(true);
  expect(body.plan_id).toBe(PLAN_ID);
  expect(typeof body.repository, outputOf(result)).toBe('string');
  expect(typeof body.status, outputOf(result)).toBe('string');
  expect(typeof body.path, outputOf(result)).toBe('string');
  return body;
}

function expectRefusal(result: CliResult): string[] {
  expect(result.code, outputOf(result)).toBe(1);
  const body = parseJson(result);
  expect(body.valid, outputOf(result)).toBe(false);
  expect(Array.isArray(body.errors), outputOf(result)).toBe(true);
  expect(body.errors.length, outputOf(result)).toBeGreaterThan(0);
  return body.errors as string[];
}

async function runCliStdin(args: string[], input: string): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function runCli(args: string[]): Promise<CliResult> {
  return await runCliStdin(args, '');
}

async function checkpoint(planDirectory: string, repository: string, event: unknown): Promise<CliResult> {
  const payload = typeof event === 'string' ? event : JSON.stringify(event);
  return runCliStdin(['workspace', 'checkpoint', '--plan', planDirectory, '--repo', repository], payload);
}

async function execution(...args: string[]): Promise<CliResult> {
  return runCli(['execution', ...args]);
}

async function frozenDigest(planDirectory: string): Promise<string> {
  const source = await readFile(join(planDirectory, 'plan.md'), 'utf8');
  const match = /^digest:\s*(\S+)\s*$/m.exec(source);
  if (match?.[1] === undefined) throw new Error('frozen plan.md has no digest');
  return match[1];
}

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, 'utf8')) as Json;
}

async function readRun(planDirectory: string): Promise<Json> {
  return readJson(join(planDirectory, 'execution', 'run.json'));
}

async function readEvents(planDirectory: string): Promise<EventJson[]> {
  const source = await readFile(join(planDirectory, 'execution', 'events.jsonl'), 'utf8');
  return source.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as EventJson);
}

async function readBytes(path: string): Promise<string> {
  try { return (await readFile(path)).toString('base64'); } catch { return '<absent>'; }
}

async function executionSnapshot(planDirectory: string): Promise<Map<string, string>> {
  try { return await snapshotTree(join(planDirectory, 'execution')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

function eventTypes(events: EventJson[]): string[] {
  return events.map((event) => event.type ?? event.event ?? '');
}

function task(id: string, repo: string, requirement: string, criterion: string): WorkspaceTaskFixture {
  return { id, repo, requirements: [requirement], acceptanceCriteria: [criterion], writeScope: [`src/${id}.ts`] };
}

function fixtureSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004', 'REQ-005'],
    acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003', 'AC-004', 'AC-005'],
    workspaceRepos: [WORKSPACE_REPO, APP_REPO, LIB_REPO],
    tasks: [
      task(TASK_APP_ONE, 'app', 'REQ-001', 'AC-001'),
      task(TASK_LIB_ONE, 'lib', 'REQ-002', 'AC-002'),
      task(TASK_ROOT_ONE, 'workspace', 'REQ-003', 'AC-003'),
      task(TASK_APP_TWO, 'app', 'REQ-004', 'AC-004'),
      task(TASK_LIB_TWO, 'lib', 'REQ-005', 'AC-005'),
    ],
    phases: [[TASK_APP_ONE, TASK_LIB_ONE, TASK_ROOT_ONE], [TASK_APP_TWO, TASK_LIB_TWO]],
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
        { ...APP_REPO, requirements: ['REQ-001', 'REQ-004'], acceptanceCriteria: ['AC-001', 'AC-004'] },
        { ...LIB_REPO, requirements: ['REQ-002', 'REQ-005'], acceptanceCriteria: ['AC-002', 'AC-005'] },
      ],
    },
  };
}

function finalizationSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-001', 'REQ-002', 'REQ-006'],
    acceptanceCriteria: ['AC-001', 'AC-002', 'AC-006'],
    workspaceRepos: [WORKSPACE_REPO, APP_REPO, LIB_REPO],
    tasks: [
      task(TASK_APP_ONE, 'app', 'REQ-001', 'AC-001'),
      task(TASK_LIB_ONE, 'lib', 'REQ-002', 'AC-002'),
    ],
    phases: [[TASK_APP_ONE, TASK_LIB_ONE]],
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-006'], acceptanceCriteria: ['AC-006'] },
        { ...APP_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { ...LIB_REPO, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
      ],
    },
    workspaceFinalization: {
      requirements: ['REQ-006'],
      acceptanceCriteria: ['AC-006'],
      readScope: [{ repo: 'workspace', paths: ['MEMORY.md'] }],
      writeScope: ['docs/finalization.md'],
    },
  };
}

function sliceSpec(name: string, path: string, tasks: WorkspaceTaskFixture[], phases: string[][]): WorkspacePlanFixtureSpec {
  const ids = new Set(tasks.map((entry) => entry.id));
  return {
    planId: PLAN_ID,
    requirements: tasks.flatMap((entry) => entry.requirements),
    acceptanceCriteria: tasks.flatMap((entry) => entry.acceptanceCriteria),
    tasks,
    phases: phases.map((phase) => phase.filter((id) => ids.has(id))).filter((phase) => phase.length > 0),
    manifest: {
      planId: PLAN_ID,
      role: 'slice',
      repositories: [{
        name,
        path,
        dependsOn: [],
        requirements: tasks.flatMap((entry) => entry.requirements),
        acceptanceCriteria: tasks.flatMap((entry) => entry.acceptanceCriteria),
      }],
    },
  };
}

async function buildWorkspace(spec: WorkspacePlanFixtureSpec = fixtureSpec()): Promise<Fixture> {
  const root = await temporary('ai-workflow-exec-workspace-');
  const planDirectory = await workspacePlanFixture(root, spec);
  for (const repository of [APP_REPO, LIB_REPO]) {
    const tasks = spec.tasks.filter((entry) => entry.repo === repository.name);
    await workspacePlanFixture(join(root, repository.path), sliceSpec(repository.name, repository.path, tasks, spec.phases));
  }
  const appRoot = join(root, APP_REPO.path);
  const libRoot = join(root, LIB_REPO.path);
  const appPlan = join(appRoot, '.ai-workflow', 'plans', PLAN_ID);
  const libPlan = join(libRoot, '.ai-workflow', 'plans', PLAN_ID);
  return {
    root,
    planDirectory,
    appRoot,
    libRoot,
    appPlan,
    libPlan,
    appRecord: join(appPlan, 'implementation.yaml'),
    libRecord: join(libPlan, 'implementation.yaml'),
    rootRecord: join(planDirectory, 'implementation.yaml'),
  };
}

function startEvent(root: string, repository: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'start',
    purpose: 'tasks',
    source_root: root,
    repository,
    worktree: join(root, '.worktrees', PLAN_ID),
    branch: `ai-workflow/${PLAN_ID}`,
    target_branch: 'main',
    base_commit: SHA_BASE,
    ...overrides,
  };
}

function taskEvent(id: string, kind: 'commit' | 'no-change', value: string): Record<string, unknown> {
  return kind === 'commit' ? { event: 'task', task: id, kind, commit: value } : { event: 'task', task: id, kind, head: value };
}

async function checkpointOk(planDirectory: string, repository: string, event: unknown): Promise<void> {
  const result = await checkpoint(planDirectory, repository, event);
  expect(result.code, outputOf(result)).toBe(0);
}

async function startAll(fixture: Fixture): Promise<void> {
  for (const repository of ['app', 'lib', 'workspace']) {
    await checkpointOk(fixture.planDirectory, repository, startEvent(fixture.root, repository));
  }
}

async function checkpointPhaseOne(fixture: Fixture): Promise<void> {
  await checkpointOk(fixture.planDirectory, 'app', taskEvent(TASK_APP_ONE, 'commit', SHA_APP_ONE));
  await checkpointOk(fixture.planDirectory, 'lib', taskEvent(TASK_LIB_ONE, 'no-change', SHA_LIB_ONE));
  await checkpointOk(fixture.planDirectory, 'workspace', taskEvent(TASK_ROOT_ONE, 'commit', SHA_ROOT_ONE));
}

describe('workspace checkpoint execution telemetry', () => {
  it('creates one RUNNING run per repository with shared plan identity and no sibling writes', async () => {
    const fixture = await buildWorkspace();
    const digest = await frozenDigest(fixture.planDirectory);
    const libBefore = await snapshotTree(fixture.libRoot);
    const rootPlanBefore = await snapshotTree(fixture.planDirectory);

    const appStarted = expectSuccess(await checkpoint(fixture.planDirectory, 'app', startEvent(fixture.root, 'app')));
    expect(appStarted.repository).toBe('app');
    expect(changedPaths(libBefore, await snapshotTree(fixture.libRoot))).toEqual([]);
    expect(changedPaths(rootPlanBefore, await snapshotTree(fixture.planDirectory))).toEqual([]);

    const appRun = await readRun(fixture.appPlan);
    expect(appRun).toMatchObject({
      plan_id: PLAN_ID, plan_digest: digest, repository: 'app', status: 'RUNNING',
      phase: '1', plan_created_at: PLAN_CREATED_AT, failure_count: 0,
    });
    expect(appRun.tasks[TASK_APP_ONE]).toMatchObject({ status: 'running' });
    const appEvents = await readEvents(fixture.appPlan);
    expect(eventTypes(appEvents)).toEqual(['workflow.started', 'task.started']);
    expect(appEvents[0]?.run_id).toBe(appRun.run_id);
    expect(appEvents[1]?.task_id).toBe(TASK_APP_ONE);

    expectSuccess(await checkpoint(fixture.planDirectory, 'lib', startEvent(fixture.root, 'lib')));
    const libRun = await readRun(fixture.libPlan);
    expect(libRun).toMatchObject({
      plan_id: PLAN_ID, plan_digest: digest, repository: 'lib', status: 'RUNNING',
      phase: '1', plan_created_at: PLAN_CREATED_AT,
    });
    expect(libRun.run_id).not.toBe(appRun.run_id);
    const libEvents = await readEvents(fixture.libPlan);
    expect(eventTypes(libEvents)).toEqual(['workflow.started', 'task.started']);
    expect(libEvents[1]?.task_id).toBe(TASK_LIB_ONE);

    expectSuccess(await checkpoint(fixture.planDirectory, 'workspace', startEvent(fixture.root, 'workspace')));
    const rootRun = await readRun(fixture.planDirectory);
    expect(rootRun).toMatchObject({
      plan_id: PLAN_ID, plan_digest: digest, repository: 'workspace', status: 'RUNNING',
      plan_created_at: PLAN_CREATED_AT,
    });
    expect(rootRun.run_id).not.toBe(appRun.run_id);
    expect(rootRun.run_id).not.toBe(libRun.run_id);
    const rootEvents = await readEvents(fixture.planDirectory);
    expect(eventTypes(rootEvents)).toEqual(['workflow.started', 'task.started']);
    expect(rootEvents[1]?.task_id).toBe(TASK_ROOT_ONE);

    for (const [project, run] of [[fixture.appRoot, appRun], [fixture.libRoot, libRun], [fixture.root, rootRun]] as const) {
      const status = parseJson(await execution('status', '--project', project));
      expect(status.valid).toBe(true);
      expect(status.runs).toHaveLength(1);
      expect(status.runs[0]).toMatchObject({ plan_id: PLAN_ID, run_id: run.run_id, status: 'RUNNING' });
      expect(status.runs[0].repository).toBe(run.repository);
    }
  }, TIMEOUT);

  it('records local task evidence, opens the next local phase and stays idempotent', async () => {
    const fixture = await buildWorkspace();
    await startAll(fixture);
    const beforeTaskEvents = await readEvents(fixture.appPlan);

    const first = expectSuccess(await checkpoint(fixture.planDirectory, 'app', taskEvent(TASK_APP_ONE, 'commit', SHA_APP_ONE)));
    expect(first.repository).toBe('app');
    let appRun = await readRun(fixture.appPlan);
    expect(appRun.tasks[TASK_APP_ONE]).toMatchObject({ status: 'completed', commit: SHA_APP_ONE });
    expect(appRun.tasks[TASK_APP_TWO]).toMatchObject({ status: 'pending' });
    let appEvents = await readEvents(fixture.appPlan);
    expect(eventTypes(appEvents)).toEqual([...eventTypes(beforeTaskEvents), 'task.completed']);
    expect(appEvents.at(-1)?.task_id).toBe(TASK_APP_ONE);
    expect(appEvents.at(-1)?.payload).toMatchObject({ commit: SHA_APP_ONE });

    const runBytes = await readBytes(join(fixture.appPlan, 'execution', 'run.json'));
    const repeat = expectSuccess(await checkpoint(fixture.planDirectory, 'app', taskEvent(TASK_APP_ONE, 'commit', SHA_APP_ONE)));
    expect(repeat.repository).toBe('app');
    expect(await readBytes(join(fixture.appPlan, 'execution', 'run.json'))).toBe(runBytes);
    expect((await readEvents(fixture.appPlan)).length).toBe(appEvents.length);

    await checkpointRemainingPhaseOne(fixture);

    const next = expectSuccess(await checkpoint(fixture.planDirectory, 'app', taskEvent(TASK_APP_TWO, 'commit', SHA_APP_TWO)));
    expect(next.repository).toBe('app');
    appRun = await readRun(fixture.appPlan);
    expect(appRun.phase).toBe('2');
    expect(appRun.tasks[TASK_APP_TWO]).toMatchObject({ status: 'running' });
    appEvents = await readEvents(fixture.appPlan);
    expect(eventTypes(appEvents)).toEqual([
      'workflow.started', 'task.started', 'task.completed', 'task.completed', 'task.started',
    ]);
    expect(appEvents.map((event) => event.task_id ?? null)).toEqual([null, TASK_APP_ONE, TASK_APP_ONE, TASK_APP_TWO, TASK_APP_TWO]);
    expect((await readRun(fixture.libPlan)).tasks[TASK_LIB_ONE]).toMatchObject({ status: 'completed', head: SHA_LIB_ONE });
    expect((await readRun(fixture.planDirectory)).tasks[TASK_ROOT_ONE]).toMatchObject({ status: 'completed', commit: SHA_ROOT_ONE });
  }, TIMEOUT);

  it('accepts optional validation and repair on reviewed, then refuses malformed reviewed events', async () => {
    const fixture = await buildWorkspace();
    await startAll(fixture);
    await checkpointPhaseOne(fixture);
    await checkpointOk(fixture.planDirectory, 'app', taskEvent(TASK_APP_TWO, 'commit', SHA_APP_TWO));

    const recordBytes = await readBytes(fixture.appRecord);
    const eventCount = (await readEvents(fixture.appPlan)).length;

    const unknownField = await checkpoint(fixture.planDirectory, 'app', { event: 'reviewed', commit: SHA_REVIEW, approval: 'yes' });
    expect(expectRefusal(unknownField).join('\n')).toContain('approval');
    const missingField = await checkpoint(fixture.planDirectory, 'app', { event: 'reviewed' });
    expect(expectRefusal(missingField).join('\n')).toContain('commit');
    const malformed = await checkpoint(fixture.planDirectory, 'app', { event: 'reviewed', commit: SHA_REVIEW, validation: 7 });
    expect(expectRefusal(malformed).join('\n')).toMatch(/validation/);
    expect(await readBytes(fixture.appRecord)).toBe(recordBytes);
    expect((await readEvents(fixture.appPlan)).length).toBe(eventCount);

    const reviewed = expectSuccess(await checkpoint(fixture.planDirectory, 'app', {
      event: 'reviewed', commit: SHA_REVIEW, validation: 'passed', repair: 'fixed',
    }));
    expect(reviewed.repository).toBe('app');
    const record = parseYaml(await readFile(fixture.appRecord, 'utf8')) as Json;
    expect(record.reviewed_commit).toBe(SHA_REVIEW);
    const events = await readEvents(fixture.appPlan);
    expect(events.length).toBe(eventCount + 3);
    expect(eventTypes(events.slice(-3))).toEqual(['validation.completed', 'repair.completed', 'review.completed']);
    expect(events.at(-3)?.payload).toMatchObject({ result: 'passed' });
    expect(events.at(-2)?.payload).toMatchObject({ result: 'fixed' });
  }, TIMEOUT);

  it('completes child and root runs on delivery without touching sibling execution files', async () => {
    const fixture = await buildWorkspace();
    await startAll(fixture);
    await checkpointPhaseOne(fixture);
    await checkpointOk(fixture.planDirectory, 'app', taskEvent(TASK_APP_TWO, 'commit', SHA_APP_TWO));
    await checkpointOk(fixture.planDirectory, 'app', { event: 'reviewed', commit: SHA_REVIEW });
    await checkpointOk(fixture.planDirectory, 'workspace', { event: 'reviewed', commit: SHA_REVIEW });

    const libBeforeChild = await executionSnapshot(fixture.libPlan);
    const rootBeforeChild = await executionSnapshot(fixture.planDirectory);
    const childDelivered = expectSuccess(await checkpoint(fixture.planDirectory, 'app', { event: 'delivered', commit: SHA_APP_DELIVERY }));
    expect(childDelivered.repository).toBe('app');
    expect(childDelivered.status).toBe('completed');
    expect(changedPaths(libBeforeChild, await executionSnapshot(fixture.libPlan))).toEqual([]);
    expect(changedPaths(rootBeforeChild, await executionSnapshot(fixture.planDirectory))).toEqual([]);
    const appRun = await readRun(fixture.appPlan);
    expect(appRun).toMatchObject({ status: 'COMPLETED', repository: 'app' });
    const appRecord = parseYaml(await readFile(fixture.appRecord, 'utf8')) as Json;
    expect(appRecord.commit).toBe(SHA_APP_DELIVERY);
    const appEvents = await readEvents(fixture.appPlan);
    expect(eventTypes(appEvents)).toEqual([
      'workflow.started', 'task.started', 'task.completed', 'task.completed', 'task.started',
      'review.completed', 'delivery.completed', 'workflow.completed',
    ]);
    expect(appEvents.at(-2)?.payload).toMatchObject({ commit: SHA_APP_DELIVERY });
    expect((await snapshotTree(fixture.appPlan)).has('execution/lock.json')).toBe(false);
    const appStatus = parseJson(await execution('status', '--project', fixture.appRoot));
    expect(appStatus.runs[0].lock.state).toBe('none');

    const appBeforeRoot = await executionSnapshot(fixture.appPlan);
    const libBeforeRoot = await executionSnapshot(fixture.libPlan);
    const rootDelivered = expectSuccess(await checkpoint(fixture.planDirectory, 'workspace', { event: 'delivered', commit: SHA_ROOT_DELIVERY }));
    expect(rootDelivered.repository).toBe('workspace');
    expect(rootDelivered.status).toBe('in-progress');
    expect(changedPaths(appBeforeRoot, await executionSnapshot(fixture.appPlan))).toEqual([]);
    expect(changedPaths(libBeforeRoot, await executionSnapshot(fixture.libPlan))).toEqual([]);
    const rootRun = await readRun(fixture.planDirectory);
    expect(rootRun).toMatchObject({ status: 'RUNNING', repository: 'workspace' });
    const rootEvents = await readEvents(fixture.planDirectory);
    expect(eventTypes(rootEvents)).toEqual(['workflow.started', 'task.started', 'task.completed', 'review.completed', 'delivery.completed']);
    expect(rootEvents.at(-1)?.payload).toMatchObject({ commit: SHA_ROOT_DELIVERY });
    expect((await snapshotTree(fixture.planDirectory)).has('execution/lock.json')).toBe(false);
  }, TIMEOUT);

  it('creates a finalization root run and completes it without mutating delivered children', async () => {
    const fixture = await buildWorkspace(finalizationSpec());
    for (const [repository, commit] of [['app', SHA_APP_DELIVERY], ['lib', SHA_LIB_DELIVERY]] as const) {
      await checkpointOk(fixture.planDirectory, repository, startEvent(fixture.root, repository));
      const taskId = repository === 'app' ? TASK_APP_ONE : TASK_LIB_ONE;
      await checkpointOk(fixture.planDirectory, repository, taskEvent(taskId, 'commit', commit === SHA_APP_DELIVERY ? SHA_APP_ONE : SHA_LIB_ONE));
      await checkpointOk(fixture.planDirectory, repository, { event: 'reviewed', commit: SHA_REVIEW });
      await checkpointOk(fixture.planDirectory, repository, { event: 'delivered', commit });
    }

    expectSuccess(await checkpoint(fixture.planDirectory, 'workspace', startEvent(fixture.root, 'workspace', { purpose: 'finalization' })));
    const rootRun = await readRun(fixture.planDirectory);
    expect(rootRun).toMatchObject({ status: 'RUNNING', repository: 'workspace', plan_id: PLAN_ID });
    const appBefore = await executionSnapshot(fixture.appPlan);
    const libBefore = await executionSnapshot(fixture.libPlan);
    await checkpointOk(fixture.planDirectory, 'workspace', { event: 'reviewed', commit: SHA_REVIEW });
    const finalized = expectSuccess(await checkpoint(fixture.planDirectory, 'workspace', { event: 'finalized', commit: SHA_FINAL }));
    expect(finalized.repository).toBe('workspace');
    expect(finalized.status).toBe('completed');
    expect(changedPaths(appBefore, await executionSnapshot(fixture.appPlan))).toEqual([]);
    expect(changedPaths(libBefore, await executionSnapshot(fixture.libPlan))).toEqual([]);
    const completed = await readRun(fixture.planDirectory);
    expect(completed).toMatchObject({ status: 'COMPLETED', repository: 'workspace' });
    expect(completed.run_id).toBe(rootRun.run_id);
    expect(eventTypes(await readEvents(fixture.planDirectory))).toEqual(['workflow.started', 'review.completed', 'delivery.completed', 'workflow.completed']);
  }, TIMEOUT);

  it('warns on telemetry failure while keeping the authoritative record and exit code unchanged', async () => {
    const fixture = await buildWorkspace();
    const blockedPath = join(fixture.appPlan, 'execution');
    await writeFile(blockedPath, 'execution is not writable\n');

    const degraded = expectSuccess(await checkpoint(fixture.planDirectory, 'app', startEvent(fixture.root, 'app')));
    expect(degraded.repository).toBe('app');
    expect(Array.isArray(degraded.warnings)).toBe(true);
    expect(degraded.warnings.length).toBeGreaterThan(0);
    const recordBytes = await readBytes(fixture.appRecord);
    const record = parseYaml(await readFile(fixture.appRecord, 'utf8')) as Json;
    expect(record.plan_id).toBe(PLAN_ID);
    expect(record.status).toBe('in-progress');
    expect(record.execution).toMatchObject({ purpose: 'tasks', repository: 'app', base_commit: SHA_BASE });

    await rm(blockedPath);
    const healthy = expectSuccess(await checkpoint(fixture.planDirectory, 'app', startEvent(fixture.root, 'app')));
    expect(healthy.code).toBe(degraded.code);
    for (const key of ['valid', 'plan_id', 'repository', 'status', 'path']) expect(healthy[key]).toEqual(degraded[key]);
    expect(await readBytes(fixture.appRecord)).toBe(recordBytes);
  }, TIMEOUT);

  it('keeps sibling runs isolated when one repository is paused and queried', async () => {
    const fixture = await buildWorkspace();
    await startAll(fixture);
    await checkpointPhaseOne(fixture);
    const appRun = await readRun(fixture.appPlan);
    const libRun = await readRun(fixture.libPlan);
    const rootRun = await readRun(fixture.planDirectory);
    const libBefore = await executionSnapshot(fixture.libPlan);
    const rootBefore = await executionSnapshot(fixture.planDirectory);

    const paused = parseJson(await execution('pause', '--plan', fixture.appPlan));
    expect(paused.valid).toBe(true);
    expect(paused.status).toBe('PAUSED');
    expect(paused.run_id).toBe(appRun.run_id);
    expect(changedPaths(libBefore, await executionSnapshot(fixture.libPlan))).toEqual([]);
    expect(changedPaths(rootBefore, await executionSnapshot(fixture.planDirectory))).toEqual([]);
    expect((await readRun(fixture.libPlan)).run_id).toBe(libRun.run_id);
    expect((await readRun(fixture.planDirectory)).run_id).toBe(rootRun.run_id);

    const appEvents = parseJson(await execution('events', '--project', fixture.appRoot));
    expect(appEvents.plan_id).toBe(PLAN_ID);
    expect(appEvents.run_id).toBe(appRun.run_id);
    expect(eventTypes(appEvents.events as EventJson[])).toContain('workflow.paused');
    const shown = parseJson(await execution('show', '--project', fixture.appRoot));
    expect(shown.run).toMatchObject({ run_id: appRun.run_id, repository: 'app', status: 'PAUSED' });
    expect(shown.checkpoint.repository).toBe('app');
    const libStatus = parseJson(await execution('status', '--project', fixture.libRoot));
    expect(libStatus.runs).toHaveLength(1);
    expect(libStatus.runs[0]).toMatchObject({ run_id: libRun.run_id, repository: 'lib', status: 'RUNNING' });
    const rootStatus = parseJson(await execution('status', '--project', fixture.root));
    expect(rootStatus.runs).toHaveLength(1);
    expect(rootStatus.runs[0]).toMatchObject({ run_id: rootRun.run_id, repository: 'workspace', status: 'RUNNING' });
  }, TIMEOUT);

  it('refuses malformed checkpoint input with the existing shape and byte-identical records', async () => {
    const fixture = await buildWorkspace();
    await checkpointOk(fixture.planDirectory, 'app', startEvent(fixture.root, 'app'));
    const appRecordBytes = await readBytes(fixture.appRecord);
    const rootRecordBytes = await readBytes(fixture.rootRecord);
    const eventCount = (await readEvents(fixture.appPlan)).length;

    const malformedJson = await checkpoint(fixture.planDirectory, 'app', '{');
    expect(expectRefusal(malformedJson).join('\n')).toMatch(/JSON/);
    const unknownEvent = await checkpoint(fixture.planDirectory, 'app', { event: 'restart' });
    expect(expectRefusal(unknownEvent).join('\n')).toContain('restart');
    const wrongRepository = await checkpoint(fixture.planDirectory, 'app', startEvent(fixture.root, 'lib'));
    expect(expectRefusal(wrongRepository).join('\n')).toContain('lib');
    const unauthorizedTask = await checkpoint(fixture.planDirectory, 'app', taskEvent(TASK_LIB_ONE, 'commit', SHA_OTHER));
    expect(expectRefusal(unauthorizedTask).join('\n')).toContain(TASK_LIB_ONE);
    const earlyReview = await checkpoint(fixture.planDirectory, 'app', { event: 'reviewed', commit: SHA_REVIEW });
    expect(expectRefusal(earlyReview).join('\n')).toMatch(/task|review/i);

    expect(await readBytes(fixture.appRecord)).toBe(appRecordBytes);
    expect(await readBytes(fixture.rootRecord)).toBe(rootRecordBytes);
    expect((await readEvents(fixture.appPlan)).length).toBe(eventCount);
  }, TIMEOUT);
});

async function checkpointRemainingPhaseOne(fixture: Fixture): Promise<void> {
  await checkpointOk(fixture.planDirectory, 'lib', taskEvent(TASK_LIB_ONE, 'no-change', SHA_LIB_ONE));
  await checkpointOk(fixture.planDirectory, 'workspace', taskEvent(TASK_ROOT_ONE, 'commit', SHA_ROOT_ONE));
}

describe('workspace reviewed checkpoint idempotency', () => {
  it('keeps the event count unchanged for a second identical reviewed checkpoint', async () => {
    const fixture = await buildWorkspace();
    await startAll(fixture);
    await checkpointPhaseOne(fixture);
    await checkpointOk(fixture.planDirectory, 'app', taskEvent(TASK_APP_TWO, 'commit', SHA_APP_TWO));

    const reviewedEvent = { event: 'reviewed', commit: SHA_REVIEW, validation: 'passed', repair: 'fixed' };
    const first = expectSuccess(await checkpoint(fixture.planDirectory, 'app', reviewedEvent));
    expect(first.repository).toBe('app');
    const eventCount = (await readEvents(fixture.appPlan)).length;
    expect(eventCount).toBeGreaterThan(0);

    const repeat = expectSuccess(await checkpoint(fixture.planDirectory, 'app', reviewedEvent));
    expect(repeat.repository).toBe('app');
    expect((await readEvents(fixture.appPlan)).length).toBe(eventCount);
  }, TIMEOUT);
});
