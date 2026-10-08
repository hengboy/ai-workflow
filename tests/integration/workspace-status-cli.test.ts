import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  changedPaths,
  realWorkspaceFixture,
  snapshotTree,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
} from '../helpers.js';

const exec = promisify(execFile);
const TIMEOUT = 90_000;
const PLAN_ID = '20260930-workspace-status';
const STARTED_AT = '2026-09-30T10:00:00+08:00';
const COMPLETED_AT = '2026-09-30T11:00:00+08:00';

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], { maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function parseJson<T>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

interface StatusRepository {
  name: string;
  path: string;
  slice: string;
  record: string;
  delivery_commit: string | null;
}
interface StatusWorkspaceRootEntry {
  name: string;
  path: string;
  record: string;
  tasks_delivered: boolean;
  delivery_commit: string | null;
}
interface StatusOutput {
  valid: boolean;
  plan_id: string;
  workspace_root: string;
  order: string[];
  repositories: StatusRepository[];
  workspace_root_entry: StatusWorkspaceRootEntry;
  next_repository: string | null;
  ready_for_finalization: boolean;
}
interface StatusFailure {
  valid: boolean;
  errors: string[];
}

const WORKSPACE_REPO = { name: 'workspace' as const, path: '.', dependsOn: [] };
const APP_REPO = { name: 'app' as const, path: 'packages/app', dependsOn: [] };
const LIB_REPO = { name: 'lib' as const, path: 'packages/lib', dependsOn: ['app'] };
const APP_SHA = '1111111111111111111111111111111111111111';
const LIB_SHA = '2222222222222222222222222222222222222222';
const ROOT_SHA = '3333333333333333333333333333333333333333';

function baseSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-001', 'REQ-002', 'REQ-003'],
    acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003'],
    workspaceRepos: [WORKSPACE_REPO, APP_REPO, LIB_REPO],
    tasks: [
      { id: 'task-001-workspace', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/workspace.ts'] },
      { id: 'task-002-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
      { id: 'task-003-lib', repo: 'lib', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], writeScope: ['src/lib.ts'] },
    ],
    phases: [['task-001-workspace'], ['task-002-app'], ['task-003-lib']],
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { ...APP_REPO, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { ...LIB_REPO, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
      ],
    },
  };
}

/**
 * A workspace whose manifest array order (lib, app, workspace) differs from the frozen
 * execution-order task appearance order (workspace, app, lib), so `next_repository` must
 * not follow the manifest array.
 */
function reorderedManifestSpec(): WorkspacePlanFixtureSpec {
  const spec = baseSpec();
  spec.manifest = {
    planId: PLAN_ID,
    role: 'workspace',
    repositories: [
      { ...LIB_REPO, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
      { ...APP_REPO, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
      { ...WORKSPACE_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
    ],
  };
  return spec;
}

/** A workspace plan that owns zero root tasks, so the root is implicitly delivered. */
function rootlessSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    workspaceRepos: [WORKSPACE_REPO, APP_REPO, LIB_REPO],
    tasks: [
      { id: 'task-001-app', repo: 'app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/app.ts'] },
      { id: 'task-002-lib', repo: 'lib', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/lib.ts'] },
    ],
    phases: [['task-001-app'], ['task-002-lib']],
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: [], acceptanceCriteria: [] },
        { ...APP_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { ...LIB_REPO, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
      ],
    },
  };
}

interface Workspace { root: string; directory: string; app: string; lib: string }

async function buildWorkspace(spec: WorkspacePlanFixtureSpec = baseSpec()): Promise<Workspace> {
  const { root, repos } = await realWorkspaceFixture([
    { name: 'app', path: 'packages/app' },
    { name: 'lib', path: 'packages/lib' },
  ]);
  const directory = await workspacePlanFixture(root, spec);
  const app = repos.find((repo) => repo.name === 'app')?.absolute;
  const lib = repos.find((repo) => repo.name === 'lib')?.absolute;
  if (!app || !lib) throw new Error('fixture is missing app or lib');
  return { root, directory, app, lib };
}

