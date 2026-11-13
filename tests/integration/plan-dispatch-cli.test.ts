import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import { changedPaths, snapshotTree, temporary, workspacePlanFixture, type WorkspaceManifestFixture, type WorkspacePlanFixtureSpec, type WorkspaceTaskFixture } from '../helpers.js';

// CLI boundary: `ai-workflow plan dispatch` prints the selected phase's structured task
// packets (and, with `--verbose`, the text skeleton) or exits nonzero with a reason and no
// packet. Observable = exit code, stdout structure/text and stderr reason only.

const exec = promisify(execFile);
const TIMEOUT = 90_000;
const ORDINARY_PLAN_ID = '20261113-dispatch-cli';
const STARTED_AT = '2026-11-13T10:00:00+08:00';
const COMPLETED_AT = '2026-11-13T11:00:00+08:00';
const DELIVERY_SHA = 'a'.repeat(40);
const PHASE_ONE = ['task-001-backend', 'task-002-frontend', 'task-003-test', 'task-004-research', 'task-005-docs', 'task-006-documentation'];

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

interface DispatchTask {
  id: string;
  repository: string;
  surface: string;
  roles: string[];
  requirements: string[];
  acceptance_criteria: string[];
  read_scope: string[];
  write_scope: string[];
  test_commands: string[];
  plan_path: string;
  repository_path: string;
  reports_path: string;
  task_anchor: string;
  plan_anchor: string;
}

interface DispatchOutput {
  plan_id: string;
  phase: number;
  tasks: DispatchTask[];
  packet?: string;
}

function parseOutput(result: CliResult): DispatchOutput {
  expect(result.code, outputOf(result)).toBe(0);
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as DispatchOutput;
}

function expectRefused(result: CliResult, reason: RegExp): void {
  expect(result.code, outputOf(result)).not.toBe(0);
  expect(result.stdout.trim(), 'no packet on refusal').toBe('');
  expect(result.stderr).toMatch(reason);
}

function taskIds(output: DispatchOutput): string[] {
  return output.tasks.map((task) => task.id);
}

const ROLE_BY_SURFACE: Record<string, string[]> = {
  backend: ['Backend Developer'],
  frontend: ['Frontend Developer'],
  'cross-stack': ['Backend Developer', 'Frontend Developer'],
  research: ['Researcher'],
  documentation: ['Documentation Maintainer'],
  test: ['Test'],
  docs: ['Documentation Maintainer'],
};

function ordinaryTasks(): WorkspaceTaskFixture[] {
  return [
    { id: 'task-001-backend', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], surface: 'backend', readScope: ['MEMORY.md', 'src/input.ts'], writeScope: ['src/backend.ts'] },
    { id: 'task-002-frontend', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], surface: 'frontend', writeScope: ['src/frontend.ts'] },
    { id: 'task-003-test', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], surface: 'test', writeScope: ['src/test.ts'] },
    { id: 'task-004-research', requirements: ['REQ-004'], acceptanceCriteria: ['AC-004'], surface: 'research', writeScope: ['src/research.ts'] },
    { id: 'task-005-docs', requirements: ['REQ-005'], acceptanceCriteria: ['AC-005'], surface: 'docs', writeScope: ['src/docs.ts'] },
    { id: 'task-006-documentation', requirements: ['REQ-006'], acceptanceCriteria: ['AC-006'], surface: 'documentation', writeScope: ['src/documentation.ts'] },
    { id: 'task-007-cross', requirements: ['REQ-007'], acceptanceCriteria: ['AC-007'], surface: 'cross-stack', writeScope: ['src/cross.ts'] },
  ];
}

function ordinarySpec(tasks = ordinaryTasks()): WorkspacePlanFixtureSpec {
  return {
    planId: ORDINARY_PLAN_ID,
    requirements: Array.from({ length: 7 }, (_, index) => `REQ-00${index + 1}`),
    acceptanceCriteria: Array.from({ length: 7 }, (_, index) => `AC-00${index + 1}`),
    tasks,
    phases: [PHASE_ONE, ['task-007-cross']],
  };
}

function workspaceSpec(planId: string, manifest?: WorkspaceManifestFixture): WorkspacePlanFixtureSpec {
  return {
    planId,
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    workspaceRepos: [
      { name: 'workspace', path: '.', dependsOn: [] },
      { name: 'app', path: 'packages/app', dependsOn: [] },
      { name: 'lib', path: 'packages/lib', dependsOn: ['app'] },
    ],
    tasks: [
      { id: 'task-001-app', repo: 'app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], surface: 'backend', writeScope: ['src/app.ts'] },
      { id: 'task-002-lib', repo: 'lib', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], surface: 'frontend', writeScope: ['src/lib.ts'] },
    ],
    phases: [['task-001-app'], ['task-002-lib']],
    ...(manifest === undefined ? {} : { manifest }),
  };
}

