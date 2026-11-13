import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { distributeWorkspace } from '../../src/workspace/distribute.js';
import { implementationRecordPath, writeWorkspaceRecord, type WorkspaceExecutionRecord } from '../../src/workspace/record.js';
import {
  changedPaths,
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

interface AuditRepository {
  name: string;
}
interface AuditOutput {
  valid: boolean;
  plan_id?: string;
  repositories?: AuditRepository[];
  checks?: unknown[];
  blockers?: string[];
  warnings?: string[];
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

async function startAudit(root: string, directory: string): Promise<{ before: Map<string, string>; result: CliResult }> {
  const before = await snapshotTree(root);
  const result = await runCli(['workspace', 'audit', '--plan', directory]);
  return { before, result };
}

function blockerText(output: AuditOutput): string {
  return (output.blockers ?? []).join('\n');
}

function warningText(output: AuditOutput): string {
  return (output.warnings ?? []).join('\n');
}

describe('workspace audit CLI', () => {
  it('rejects a nonexistent plan directory with a blocker naming the path and writes nothing', async () => {
    const root = await temporary('ai-workflow-audit-missing-');
    const directory = join(root, '.ai-workflow/plans', '20260930-does-not-exist');

    const { before, result } = await startAudit(root, directory);
    expect(result.code, outputOf(result)).toBe(1);
    const output = parseJson<AuditOutput>(result);

    expect(output.valid).toBe(false);
    expect((output.blockers ?? []).length).toBeGreaterThan(0);
    for (const blocker of output.blockers ?? []) expect(typeof blocker).toBe('string');
    expect(blockerText(output)).toContain(directory);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('rejects a directory outside <root>/.ai-workflow/plans/<planId> and writes nothing', async () => {
    const root = await temporary('ai-workflow-audit-outside-');
    const directory = join(root, 'plans', PLAN_ID);
    await mkdir(directory, { recursive: true });

    const { before, result } = await startAudit(root, directory);
    expect(result.code, outputOf(result)).toBe(1);
    const output = parseJson<AuditOutput>(result);

    expect(output.valid).toBe(false);
    expect((output.blockers ?? []).length).toBeGreaterThan(0);
    for (const blocker of output.blockers ?? []) expect(typeof blocker).toBe('string');
    expect(blockerText(output)).toContain(directory);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('rejects a plan directory whose frozen plan_id does not match its directory name', async () => {
    const root = await temporary('ai-workflow-audit-mismatch-');
    const directory = await workspacePlanFixture(root, baselineSpec());
    const renamed = join(root, '.ai-workflow/plans', '20260930-other-name');
    await rename(directory, renamed);

    const { before, result } = await startAudit(root, renamed);
    expect(result.code, outputOf(result)).toBe(1);
    const output = parseJson<AuditOutput>(result);

    expect(output.valid).toBe(false);
    expect((output.blockers ?? []).length).toBeGreaterThan(0);
    for (const blocker of output.blockers ?? []) expect(typeof blocker).toBe('string');
    expect(blockerText(output)).toContain(PLAN_ID);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('rejects a plan whose workspace manifest role is slice', async () => {
    const root = await temporary('ai-workflow-audit-slice-');
    const spec = baselineSpec();
    spec.manifest = {
      planId: PLAN_ID,
      role: 'slice',
      repositories: [{ ...APP_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] }],
    };
    const directory = await workspacePlanFixture(root, spec);

    const { before, result } = await startAudit(root, directory);
    expect(result.code, outputOf(result)).toBe(1);
    const output = parseJson<AuditOutput>(result);

    expect(output.valid).toBe(false);
    expect((output.blockers ?? []).length).toBeGreaterThan(0);
    for (const blocker of output.blockers ?? []) expect(typeof blocker).toBe('string');
    expect(blockerText(output)).toMatch(/slice/i);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('rejects a workspace plan whose workspace.yaml is missing and names workspace.yaml', async () => {
    const root = await temporary('ai-workflow-audit-no-manifest-');
    const spec = baselineSpec();
    delete spec.manifest;
    const directory = await workspacePlanFixture(root, spec);

    const { before, result } = await startAudit(root, directory);
    expect(result.code, outputOf(result)).toBe(1);
    const output = parseJson<AuditOutput>(result);

    expect(output.valid).toBe(false);
    expect((output.blockers ?? []).length).toBeGreaterThan(0);
    for (const blocker of output.blockers ?? []) expect(typeof blocker).toBe('string');
    expect(blockerText(output)).toMatch(/workspace\.yaml/);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('returns a valid read-only baseline and warns about the missing active worktree', async () => {
    const { root } = await realWorkspaceFixture([
      { name: 'app', path: 'packages/app' },
      { name: 'lib', path: 'packages/lib' },
    ]);
    const directory = await workspacePlanFixture(root, baselineSpec());

    const { before, result } = await startAudit(root, directory);
    expect(result.code, outputOf(result)).toBe(0);
    const output = parseJson<AuditOutput>(result);

    expect(output.valid).toBe(true);
    expect(output.plan_id).toBe(PLAN_ID);
    expect(Array.isArray(output.checks)).toBe(true);
    expect(output.checks?.length ?? 0).toBeGreaterThan(0);
    expect((output.repositories ?? []).map((repository) => repository.name)).toEqual(expect.arrayContaining(['app', 'lib']));
    expect(output.blockers ?? []).toEqual([]);
    expect(output.warnings?.length ?? 0).toBeGreaterThan(0);
    expect(warningText(output)).toMatch(/worktree/i);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('exits 1 with the exact missing-checkpoint blocker and writes nothing', async () => {
    const { root, directory, app } = await buildWorkspace();
    await distributeSlices(directory);
    const head = await headOf(app);
    await writeRecord(app, {
      plan_id: PLAN_ID,
      status: 'completed',
      started_at: STARTED_AT,
      completed_at: COMPLETED_AT,
      commit: head,
      task_checkpoints: { 'task-001-app': { kind: 'commit', commit: MISSING_SHA } },
    });

    const { before, result } = await startAudit(root, directory);
    expect(result.code, outputOf(result)).toBe(1);
    const output = parseJson<AuditOutput>(result);

    expect(output.valid).toBe(false);
    const blockers = output.blockers ?? [];
    for (const blocker of blockers) expect(typeof blocker).toBe('string');
    expect(blockerText(output)).toContain('app');
    expect(blockerText(output)).toContain(MISSING_SHA);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('exits 0 for a valid no-change checkpoint and writes nothing', async () => {
    const { root, directory, app } = await buildWorkspace();
    await distributeSlices(directory);
    const head = await headOf(app);
    await writeRecord(app, {
      plan_id: PLAN_ID,
      status: 'completed',
      started_at: STARTED_AT,
      completed_at: COMPLETED_AT,
      commit: head,
      task_checkpoints: { 'task-001-app': { kind: 'no-change', head } },
    });

    const { before, result } = await startAudit(root, directory);
    expect(result.code, outputOf(result)).toBe(0);
    const output = parseJson<AuditOutput>(result);

    expect(output.valid).toBe(true);
    expect(output.blockers ?? []).toEqual([]);
    expect((output.blockers ?? []).some((blocker) => blocker.includes(head))).toBe(false);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);
});
