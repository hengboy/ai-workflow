import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  changedPaths,
  frozenPlan,
  snapshotTree,
  temporary,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
} from '../helpers.js';

// CLI boundary: `ai-workflow workspace checkpoint --plan <dir> --repo <name>` reads exactly one JSON
// event on stdin and atomically rewrites only that repository's implementation.yaml. Success prints
// structured JSON and exits 0; every refusal prints {valid:false, errors} and exits 1 while leaving
// the record byte-identical.

const TIMEOUT = 90_000;
const PLAN_ID = '20260930-workspace-checkpoint';

const SHA_BASE = 'a'.repeat(40);
const SHA_TASK = 'b'.repeat(40);
const SHA_REVIEW = 'c'.repeat(40);
const SHA_DELIVERY = 'd'.repeat(40);
const SHA_HEAD = 'e'.repeat(40);
const SHA_ROOT_TASK = '1'.repeat(40);
const SHA_ROOT_REVIEW = '2'.repeat(40);
const SHA_ROOT_DELIVERY = '3'.repeat(40);
const SHA_FINAL_REVIEW = '4'.repeat(40);
const SHA_FINAL = '5'.repeat(40);
const SHA_OTHER = '9'.repeat(40);

type CliResult = { code: number; stdout: string; stderr: string };
interface CheckpointSuccess { valid: true; plan_id: string; repository: string; status: string; path: string }
interface CheckpointFailure { valid: false; errors: string[] }
interface RecordedCheckpoint { kind: string; commit?: string; head?: string }
interface RecordedExecution { purpose: string; repository: string; base_commit: string }
interface ImplementationRecord {
  plan_id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  commit?: string;
  root_tasks_commit?: string;
  reviewed_commit?: string;
  execution?: RecordedExecution;
  task_checkpoints?: Record<string, RecordedCheckpoint>;
}

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function parseJson<T>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

function refusalErrors(result: CliResult): string {
  const parsed = parseJson<CheckpointFailure>(result);
  expect(parsed.valid, outputOf(result)).toBe(false);
  expect(Array.isArray(parsed.errors), outputOf(result)).toBe(true);
  return parsed.errors.join('\n');
}

async function readRecord(path: string): Promise<ImplementationRecord> {
  return parseYaml(await readFile(path, 'utf8')) as ImplementationRecord;
}

/** Run the CLI with a JSON payload on stdin. */
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

async function checkpoint(planDirectory: string, repository: string, event: unknown): Promise<CliResult> {
  const payload = typeof event === 'string' ? event : JSON.stringify(event);
  return runCliStdin(['workspace', 'checkpoint', '--plan', planDirectory, '--repo', repository], payload);
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

function taskEvent(task: string, kind: 'commit' | 'no-change', value: string): Record<string, unknown> {
  return kind === 'commit' ? { event: 'task', task, kind, commit: value } : { event: 'task', task, kind, head: value };
}

const WORKSPACE_REPO = { name: 'workspace', path: '.', dependsOn: [] };
const APP_REPO = { name: 'app', path: 'packages/app', dependsOn: [] };

function standardSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    workspaceRepos: [WORKSPACE_REPO, APP_REPO],
    tasks: [
      { id: 'task-001-root', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/root.ts'] },
      { id: 'task-002-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
    ],
    phases: [['task-001-root', 'task-002-app']],
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { ...APP_REPO, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
      ],
    },
  };
}

function zeroRootSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-002'],
    acceptanceCriteria: ['AC-002'],
    workspaceRepos: [WORKSPACE_REPO, APP_REPO],
    tasks: [
      { id: 'task-001-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
    ],
    phases: [['task-001-app']],
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: [], acceptanceCriteria: [] },
        { ...APP_REPO, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
      ],
    },
  };
}

function rootOnlySpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-001'],
    acceptanceCriteria: ['AC-001'],
    workspaceRepos: [WORKSPACE_REPO],
    tasks: [
      { id: 'task-001-root', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/root.ts'] },
    ],
    phases: [['task-001-root']],
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [{ ...WORKSPACE_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] }],
    },
  };
}

interface CheckpointFixture { root: string; planDirectory: string; appRecord: string; rootRecord: string }

async function buildWorkspace(spec: WorkspacePlanFixtureSpec): Promise<CheckpointFixture> {
  const root = await temporary('ai-workflow-checkpoint-');
  const planDirectory = await workspacePlanFixture(root, spec);
  await mkdir(join(root, 'packages/app'), { recursive: true });
  return {
    root,
    planDirectory,
    appRecord: join(root, 'packages/app', '.ai-workflow', 'plans', PLAN_ID, 'implementation.yaml'),
    rootRecord: join(root, '.ai-workflow', 'plans', PLAN_ID, 'implementation.yaml'),
  };
}