function validManifest(planId: string): WorkspaceManifestFixture {
  return {
    planId,
    role: 'workspace',
    repositories: [
      { name: 'workspace', path: '.', dependsOn: [], requirements: [], acceptanceCriteria: [] },
      { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
      { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
    ],
  };
}

interface Fixture { root: string; directory: string }

async function buildOrdinary(tasks = ordinaryTasks()): Promise<Fixture> {
  const root = await temporary('ai-workflow-plan-dispatch-cli-');
  return { root, directory: await workspacePlanFixture(root, ordinarySpec(tasks)) };
}

async function buildWorkspace(planId: string, manifest?: WorkspaceManifestFixture): Promise<Fixture> {
  const root = await temporary('ai-workflow-plan-dispatch-workspace-');
  return { root, directory: await workspacePlanFixture(root, workspaceSpec(planId, manifest)) };
}

async function writeCompletedRecord(slicePlanDirectory: string, planId: string): Promise<void> {
  await mkdir(slicePlanDirectory, { recursive: true });
  await writeFile(join(slicePlanDirectory, 'implementation.yaml'), stringifyYaml({ plan_id: planId, status: 'completed', started_at: STARTED_AT, completed_at: COMPLETED_AT, commit: DELIVERY_SHA }));
}

function expectAnchor(actual: string, root: string, resolvedRoot: string, relative: string): void {
  expect(isAbsolute(actual)).toBe(true);
  expect([join(root, relative), join(resolvedRoot, relative)]).toContain(actual);
}

describe('plan dispatch CLI', () => {
  it('prints the complete current-phase packets and omits the future phase', async () => {
    const { root, directory } = await buildOrdinary();
    const resolvedRoot = await realpath(root);
    const before = await snapshotTree(root);

    const output = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory]));

    expect(output.plan_id).toBe(ORDINARY_PLAN_ID);
    expect(output.phase).toBe(1);
    expect(taskIds(output)).toEqual(PHASE_ONE);
    expect(taskIds(output)).not.toContain('task-007-cross');
    const backend = output.tasks.find((task) => task.id === 'task-001-backend');
    expect(backend).toBeDefined();
    expect(backend?.repository).toBe('');
    expect(backend?.surface).toBe('backend');
    expect(backend?.roles).toEqual(['Backend Developer']);
    expect(backend?.requirements).toEqual(['REQ-001']);
    expect(backend?.acceptance_criteria).toEqual(['AC-001']);
    expect(backend?.read_scope).toEqual(['MEMORY.md', 'src/input.ts']);
    expect(backend?.write_scope).toEqual(['src/backend.ts']);
    expect(backend?.test_commands).toEqual(['pnpm test']);
    expectAnchor(backend?.plan_path ?? '', root, resolvedRoot, `.ai-workflow/plans/${ORDINARY_PLAN_ID}`);
    expectAnchor(backend?.repository_path ?? '', root, resolvedRoot, '.');
    expectAnchor(backend?.reports_path ?? '', root, resolvedRoot, `.ai-workflow/plans/${ORDINARY_PLAN_ID}/reports`);
    expectAnchor(backend?.task_anchor ?? '', root, resolvedRoot, `.ai-workflow/plans/${ORDINARY_PLAN_ID}/tasks/task-001-backend.md`);
    expectAnchor(backend?.plan_anchor ?? '', root, resolvedRoot, `.ai-workflow/plans/${ORDINARY_PLAN_ID}/plan.md`);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('maps all seven surfaces to their ordered roles', async () => {
    const { directory } = await buildOrdinary();
    const first = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory]));
    const second = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory, '--phase', '2']));

    const emitted = [...first.tasks, ...second.tasks];
    expect(emitted).toHaveLength(7);
    for (const task of emitted) expect(task.roles).toEqual(ROLE_BY_SURFACE[task.surface]);
    expect(second.tasks[0]?.roles).toEqual(['Backend Developer', 'Frontend Developer']);
  }, TIMEOUT);

  it('selects exactly the requested phase and exactly one task', async () => {
    const { directory } = await buildOrdinary();

    const phase = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory, '--phase', '2']));
    expect(phase.phase).toBe(2);
    expect(taskIds(phase)).toEqual(['task-007-cross']);

    const task = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory, '--task', 'task-002-frontend']));
    expect(taskIds(task)).toEqual(['task-002-frontend']);
  }, TIMEOUT);

  it('refuses a task outside the selected phase', async () => {
    const { directory } = await buildOrdinary();

    expectRefused(await runCli(['plan', 'dispatch', '--plan', directory, '--task', 'task-007-cross']), /task-007-cross.*phase|phase.*task-007-cross/i);
  }, TIMEOUT);

  it('includes the text skeleton only with --verbose', async () => {
    const { root, directory } = await buildOrdinary();
    const resolvedRoot = await realpath(root);
    const before = await snapshotTree(root);

    const plain = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory]));
    const verbose = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory, '--verbose']));

    expect(plain.packet).toBeUndefined();
    const skeleton = verbose.packet ?? '';
    expect(skeleton).toContain('task-001-backend');
    for (const relative of [`.ai-workflow/plans/${ORDINARY_PLAN_ID}`, `.ai-workflow/plans/${ORDINARY_PLAN_ID}/tasks/task-001-backend.md`, '.', `.ai-workflow/plans/${ORDINARY_PLAN_ID}/reports`]) {
      const variants = [join(root, relative), join(resolvedRoot, relative)];
      expect(variants.some((variant) => skeleton.includes(variant)), `skeleton contains ${relative}`).toBe(true);
    }
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('refuses a plan without task documents with no prose-step fallback', async () => {
    const { directory } = await buildOrdinary([]);

    expectRefused(await runCli(['plan', 'dispatch', '--plan', directory]), /no task documents/i);
  }, TIMEOUT);

  it('refuses an unknown phase and an unknown task', async () => {
    const { directory } = await buildOrdinary();

    expectRefused(await runCli(['plan', 'dispatch', '--plan', directory, '--phase', '99']), /99/);
    expectRefused(await runCli(['plan', 'dispatch', '--plan', directory, '--task', 'task-999-missing']), /task-999-missing/);
  }, TIMEOUT);

  it('uses the workspace status execution phase and honors an explicit phase', async () => {
    const planId = '20261113-dispatch-cli-workspace';
    const { root, directory } = await buildWorkspace(planId, validManifest(planId));
    const resolvedRoot = await realpath(root);
    await writeCompletedRecord(join(root, 'packages/app/.ai-workflow/plans', planId), planId);

    const current = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory]));
    expect(current.phase).toBe(2);
    expect(taskIds(current)).toEqual(['task-002-lib']);
    expect(current.tasks[0]?.repository).toBe('lib');
    expectAnchor(current.tasks[0]?.repository_path ?? '', root, resolvedRoot, 'packages/lib');
    expectAnchor(current.tasks[0]?.plan_path ?? '', root, resolvedRoot, `packages/lib/.ai-workflow/plans/${planId}`);
    expectAnchor(current.tasks[0]?.reports_path ?? '', root, resolvedRoot, `packages/lib/.ai-workflow/plans/${planId}/reports`);
    expectAnchor(current.tasks[0]?.task_anchor ?? '', root, resolvedRoot, `.ai-workflow/plans/${planId}/tasks/task-002-lib.md`);
    expectAnchor(current.tasks[0]?.plan_anchor ?? '', root, resolvedRoot, `.ai-workflow/plans/${planId}/plan.md`);

    const explicit = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory, '--phase', '1']));
    expect(explicit.phase).toBe(1);
    expect(taskIds(explicit)).toEqual(['task-001-app']);
  }, TIMEOUT);

  it('refuses a workspace plan with a missing manifest or an invalid status', async () => {
    const missing = await buildWorkspace('20261113-dispatch-cli-no-manifest');
    expectRefused(await runCli(['plan', 'dispatch', '--plan', missing.directory]), /workspace\.yaml|manifest/i);

    const planId = '20261113-dispatch-cli-invalid-status';
    const invalid = await buildWorkspace(planId, { ...validManifest(planId), planId: '20260101-other' });
    expectRefused(await runCli(['plan', 'dispatch', '--plan', invalid.directory]), /plan_id mismatch|workspace status/i);
  }, TIMEOUT);

  it('refuses a completed workspace plan with no pending phase when --phase is absent', async () => {
    const planId = '20261113-dispatch-cli-completed';
    const { root, directory } = await buildWorkspace(planId, validManifest(planId));
    await writeCompletedRecord(join(root, 'packages/app/.ai-workflow/plans', planId), planId);
    await writeCompletedRecord(join(root, '.ai-workflow/plans', planId), planId);

    expectRefused(await runCli(['plan', 'dispatch', '--plan', directory]), /no pending phase|pending phase/i);
    const explicit = parseOutput(await runCli(['plan', 'dispatch', '--plan', directory, '--phase', '1']));
    expect(taskIds(explicit)).toEqual(['task-001-app']);
  }, TIMEOUT);
});
