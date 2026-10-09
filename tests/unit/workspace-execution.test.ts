import { describe, expect, it } from 'vitest';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { resolveWorkspacePlan, type ResolvedWorkspacePlan } from '../../src/workspace/distribute.js';
import { projectWorkspaceExecution } from '../../src/workspace/execution.js';
import { temporary, workspacePlanFixture, type WorkspacePlanFixtureSpec, type WorkspaceTaskFixture } from '../helpers.js';

// Public boundary: the read-only `projectWorkspaceExecution` projection over a resolved
// workspace plan and the records on disk. The fixture is the required A1,B1 / B2 / C1
// parent schedule so the projection must use the ORIGINAL parent phase indices even when a
// child slice would omit empty phases (app/core have one phase, beta has two).

const PLAN_ID = '20260930-workspace-execution';
const STARTED_AT = '2026-09-30T10:00:00+08:00';
const COMPLETED_AT = '2026-09-30T11:00:00+08:00';

const SHA_BASE = 'a'.repeat(40);
const SHA_A = 'b'.repeat(40);
const SHA_B1 = 'c'.repeat(40);
const SHA_B2 = 'd'.repeat(40);
const SHA_C = 'e'.repeat(40);
const SHA_APP_DELIVERY = 'f'.repeat(40);
const SHA_ROOT_FINAL = '0'.repeat(40);

function executionSpec(withRootTask = false): WorkspacePlanFixtureSpec {
  const tasks: WorkspaceTaskFixture[] = [];
  if (withRootTask) {
    tasks.push({ id: 'task-000-root', repo: 'workspace', requirements: ['REQ-000'], acceptanceCriteria: ['AC-000'], writeScope: ['src/root.ts'] });
  }
  tasks.push(
    { id: 'task-001-a1', repo: 'app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/a1.ts'] },
    { id: 'task-002-b1', repo: 'beta', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/b1.ts'] },
    { id: 'task-003-b2', repo: 'beta', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], dependsOn: ['task-002-b1'], writeScope: ['src/b2.ts'] },
    { id: 'task-004-c1', repo: 'core', requirements: ['REQ-004'], acceptanceCriteria: ['AC-004'], writeScope: ['src/c1.ts'] },
  );
  return {
    planId: PLAN_ID,
    requirements: withRootTask ? ['REQ-000', 'REQ-001', 'REQ-002', 'REQ-003', 'REQ-004'] : ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004'],
    acceptanceCriteria: withRootTask ? ['AC-000', 'AC-001', 'AC-002', 'AC-003', 'AC-004'] : ['AC-001', 'AC-002', 'AC-003', 'AC-004'],
    workspaceRepos: [
      { name: 'workspace', path: '.', dependsOn: [] },
      { name: 'app', path: 'packages/app', dependsOn: [] },
      { name: 'beta', path: 'packages/beta', dependsOn: [] },
      { name: 'core', path: 'packages/core', dependsOn: ['app', 'beta'] },
    ],
    tasks,
    phases: [withRootTask ? ['task-000-root', 'task-001-a1', 'task-002-b1'] : ['task-001-a1', 'task-002-b1'], ['task-003-b2'], ['task-004-c1']],
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { name: 'workspace', path: '.', dependsOn: [], requirements: withRootTask ? ['REQ-000'] : [], acceptanceCriteria: withRootTask ? ['AC-000'] : [] },
        { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { name: 'beta', path: 'packages/beta', dependsOn: [], requirements: ['REQ-002', 'REQ-003'], acceptanceCriteria: ['AC-002', 'AC-003'] },
        { name: 'core', path: 'packages/core', dependsOn: ['app', 'beta'], requirements: ['REQ-004'], acceptanceCriteria: ['AC-004'] },
      ],
    },
  };
}

interface Fixture { root: string; planDirectory: string; resolved: ResolvedWorkspacePlan }

async function build(withRootTask = false): Promise<Fixture> {
  const root = await temporary('ai-workflow-execution-');
  const planDirectory = await workspacePlanFixture(root, executionSpec(withRootTask));
  for (const repositoryPath of ['packages/app', 'packages/beta', 'packages/core']) await mkdir(join(root, repositoryPath), { recursive: true });
  const resolved = await resolveWorkspacePlan(planDirectory);
  return { root, planDirectory, resolved };
}

function anchor(root: string, repository: string): Record<string, unknown> {
  return {
    purpose: 'tasks',
    source_root: root,
    repository,
    worktree: join(root, '.worktrees', PLAN_ID),
    branch: `ai-workflow/${PLAN_ID}`,
    target_branch: 'main',
    base_commit: SHA_BASE,
  };
}