async function startedApp(): Promise<CheckpointFixture> {
  const fixture = await buildWorkspace(standardSpec());
  const started = await checkpoint(fixture.planDirectory, 'app', startEvent(fixture.root, 'app'));
  expect(started.code, outputOf(started)).toBe(0);
  return fixture;
}

async function deliverChild(root: string, planDirectory: string, repository: string, taskId: string): Promise<void> {
  expect((await checkpoint(planDirectory, repository, startEvent(root, repository))).code).toBe(0);
  expect((await checkpoint(planDirectory, repository, taskEvent(taskId, 'commit', SHA_TASK))).code).toBe(0);
  expect((await checkpoint(planDirectory, repository, { event: 'reviewed', commit: SHA_REVIEW })).code).toBe(0);
  expect((await checkpoint(planDirectory, repository, { event: 'delivered', commit: SHA_DELIVERY })).code).toBe(0);
}

describe('workspace checkpoint child lifecycle', () => {
  it('runs start, task, reviewed and delivered, retains checkpoints and is idempotent', async () => {
    const { root, planDirectory, appRecord } = await buildWorkspace(standardSpec());

    const started = await checkpoint(planDirectory, 'app', startEvent(root, 'app'));
    expect(started.code, outputOf(started)).toBe(0);
    const startOutput = parseJson<CheckpointSuccess>(started);
    expect(startOutput.valid).toBe(true);
    expect(startOutput.plan_id).toBe(PLAN_ID);
    expect(startOutput.repository).toBe('app');
    expect(startOutput.status).toBe('in-progress');
    expect(startOutput.path).toBe(appRecord);
    let record = await readRecord(appRecord);
    expect(record.status).toBe('in-progress');
    expect(record.execution?.repository).toBe('app');
    expect(record.execution?.purpose).toBe('tasks');
    expect(record.started_at).toBeTruthy();

    const task = await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'commit', SHA_TASK));
    expect(task.code, outputOf(task)).toBe(0);
    record = await readRecord(appRecord);
    expect(record.task_checkpoints).toMatchObject({ 'task-002-app': { kind: 'commit', commit: SHA_TASK } });

    const reviewed = await checkpoint(planDirectory, 'app', { event: 'reviewed', commit: SHA_REVIEW });
    expect(reviewed.code, outputOf(reviewed)).toBe(0);
    record = await readRecord(appRecord);
    expect(record.reviewed_commit).toBe(SHA_REVIEW);

    const delivered = await checkpoint(planDirectory, 'app', { event: 'delivered', commit: SHA_DELIVERY });
    expect(delivered.code, outputOf(delivered)).toBe(0);
    expect(parseJson<CheckpointSuccess>(delivered).status).toBe('completed');
    record = await readRecord(appRecord);
    expect(record.status).toBe('completed');
    expect(record.commit).toBe(SHA_DELIVERY);
    expect(record.completed_at).toMatch(/\+08:00$/);
    expect(record.task_checkpoints).toMatchObject({ 'task-002-app': { kind: 'commit', commit: SHA_TASK } });

    const beforeRepeat = await readFile(appRecord);
    const repeated = await checkpoint(planDirectory, 'app', { event: 'delivered', commit: SHA_DELIVERY });
    expect(repeated.code, outputOf(repeated)).toBe(0);
    expect(await readFile(appRecord)).toEqual(beforeRepeat);
  }, TIMEOUT);

  it('accepts full 64-hex SHAs for the anchor and a task commit', async () => {
    const { root, planDirectory, appRecord } = await buildWorkspace(standardSpec());
    const sha64 = 'a'.repeat(64);

    expect((await checkpoint(planDirectory, 'app', startEvent(root, 'app', { base_commit: sha64 }))).code).toBe(0);
    expect((await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'commit', sha64))).code).toBe(0);

    const record = await readRecord(appRecord);
    expect(record.execution?.base_commit).toBe(sha64);
    expect(record.task_checkpoints).toMatchObject({ 'task-002-app': { kind: 'commit', commit: sha64 } });
  }, TIMEOUT);

  it('records a verified no-change task checkpoint', async () => {
    const { root, planDirectory, appRecord } = await buildWorkspace(standardSpec());
    await checkpoint(planDirectory, 'app', startEvent(root, 'app'));

    const task = await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'no-change', SHA_HEAD));

    expect(task.code, outputOf(task)).toBe(0);
    const record = await readRecord(appRecord);
    expect(record.task_checkpoints).toMatchObject({ 'task-002-app': { kind: 'no-change', head: SHA_HEAD } });
  }, TIMEOUT);

  it('treats an identical repeated start and task event as idempotent and preserves bytes', async () => {
    const { root, planDirectory, appRecord } = await buildWorkspace(standardSpec());
    await checkpoint(planDirectory, 'app', startEvent(root, 'app'));
    const afterStart = await readFile(appRecord);

    const repeatedStart = await checkpoint(planDirectory, 'app', startEvent(root, 'app'));
    expect(repeatedStart.code, outputOf(repeatedStart)).toBe(0);
    expect(await readFile(appRecord)).toEqual(afterStart);

    await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'commit', SHA_TASK));
    const afterTask = await readFile(appRecord);
    const repeatedTask = await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'commit', SHA_TASK));
    expect(repeatedTask.code, outputOf(repeatedTask)).toBe(0);
    expect(await readFile(appRecord)).toEqual(afterTask);
  }, TIMEOUT);
});

