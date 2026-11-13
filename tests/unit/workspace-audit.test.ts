import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { auditWorkspace, type WorkspaceAuditResult } from '../../src/workspace/audit.js';
import { distributeWorkspace } from '../../src/workspace/distribute.js';
import {
  implementationRecordPath,
  writeWorkspaceRecord,
  type ExecutionAnchor,
  type WorkspaceExecutionRecord,
} from '../../src/workspace/record.js';
import {
  changedPaths,
  commitFile,
  gitInit,
  realWorkspaceFixture,
  snapshotTree,
  temporary,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
} from '../helpers.js';

const exec = promisify(execFile);
const TIMEOUT = 90_000;
const PLAN_ID = '20260930-workspace-audit';
const STARTED_AT = '2026-09-30T10:00:00+08:00';
const COMPLETED_AT = '2026-09-30T11:00:00+08:00';
const MISSING_SHA = '0123456789abcdef0123456789abcdef01234567';

interface AuditView {
  valid: boolean;
  plan_id?: string;
  repositories?: { name: string }[];
  checks?: unknown[];
  blockers?: string[];
  warnings?: string[];
}

function view(result: WorkspaceAuditResult): AuditView {
  return result as unknown as AuditView;
}

function expectStrings(value: unknown, label: string): string[] {
  expect(Array.isArray(value), label).toBe(true);
  const entries = value as unknown[];
  for (const entry of entries) expect(typeof entry, label).toBe('string');
  return entries as string[];
}

const WORKSPACE_REPO = { name: 'workspace' as const, path: '.', dependsOn: [] };
const APP_REPO = { name: 'app' as const, path: 'packages/app', dependsOn: [] };
const LIB_REPO = { name: 'lib' as const, path: 'packages/lib', dependsOn: ['app'] };