async function writeRecord(repository: string, status: 'in-progress' | 'completed', commit?: string, planId = PLAN_ID): Promise<string> {
  const directory = join(repository, '.ai-workflow/plans', PLAN_ID);
  await mkdir(directory, { recursive: true });
  const lines = [`plan_id: "${planId}"`, `status: ${status}`, `started_at: "${STARTED_AT}"`];
  if (status === 'completed') {
    lines.push(`completed_at: "${COMPLETED_AT}"`);
    if (commit) lines.push(`commit: "${commit}"`);
  }
  const path = join(directory, 'implementation.yaml');
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
}

/**
 * Write the root delivery interruption: the same root record stays `in-progress` and
 * pins the root task commit, which is the whole-root delivery evidence. The optional
 * `planId` lets a negative case declare a mismatched root record.
 */
async function writeRootDelivery(repository: string, commit: string, planId = PLAN_ID): Promise<string> {
  const directory = join(repository, '.ai-workflow/plans', PLAN_ID);
  await mkdir(directory, { recursive: true });
  const lines = [`plan_id: "${planId}"`, 'status: in-progress', `started_at: "${STARTED_AT}"`, `root_tasks_commit: "${commit}"`];
  const path = join(directory, 'implementation.yaml');
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
}

async function runStatus(root: string, directory: string): Promise<StatusOutput> {
  const before = await snapshotTree(root);
  const result = await runCli(['workspace', 'status', '--plan', directory]);
  expect(result.code, outputOf(result)).toBe(0);
  const parsed = parseJson<StatusOutput>(result);
  expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  return parsed;
}

function expectWorkspaceRoot(output: { workspace_root: string }, root: string, resolved: string): void {
  expect([root, resolved]).toContain(output.workspace_root);
}