describe('workspace checkpoint root lifecycle', () => {
  it('delivers root tasks as an in-progress prefix, then resets for finalization and completes', async () => {
    const { root, planDirectory, rootRecord } = await buildWorkspace(standardSpec());
    await deliverChild(root, planDirectory, 'app', 'task-002-app');

    expect((await checkpoint(planDirectory, 'workspace', startEvent(root, 'workspace'))).code).toBe(0);
    expect((await checkpoint(planDirectory, 'workspace', taskEvent('task-001-root', 'commit', SHA_ROOT_TASK))).code).toBe(0);
    const reviewed = await checkpoint(planDirectory, 'workspace', { event: 'reviewed', commit: SHA_ROOT_REVIEW });
    expect(reviewed.code, outputOf(reviewed)).toBe(0);
    const delivered = await checkpoint(planDirectory, 'workspace', { event: 'delivered', commit: SHA_ROOT_DELIVERY });
    expect(delivered.code, outputOf(delivered)).toBe(0);

    let record = await readRecord(rootRecord);
    expect(record.status).toBe('in-progress');
    expect(record.root_tasks_commit).toBe(SHA_ROOT_DELIVERY);
    expect(record.task_checkpoints).toMatchObject({ 'task-001-root': { kind: 'commit', commit: SHA_ROOT_TASK } });
    const startedAt = record.started_at;

    const finalizationStart = await checkpoint(planDirectory, 'workspace', startEvent(root, 'workspace', { purpose: 'finalization' }));
    expect(finalizationStart.code, outputOf(finalizationStart)).toBe(0);
    record = await readRecord(rootRecord);
    expect(record.status).toBe('in-progress');
    expect(record.root_tasks_commit).toBe(SHA_ROOT_DELIVERY);
    expect(record.task_checkpoints).toMatchObject({ 'task-001-root': { kind: 'commit', commit: SHA_ROOT_TASK } });
    expect(record.started_at).toBe(startedAt);
    expect(record.reviewed_commit).toBeUndefined();

    const finalizationReviewed = await checkpoint(planDirectory, 'workspace', { event: 'reviewed', commit: SHA_FINAL_REVIEW });
    expect(finalizationReviewed.code, outputOf(finalizationReviewed)).toBe(0);
    const finalized = await checkpoint(planDirectory, 'workspace', { event: 'finalized', commit: SHA_FINAL });
    expect(finalized.code, outputOf(finalized)).toBe(0);

    record = await readRecord(rootRecord);
    expect(record.status).toBe('completed');
    expect(record.completed_at).toMatch(/\+08:00$/);
    expect(record.commit).toBe(SHA_FINAL);
    expect(record.root_tasks_commit).toBe(SHA_ROOT_DELIVERY);
  }, TIMEOUT);

  it('finalizes a workspace with zero root tasks after the child is delivered', async () => {
    const { root, planDirectory, rootRecord } = await buildWorkspace(zeroRootSpec());
    await deliverChild(root, planDirectory, 'app', 'task-001-app');

    expect((await checkpoint(planDirectory, 'workspace', startEvent(root, 'workspace', { purpose: 'finalization' }))).code).toBe(0);
    expect((await checkpoint(planDirectory, 'workspace', { event: 'reviewed', commit: SHA_FINAL_REVIEW })).code).toBe(0);
    const finalized = await checkpoint(planDirectory, 'workspace', { event: 'finalized', commit: SHA_FINAL });

    expect(finalized.code, outputOf(finalized)).toBe(0);
    const record = await readRecord(rootRecord);
    expect(record.status).toBe('completed');
    expect(record.commit).toBe(SHA_FINAL);
  }, TIMEOUT);
});