function record(root: string, repository: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { plan_id: PLAN_ID, status: 'in-progress', started_at: STARTED_AT, execution: anchor(root, repository), ...extra };
}

async function writeChildRecord(fixture: Fixture, repositoryPath: string, repository: string, extra: Record<string, unknown>): Promise<string> {
  const directory = join(fixture.root, repositoryPath, '.ai-workflow', 'plans', PLAN_ID);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'implementation.yaml');
  await writeFile(path, stringifyYaml(record(fixture.root, repository, extra)));
  return path;
}

async function writeRootRecord(fixture: Fixture, extra: Record<string, unknown>): Promise<string> {
  const directory = join(fixture.root, '.ai-workflow', 'plans', PLAN_ID);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'implementation.yaml');
  await writeFile(path, stringifyYaml(record(fixture.root, 'workspace', extra)));
  return path;
}

async function expectSamePath(actual: string, expected: string): Promise<void> {
  const resolved = await realpath(expected).catch(() => expected);
  expect([expected, resolved]).toContain(actual);
}

const checkpoint = (commit: string) => ({ kind: 'commit' as const, commit });

describe('projectWorkspaceExecution', () => {
  it('reports the first parent phase, its pending tasks and no barrier for a fresh workspace', async () => {
    const fixture = await build();

    const projection = await projectWorkspaceExecution(fixture.resolved);

    expect(projection.phase).toBe(1);
    expect(projection.pending_tasks.map((task) => [task.task, task.repo])).toEqual([
      ['task-001-a1', 'app'],
      ['task-002-b1', 'beta'],
    ]);
    await expectSamePath(projection.pending_tasks[0]!.repository_path, join(fixture.root, 'packages/app'));
    await expectSamePath(projection.pending_tasks[0]!.plan_path, join(fixture.root, 'packages/app', '.ai-workflow', 'plans', PLAN_ID));
    await expectSamePath(projection.pending_tasks[1]!.repository_path, join(fixture.root, 'packages/beta'));
    expect(projection.awaiting_delivery).toEqual([]);
    expect(projection.blockers).toEqual([]);
    expect(projection.completed).toBe(false);
  });

  it('advances phases as checkpoints accumulate and raises the delivery barrier before later phases', async () => {
    const fixture = await build();
    await writeChildRecord(fixture, 'packages/app', 'app', { task_checkpoints: { 'task-001-a1': checkpoint(SHA_A) } });
    await writeChildRecord(fixture, 'packages/beta', 'beta', { task_checkpoints: { 'task-002-b1': checkpoint(SHA_B1) } });

    const afterPhaseOne = await projectWorkspaceExecution(fixture.resolved);
    expect(afterPhaseOne.phase).toBe(2);
    expect(afterPhaseOne.pending_tasks.map((task) => task.task)).toEqual(['task-003-b2']);
    expect(afterPhaseOne.awaiting_delivery).toEqual(['app']);

    await writeChildRecord(fixture, 'packages/beta', 'beta', {
      task_checkpoints: { 'task-002-b1': checkpoint(SHA_B1), 'task-003-b2': { kind: 'no-change', head: SHA_B2 } },
    });
    const afterPhaseTwo = await projectWorkspaceExecution(fixture.resolved);
    expect(afterPhaseTwo.phase).toBe(3);
    expect(afterPhaseTwo.pending_tasks.map((task) => task.task)).toEqual(['task-004-c1']);
    expect(afterPhaseTwo.awaiting_delivery).toEqual(['app', 'beta']);
  });

  it('clears the barrier when a child is delivered and keeps the next phase pending', async () => {
    const fixture = await build();
    await writeChildRecord(fixture, 'packages/app', 'app', {
      status: 'completed',
      completed_at: COMPLETED_AT,
      commit: SHA_APP_DELIVERY,
      task_checkpoints: { 'task-001-a1': checkpoint(SHA_A) },
    });
    await writeChildRecord(fixture, 'packages/beta', 'beta', { task_checkpoints: { 'task-002-b1': checkpoint(SHA_B1) } });

    const projection = await projectWorkspaceExecution(fixture.resolved);

    expect(projection.phase).toBe(2);
    expect(projection.pending_tasks.map((task) => task.task)).toEqual(['task-003-b2']);
    expect(projection.awaiting_delivery).toEqual([]);
    expect(projection.completed).toBe(false);
  });

  it('marks the workspace completed only when the reserved root record is completed', async () => {
    const fixture = await build();
    await writeChildRecord(fixture, 'packages/app', 'app', { status: 'completed', completed_at: COMPLETED_AT, commit: SHA_APP_DELIVERY, task_checkpoints: { 'task-001-a1': checkpoint(SHA_A) } });
    await writeChildRecord(fixture, 'packages/beta', 'beta', { status: 'completed', completed_at: COMPLETED_AT, commit: SHA_B2, task_checkpoints: { 'task-002-b1': checkpoint(SHA_B1), 'task-003-b2': { kind: 'no-change', head: SHA_B2 } } });
    await writeChildRecord(fixture, 'packages/core', 'core', { status: 'completed', completed_at: COMPLETED_AT, commit: SHA_C, task_checkpoints: { 'task-004-c1': checkpoint(SHA_C) } });

    const before = await projectWorkspaceExecution(fixture.resolved);
    expect(before.phase).toBeNull();
    expect(before.pending_tasks).toEqual([]);
    expect(before.awaiting_delivery).toEqual([]);
    expect(before.completed).toBe(false);

    await writeRootRecord(fixture, { status: 'completed', completed_at: COMPLETED_AT, commit: SHA_ROOT_FINAL });

    const after = await projectWorkspaceExecution(fixture.resolved);
    expect(after.completed).toBe(true);
    expect(after.phase).toBeNull();
    expect(after.pending_tasks).toEqual([]);
  });

  it('treats a present-but-invalid record as a blocker rather than fresh or missing', async () => {
    const fixture = await build();
    const directory = join(fixture.root, 'packages/app', '.ai-workflow', 'plans', PLAN_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'implementation.yaml'), stringifyYaml({ plan_id: '20260101-other', status: 'in-progress', started_at: STARTED_AT }));

    const projection = await projectWorkspaceExecution(fixture.resolved);

    expect(projection.blockers.join('\n')).toContain('20260101-other');
  });

  it('blocks a checkpoint recorded for a later parent phase while an earlier phase is pending', async () => {
    const fixture = await build();
    await writeChildRecord(fixture, 'packages/core', 'core', { task_checkpoints: { 'task-004-c1': checkpoint(SHA_C) } });

    const projection = await projectWorkspaceExecution(fixture.resolved);

    expect(projection.phase).toBe(1);
    expect(projection.blockers.join('\n')).toContain('task-004-c1');
  });

  it('blocks a checkpoint for a task outside the repository slice', async () => {
    const fixture = await build();
    await writeChildRecord(fixture, 'packages/app', 'app', { task_checkpoints: { 'task-002-b1': checkpoint(SHA_B1) } });

    const projection = await projectWorkspaceExecution(fixture.resolved);

    expect(projection.blockers.join('\n')).toContain('task-002-b1');
  });

  it('counts a structurally valid legacy completed record as a repository delivery', async () => {
    const fixture = await build();
    const directory = join(fixture.root, 'packages/app', '.ai-workflow', 'plans', PLAN_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'implementation.yaml'), stringifyYaml({ plan_id: PLAN_ID, status: 'completed', started_at: STARTED_AT, completed_at: COMPLETED_AT, commit: SHA_APP_DELIVERY }));
    await writeChildRecord(fixture, 'packages/beta', 'beta', { task_checkpoints: { 'task-002-b1': checkpoint(SHA_B1) } });

    const projection = await projectWorkspaceExecution(fixture.resolved);

    expect(projection.phase).toBe(2);
    expect(projection.pending_tasks.map((task) => task.task)).toEqual(['task-003-b2']);
    expect(projection.awaiting_delivery).toEqual([]);
  });

  it('blocks a legacy in-progress record without execution anchors', async () => {
    const fixture = await build();
    const directory = join(fixture.root, 'packages/app', '.ai-workflow', 'plans', PLAN_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'implementation.yaml'), stringifyYaml({ plan_id: PLAN_ID, status: 'in-progress', started_at: STARTED_AT }));

    const projection = await projectWorkspaceExecution(fixture.resolved);

    expect(projection.blockers.join('\n')).toContain('app');
  });

  it('lists the reserved workspace root as awaiting delivery when its prefix task is done but not delivered', async () => {
    const fixture = await build(true);
    await writeRootRecord(fixture, { task_checkpoints: { 'task-000-root': checkpoint(SHA_A) } });
    await writeChildRecord(fixture, 'packages/app', 'app', { task_checkpoints: { 'task-001-a1': checkpoint(SHA_A) } });
    await writeChildRecord(fixture, 'packages/beta', 'beta', { task_checkpoints: { 'task-002-b1': checkpoint(SHA_B1) } });

    const projection = await projectWorkspaceExecution(fixture.resolved);

    expect(projection.awaiting_delivery).toEqual(['workspace', 'app']);
  });
});