describe('workspace status', () => {
  it('reports missing slices, the frozen execution order, a pending root entry and the next repository including the root task', async () => {
    const { root, directory } = await buildWorkspace();
    const resolved = await realpath(root);
    await writeRecord(root, 'in-progress');

    const output = await runStatus(root, directory);

    expect(output.valid).toBe(true);
    expect(output.plan_id).toBe(PLAN_ID);
    expectWorkspaceRoot(output, root, resolved);
    expect(output.order).toEqual(['workspace', 'app', 'lib']);
    expect(output.repositories).toEqual([
      { name: 'app', path: 'packages/app', slice: 'missing', record: 'missing', delivery_commit: null },
      { name: 'lib', path: 'packages/lib', slice: 'missing', record: 'missing', delivery_commit: null },
    ]);
    expect(output.workspace_root_entry).toEqual({ name: 'workspace', path: '.', record: 'in-progress', tasks_delivered: false, delivery_commit: null });
    expect(output.next_repository).toBe('workspace');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);

  it('keeps the root record in-progress and marks the root delivered through root_tasks_commit', async () => {
    const { root, directory } = await buildWorkspace();
    await writeRootDelivery(root, ROOT_SHA);

    const output = await runStatus(root, directory);

    expect(output.workspace_root_entry).toEqual({ name: 'workspace', path: '.', record: 'in-progress', tasks_delivered: true, delivery_commit: ROOT_SHA });
    expect(output.next_repository).toBe('app');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);

  it('treats a completed root record commit as whole-root delivery evidence', async () => {
    const { root, directory } = await buildWorkspace();
    await writeRecord(root, 'completed', ROOT_SHA);

    const output = await runStatus(root, directory);

    expect(output.workspace_root_entry).toEqual({ name: 'workspace', path: '.', record: 'completed', tasks_delivered: true, delivery_commit: ROOT_SHA });
    expect(output.next_repository).toBe('app');
  }, TIMEOUT);

  it('orders the next repository by frozen task appearance, not the manifest array', async () => {
    const { root, directory } = await buildWorkspace(reorderedManifestSpec());
    await writeRootDelivery(root, ROOT_SHA);

    const output = await runStatus(root, directory);

    expect(output.valid).toBe(true);
    expect(output.workspace_root_entry.tasks_delivered).toBe(true);
    expect(output.next_repository).toBe('app');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);

  it('derives slice presence, partial and full completion, delivery commits and readiness', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const distributed = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(distributed.code, outputOf(distributed)).toBe(0);
    await writeRootDelivery(root, ROOT_SHA);

    const beforeRecords = await runStatus(root, directory);
    expect(beforeRecords.repositories).toEqual([
      { name: 'app', path: 'packages/app', slice: 'present', record: 'missing', delivery_commit: null },
      { name: 'lib', path: 'packages/lib', slice: 'present', record: 'missing', delivery_commit: null },
    ]);
    expect(beforeRecords.workspace_root_entry).toEqual({ name: 'workspace', path: '.', record: 'in-progress', tasks_delivered: true, delivery_commit: ROOT_SHA });
    expect(beforeRecords.next_repository).toBe('app');
    expect(beforeRecords.ready_for_finalization).toBe(false);

    await writeRecord(app, 'completed', APP_SHA);
    const afterApp = await runStatus(root, directory);
    expect(afterApp.repositories).toEqual([
      { name: 'app', path: 'packages/app', slice: 'present', record: 'completed', delivery_commit: APP_SHA },
      { name: 'lib', path: 'packages/lib', slice: 'present', record: 'missing', delivery_commit: null },
    ]);
    expect(afterApp.next_repository).toBe('lib');
    expect(afterApp.ready_for_finalization).toBe(false);

    await writeRecord(lib, 'completed', LIB_SHA);
    const complete = await runStatus(root, directory);
    expect(complete.repositories).toEqual([
      { name: 'app', path: 'packages/app', slice: 'present', record: 'completed', delivery_commit: APP_SHA },
      { name: 'lib', path: 'packages/lib', slice: 'present', record: 'completed', delivery_commit: LIB_SHA },
    ]);
    expect(complete.next_repository).toBeNull();
    expect(complete.ready_for_finalization).toBe(true);
  }, TIMEOUT);

  it('reports a divergent slice without failing and still does not become ready even when its record is completed', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const distributed = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(distributed.code, outputOf(distributed)).toBe(0);
    await writeRootDelivery(root, ROOT_SHA);
    const mutatedPath = join(app, '.ai-workflow/plans', PLAN_ID, 'spec.md');
    await writeFile(mutatedPath, `${await readFile(mutatedPath, 'utf8')}<!-- mutated -->\n`);
    await writeRecord(app, 'completed', APP_SHA);
    await writeRecord(lib, 'completed', LIB_SHA);

    const output = await runStatus(root, directory);

    expect(output.valid).toBe(true);
    expect(output.repositories).toEqual([
      { name: 'app', path: 'packages/app', slice: 'divergent', record: 'completed', delivery_commit: APP_SHA },
      { name: 'lib', path: 'packages/lib', slice: 'present', record: 'completed', delivery_commit: LIB_SHA },
    ]);
    expect(output.next_repository).toBe('app');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);

  it('treats zero root-owned tasks as implicitly delivered', async () => {
    const { root, directory } = await buildWorkspace(rootlessSpec());

    const output = await runStatus(root, directory);

    expect(output.valid).toBe(true);
    expect(output.workspace_root_entry).toEqual({ name: 'workspace', path: '.', record: 'missing', tasks_delivered: true, delivery_commit: null });
    expect(output.next_repository).toBe('app');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);

  it('does not enable readiness for a completed child whose record plan_id mismatches', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const distributed = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(distributed.code, outputOf(distributed)).toBe(0);
    await writeRootDelivery(root, ROOT_SHA);
    await writeRecord(app, 'completed', APP_SHA);
    await writeRecord(lib, 'completed', LIB_SHA, '20260101-other');

    const output = await runStatus(root, directory);

    expect(output.ready_for_finalization).toBe(false);
    expect(output.next_repository).toBe('lib');
  }, TIMEOUT);

  it('does not enable readiness for a completed child with a malformed delivery commit', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const distributed = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(distributed.code, outputOf(distributed)).toBe(0);
    await writeRootDelivery(root, ROOT_SHA);
    await writeRecord(app, 'completed', APP_SHA);
    await writeRecord(lib, 'completed', 'not-a-full-sha');

    const output = await runStatus(root, directory);

    expect(output.ready_for_finalization).toBe(false);
    expect(output.next_repository).toBe('lib');
  }, TIMEOUT);

  it('fails validation before reporting a manifest that diverges from the frozen plan', async () => {
    const spec = baseSpec();
    const repositories = spec.manifest?.repositories ?? [];
    spec.manifest = { planId: PLAN_ID, role: 'workspace', repositories: [...repositories, { name: 'extra', path: 'packages/extra', dependsOn: [], requirements: [], acceptanceCriteria: [] }] };
    const { root, directory } = await buildWorkspace(spec);

    const before = await snapshotTree(root);
    const result = await runCli(['workspace', 'status', '--plan', directory]);
    const parsed = parseJson<StatusFailure>(result);

    expect(result.code, outputOf(result)).toBe(1);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('does not become ready when a completed child record has no present slice', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    await writeRootDelivery(root, ROOT_SHA);
    await writeRecord(app, 'completed', APP_SHA);
    await writeRecord(lib, 'completed', LIB_SHA);

    const output = await runStatus(root, directory);

    expect(output.valid).toBe(true);
    expect(output.repositories).toEqual([
      { name: 'app', path: 'packages/app', slice: 'missing', record: 'completed', delivery_commit: APP_SHA },
      { name: 'lib', path: 'packages/lib', slice: 'missing', record: 'completed', delivery_commit: LIB_SHA },
    ]);
    expect(output.next_repository).toBe('app');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);

  it('does not become ready while root tasks are pending even when every child is complete', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const distributed = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(distributed.code, outputOf(distributed)).toBe(0);
    await writeRecord(app, 'completed', APP_SHA);
    await writeRecord(lib, 'completed', LIB_SHA);

    const output = await runStatus(root, directory);

    expect(output.workspace_root_entry.tasks_delivered).toBe(false);
    expect(output.next_repository).toBe('workspace');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);

  it('does not count a malformed root_tasks_commit as root delivery', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const distributed = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(distributed.code, outputOf(distributed)).toBe(0);
    await writeRootDelivery(root, 'not-a-full-sha');
    await writeRecord(app, 'completed', APP_SHA);
    await writeRecord(lib, 'completed', LIB_SHA);

    const output = await runStatus(root, directory);

    expect(output.workspace_root_entry).toEqual({ name: 'workspace', path: '.', record: 'in-progress', tasks_delivered: false, delivery_commit: null });
    expect(output.next_repository).toBe('workspace');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);

  it('does not count root delivery when the root record plan_id mismatches', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const distributed = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(distributed.code, outputOf(distributed)).toBe(0);
    await writeRootDelivery(root, ROOT_SHA, '20260101-other');
    await writeRecord(app, 'completed', APP_SHA);
    await writeRecord(lib, 'completed', LIB_SHA);

    const output = await runStatus(root, directory);

    expect(output.workspace_root_entry).toEqual({ name: 'workspace', path: '.', record: 'missing', tasks_delivered: false, delivery_commit: null });
    expect(output.next_repository).toBe('workspace');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);

  it('does not count a completed root record with a malformed commit as root delivery', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const distributed = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(distributed.code, outputOf(distributed)).toBe(0);
    await writeRecord(root, 'completed', 'not-a-full-sha');
    await writeRecord(app, 'completed', APP_SHA);
    await writeRecord(lib, 'completed', LIB_SHA);

    const output = await runStatus(root, directory);

    expect(output.workspace_root_entry).toEqual({ name: 'workspace', path: '.', record: 'completed', tasks_delivered: false, delivery_commit: null });
    expect(output.next_repository).toBe('workspace');
    expect(output.ready_for_finalization).toBe(false);
  }, TIMEOUT);
});