describe('workspace checkpoint activation refusals', () => {
  it('refuses a non-workspace plan', async () => {
    const root = await temporary('ai-workflow-checkpoint-ordinary-');
    const planDirectory = await frozenPlan(root, true);

    const result = await checkpoint(planDirectory, 'app', startEvent(root, 'app'));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result).length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('refuses a root-only workspace plan with no participating child repository', async () => {
    const { root, planDirectory } = await buildWorkspace(rootOnlySpec());

    const result = await checkpoint(planDirectory, 'workspace', startEvent(root, 'workspace'));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result).length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('refuses an unknown --repo and writes nothing', async () => {
    const { root, planDirectory } = await buildWorkspace(standardSpec());
    const before = await snapshotTree(root);

    const result = await checkpoint(planDirectory, 'ghost', startEvent(root, 'ghost'));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('ghost');
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('refuses an invalid execution order', async () => {
    const spec = standardSpec();
    spec.phases = [['task-999-ghost']];
    const { root, planDirectory } = await buildWorkspace(spec);

    const result = await checkpoint(planDirectory, 'app', startEvent(root, 'app'));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('task-999-ghost');
  }, TIMEOUT);

  it('refuses an invalid manifest', async () => {
    const spec = standardSpec();
    spec.manifest = {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { ...APP_REPO, requirements: ['REQ-999'], acceptanceCriteria: ['AC-002'] },
      ],
    };
    const { root, planDirectory } = await buildWorkspace(spec);

    const result = await checkpoint(planDirectory, 'app', startEvent(root, 'app'));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('REQ-999');
  }, TIMEOUT);
});

describe('workspace checkpoint event schema refusals', () => {
  it('refuses an event with an unknown field and leaves the record byte-identical', async () => {
    const { root, planDirectory, appRecord } = await startedApp();
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', { ...startEvent(root, 'app'), extra: true });

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('extra');
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);

  it('refuses a wrong-typed field and leaves the record byte-identical', async () => {
    const { root, planDirectory, appRecord } = await startedApp();
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', { ...startEvent(root, 'app'), base_commit: 123 });

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('base_commit');
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);

  it('refuses a missing required field and leaves the record byte-identical', async () => {
    const { root, planDirectory, appRecord } = await startedApp();
    const before = await readFile(appRecord);
    const event = startEvent(root, 'app');
    delete event.branch;

    const result = await checkpoint(planDirectory, 'app', event);

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('branch');
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);

  it('refuses an uppercase anchor SHA and leaves the record byte-identical', async () => {
    const { root, planDirectory, appRecord } = await startedApp();
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', startEvent(root, 'app', { base_commit: 'A'.repeat(40) }));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('base_commit');
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);

  it('refuses a truncated task SHA and leaves the record byte-identical', async () => {
    const { root, planDirectory, appRecord } = await startedApp();
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'commit', 'abc123'));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('commit');
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);
});

describe('workspace checkpoint authorization and transition refusals', () => {
  it('refuses an unknown task id', async () => {
    const { root, planDirectory, appRecord } = await startedApp();
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', taskEvent('task-999-ghost', 'commit', SHA_TASK));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('task-999-ghost');
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);

  it('refuses a task id that belongs to another repository slice', async () => {
    const { root, planDirectory, appRecord } = await startedApp();
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', taskEvent('task-001-root', 'commit', SHA_TASK));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('task-001-root');
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);

  it('refuses delivered before reviewed', async () => {
    const { root, planDirectory, appRecord } = await startedApp();
    await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'commit', SHA_TASK));
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', { event: 'delivered', commit: SHA_DELIVERY });

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toMatch(/review/i);
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);

  it('refuses a task event before any execution anchor', async () => {
    const { planDirectory } = await buildWorkspace(standardSpec());

    const result = await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'commit', SHA_TASK));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result).length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('refuses a child finalization start', async () => {
    const { root, planDirectory } = await buildWorkspace(standardSpec());

    const result = await checkpoint(planDirectory, 'app', startEvent(root, 'app', { purpose: 'finalization' }));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result).length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('refuses a contradictory duplicate checkpoint for the same task', async () => {
    const { root, planDirectory, appRecord } = await startedApp();
    await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'commit', SHA_TASK));
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', taskEvent('task-002-app', 'commit', SHA_OTHER));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('task-002-app');
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);
});

describe('workspace checkpoint record refusals', () => {
  it('refuses a malformed existing record and leaves it byte-identical', async () => {
    const { root, planDirectory, appRecord } = await buildWorkspace(standardSpec());
    await mkdir(dirname(appRecord), { recursive: true });
    await writeFile(appRecord, 'plan_id: [unclosed\n');
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', startEvent(root, 'app'));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toMatch(/implementation|malformed|plan_id/i);
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);

  it('refuses an existing record whose plan_id mismatches and leaves it byte-identical', async () => {
    const { root, planDirectory, appRecord } = await buildWorkspace(standardSpec());
    await mkdir(dirname(appRecord), { recursive: true });
    await writeFile(appRecord, stringifyYaml({ plan_id: '20260101-other', status: 'in-progress', started_at: '2026-09-30T10:00:00+08:00' }));
    const before = await readFile(appRecord);

    const result = await checkpoint(planDirectory, 'app', startEvent(root, 'app'));

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('20260101-other');
    expect(await readFile(appRecord)).toEqual(before);
  }, TIMEOUT);
});