function baselineSpec(): WorkspacePlanFixtureSpec {
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

interface BuiltWorkspace {
  root: string;
  directory: string;
  app: string;
  lib: string;
}

async function buildWorkspace(): Promise<BuiltWorkspace> {
  const { root, repos } = await realWorkspaceFixture([
    { name: 'app', path: 'packages/app' },
    { name: 'lib', path: 'packages/lib' },
  ]);
  const directory = await workspacePlanFixture(root, baselineSpec());
  const app = repos.find((repository) => repository.name === 'app')?.absolute;
  const lib = repos.find((repository) => repository.name === 'lib')?.absolute;
  if (!app || !lib) throw new Error('fixture is missing app or lib');
  return { root, directory, app, lib };
}

async function distributeSlices(directory: string): Promise<void> {
  const result = await distributeWorkspace(directory);
  expect(result.valid, JSON.stringify(result.errors ?? [])).toBe(true);
}

async function headOf(repository: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repository, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function writeRecord(repository: string, record: WorkspaceExecutionRecord): Promise<void> {
  const path = implementationRecordPath(repository, '.', PLAN_ID);
  await mkdir(join(repository, '.ai-workflow', 'plans', PLAN_ID), { recursive: true });
  await writeWorkspaceRecord(path, record);
}

function baseRecord(): WorkspaceExecutionRecord {
  return { plan_id: PLAN_ID, status: 'in-progress', started_at: STARTED_AT };
}

function anchorOf(root: string, worktree: string, baseCommit: string): ExecutionAnchor {
  return {
    purpose: 'tasks',
    source_root: root,
    repository: 'app',
    worktree,
    branch: `ai-workflow/${PLAN_ID}`,
    target_branch: 'main',
    base_commit: baseCommit,
  };
}

async function addWorktree(repository: string): Promise<string> {
  const parent = await temporary('ai-workflow-audit-worktree-');
  const worktree = join(parent, 'worktree');
  await exec('git', ['worktree', 'add', worktree, '-b', `ai-workflow/${PLAN_ID}`], { cwd: repository, maxBuffer: 10 * 1024 * 1024 });
  return worktree;
}

describe('auditWorkspace', () => {
  it('reports a fresh workspace plan as valid, with checks and warnings, without writing', async () => {
    const { root } = await realWorkspaceFixture([
      { name: 'app', path: 'packages/app' },
      { name: 'lib', path: 'packages/lib' },
    ]);
    const directory = await workspacePlanFixture(root, baselineSpec());

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(true);
    expect(output.plan_id).toBe(PLAN_ID);
    expect(Array.isArray(output.checks)).toBe(true);
    expect(output.checks?.length ?? 0).toBeGreaterThan(0);
    expect((output.repositories ?? []).map((repository) => repository.name)).toEqual(expect.arrayContaining(['app', 'lib']));
    expect(expectStrings(output.blockers, 'blockers')).toEqual([]);
    const warnings = expectStrings(output.warnings, 'warnings');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toMatch(/worktree/i);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('reports valid: false with string blockers for a nonexistent plan directory', async () => {
    const root = await temporary('ai-workflow-audit-unit-missing-');
    const directory = join(root, '.ai-workflow/plans', '20260930-does-not-exist');

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(false);
    const blockers = expectStrings(output.blockers, 'blockers');
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join('\n')).toContain(directory);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('reports valid: false when the frozen plan_id does not match the directory name', async () => {
    const root = await temporary('ai-workflow-audit-unit-mismatch-');
    const directory = await workspacePlanFixture(root, baselineSpec());
    const renamed = join(root, '.ai-workflow/plans', '20260930-other-name');
    await rename(directory, renamed);

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(renamed));

    expect(output.valid).toBe(false);
    const blockers = expectStrings(output.blockers, 'blockers');
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join('\n')).toContain(PLAN_ID);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('blocks a recorded task checkpoint commit that does not exist, naming the repository and SHA', async () => {
    const { root, directory, app } = await buildWorkspace();
    await distributeSlices(directory);
    const head = await headOf(app);
    await writeRecord(app, {
      ...baseRecord(),
      status: 'completed',
      completed_at: COMPLETED_AT,
      commit: head,
      task_checkpoints: { 'task-001-app': { kind: 'commit', commit: MISSING_SHA } },
    });

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(false);
    const blockers = expectStrings(output.blockers, 'blockers');
    const text = blockers.join('\n');
    expect(text).toContain('app');
    expect(text).toContain(MISSING_SHA);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('accepts a no-change checkpoint whose recorded head exists', async () => {
    const { root, directory, app } = await buildWorkspace();
    await distributeSlices(directory);
    const head = await headOf(app);
    const worktree = await addWorktree(app);
    await writeRecord(app, {
      ...baseRecord(),
      execution: anchorOf(root, worktree, head),
      task_checkpoints: { 'task-001-app': { kind: 'no-change', head } },
    });

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(true);
    expect(expectStrings(output.blockers, 'blockers')).toEqual([]);
    expect((output.blockers ?? []).some((blocker) => blocker.includes(head))).toBe(false);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('blocks a completed record whose assigned tasks have no checkpoints, naming the repository', async () => {
    const { root, directory, app } = await buildWorkspace();
    await distributeSlices(directory);
    const head = await headOf(app);
    await writeRecord(app, {
      ...baseRecord(),
      status: 'completed',
      completed_at: COMPLETED_AT,
      commit: head,
    });

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(false);
    const text = expectStrings(output.blockers, 'blockers').join('\n');
    expect(text).toContain('app');
    expect(text).toMatch(/task|checkpoint|coverage/i);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('blocks an execution anchor naming a missing worktree, naming the path', async () => {
    const { root, directory, app } = await buildWorkspace();
    const head = await headOf(app);
    const missing = join(root, '.worktrees', 'missing-worktree');
    await writeRecord(app, { ...baseRecord(), execution: anchorOf(root, missing, head) });

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(false);
    expect(expectStrings(output.blockers, 'blockers').join('\n')).toContain(missing);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('blocks an execution anchor whose worktree has a different Git common directory', async () => {
    const { root, directory, app } = await buildWorkspace();
    const head = await headOf(app);
    const decoyParent = await temporary('ai-workflow-audit-decoy-');
    const decoy = join(decoyParent, 'app');
    await mkdir(decoy, { recursive: true });
    await gitInit(decoy);
    await writeRecord(app, { ...baseRecord(), execution: anchorOf(root, decoy, head) });

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(false);
    const text = expectStrings(output.blockers, 'blockers').join('\n');
    expect(text).toContain(decoy);
    expect(text).toMatch(/worktree|common|repository/i);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('accepts an execution anchor naming a real worktree of the source repository', async () => {
    const { root, directory, app } = await buildWorkspace();
    const head = await headOf(app);
    const worktree = await addWorktree(app);
    await writeRecord(app, { ...baseRecord(), execution: anchorOf(root, worktree, head) });

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(true);
    const blockers = expectStrings(output.blockers, 'blockers');
    expect(blockers.filter((blocker) => /worktree/i.test(blocker) || blocker.includes(worktree))).toEqual([]);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('warns about an unreferenced branch commit without blocking a valid record', async () => {
    const { root, directory, app } = await buildWorkspace();
    await distributeSlices(directory);
    const head = await headOf(app);
    const worktree = await addWorktree(app);
    await writeRecord(app, {
      ...baseRecord(),
      status: 'completed',
      completed_at: COMPLETED_AT,
      commit: head,
      execution: anchorOf(root, worktree, head),
      task_checkpoints: { 'task-001-app': { kind: 'commit', commit: head } },
    });
    const extra = await commitFile(worktree, 'src/extra.ts', 'export const extra = true;\n', 'unreferenced repair');

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(true);
    expect(expectStrings(output.blockers, 'blockers')).toEqual([]);
    const warnings = expectStrings(output.warnings, 'warnings');
    expect(warnings.some((warning) => warning.includes(extra) || /unreferenced/i.test(warning))).toBe(true);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('blocks a completed record whose distributed slice file is missing', async () => {
    const { root, directory, app } = await buildWorkspace();
    await distributeSlices(directory);
    const head = await headOf(app);
    await writeRecord(app, {
      ...baseRecord(),
      status: 'completed',
      completed_at: COMPLETED_AT,
      commit: head,
      task_checkpoints: { 'task-001-app': { kind: 'commit', commit: head } },
    });
    await rm(join(app, '.ai-workflow', 'plans', PLAN_ID, 'spec.md'));

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(false);
    const text = expectStrings(output.blockers, 'blockers').join('\n');
    expect(text).toContain('app');
    expect(text).toMatch(/spec\.md|slice|missing/i);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('blocks a completed record whose distributed slice file diverges', async () => {
    const { root, directory, app } = await buildWorkspace();
    await distributeSlices(directory);
    const head = await headOf(app);
    await writeRecord(app, {
      ...baseRecord(),
      status: 'completed',
      completed_at: COMPLETED_AT,
      commit: head,
      task_checkpoints: { 'task-001-app': { kind: 'commit', commit: head } },
    });
    await appendFile(join(app, '.ai-workflow', 'plans', PLAN_ID, 'spec.md'), '<!-- mutated -->\n');

    const before = await snapshotTree(root);
    const output = view(await auditWorkspace(directory));

    expect(output.valid).toBe(false);
    const text = expectStrings(output.blockers, 'blockers').join('\n');
    expect(text).toContain('app');
    expect(text).toMatch(/divergen|slice|spec\.md/i);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);
});
