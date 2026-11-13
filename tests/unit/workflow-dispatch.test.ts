import { describe, expect, it } from 'vitest';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { planDispatch } from '../../src/workflow/dispatch.js';
import { temporary, workspacePlanFixture, type WorkspaceManifestFixture, type WorkspacePlanFixtureSpec, type WorkspaceTaskFixture } from '../helpers.js';

// Behavior boundary: the read-only `planDispatch` packet assembly over a frozen plan,
// its task documents, its frozen schedule and, for workspace plans, `workspace status`.
// Observable = the selected phase's typed task packets and the refusal reason. The CLI
// is the stable public boundary covered by the integration test.

interface DispatchRequest {
  planDirectory: string;
  phase?: number;
  task?: string;
  verbose?: boolean;
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

interface DispatchResult {
  plan_id: string;
  phase: number;
  tasks: DispatchTask[];
  packet?: string;
}

const dispatch = planDispatch as unknown as (request: DispatchRequest) => Promise<DispatchResult>;

const ORDINARY_PLAN_ID = '20261113-dispatch-ordinary';
const STARTED_AT = '2026-11-13T10:00:00+08:00';
const COMPLETED_AT = '2026-11-13T11:00:00+08:00';
const DELIVERY_SHA = 'a'.repeat(40);
const PHASE_ONE = ['task-001-backend', 'task-002-frontend', 'task-003-test', 'task-004-research', 'task-005-docs', 'task-006-documentation'];

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

async function writeCompletedRecord(slicePlanDirectory: string, planId: string): Promise<void> {
  await mkdir(slicePlanDirectory, { recursive: true });
  await writeFile(join(slicePlanDirectory, 'implementation.yaml'), stringifyYaml({ plan_id: planId, status: 'completed', started_at: STARTED_AT, completed_at: COMPLETED_AT, commit: DELIVERY_SHA }));
}

interface Fixture { root: string; planDirectory: string }

async function buildOrdinary(tasks = ordinaryTasks()): Promise<Fixture> {
  const root = await temporary('ai-workflow-dispatch-');
  return { root, planDirectory: await workspacePlanFixture(root, ordinarySpec(tasks)) };
}

async function buildWorkspace(planId: string, manifest: WorkspaceManifestFixture = validManifest(planId)): Promise<Fixture> {
  const root = await temporary('ai-workflow-dispatch-workspace-');
  return { root, planDirectory: await workspacePlanFixture(root, workspaceSpec(planId, manifest)) };
}

interface AnchorContext { root: string; resolvedRoot: string }

async function anchorContext(root: string): Promise<AnchorContext> {
  return { root, resolvedRoot: await realpath(root) };
}

function expectAnchor(actual: string, context: AnchorContext, relative: string): void {
  expect(isAbsolute(actual)).toBe(true);
  expect([join(context.root, relative), join(context.resolvedRoot, relative)]).toContain(actual);
}

function taskIds(result: DispatchResult): string[] {
  return result.tasks.map((task) => task.id);
}

describe('planDispatch', () => {
  it('emits the complete phase-1 packet fields for an ordinary split plan and omits the future phase', async () => {
    const { root, planDirectory } = await buildOrdinary();
    const anchors = await anchorContext(root);

    const result = await dispatch({ planDirectory });

    expect(result.plan_id).toBe(ORDINARY_PLAN_ID);
    expect(result.phase).toBe(1);
    expect(taskIds(result)).toEqual(PHASE_ONE);
    expect(taskIds(result)).not.toContain('task-007-cross');
    const backend = result.tasks.find((task) => task.id === 'task-001-backend');
    expect(backend).toBeDefined();
    expect(backend?.repository).toBe('');
    expect(backend?.surface).toBe('backend');
    expect(backend?.roles).toEqual(['Backend Developer']);
    expect(backend?.requirements).toEqual(['REQ-001']);
    expect(backend?.acceptance_criteria).toEqual(['AC-001']);
    expect(backend?.read_scope).toEqual(['MEMORY.md', 'src/input.ts']);
    expect(backend?.write_scope).toEqual(['src/backend.ts']);
    expect(backend?.test_commands).toEqual(['pnpm test']);
    expectAnchor(backend?.plan_path ?? '', anchors, `.ai-workflow/plans/${ORDINARY_PLAN_ID}`);
    expectAnchor(backend?.repository_path ?? '', anchors, '.');
    expectAnchor(backend?.reports_path ?? '', anchors, `.ai-workflow/plans/${ORDINARY_PLAN_ID}/reports`);
    expectAnchor(backend?.task_anchor ?? '', anchors, `.ai-workflow/plans/${ORDINARY_PLAN_ID}/tasks/task-001-backend.md`);
    expectAnchor(backend?.plan_anchor ?? '', anchors, `.ai-workflow/plans/${ORDINARY_PLAN_ID}/plan.md`);
  });

  it('maps every supported surface to its ordered role list', async () => {
    const { planDirectory } = await buildOrdinary();

    const first = await dispatch({ planDirectory });
    const second = await dispatch({ planDirectory, phase: 2 });
    const emitted = [...first.tasks, ...second.tasks];

    expect(emitted).toHaveLength(7);
    for (const task of emitted) expect(task.roles).toEqual(ROLE_BY_SURFACE[task.surface]);
    expect(second.tasks[0]?.roles).toEqual(['Backend Developer', 'Frontend Developer']);
  });

  it('selects exactly the requested phase', async () => {
    const { planDirectory } = await buildOrdinary();

    const result = await dispatch({ planDirectory, phase: 2 });

    expect(result.phase).toBe(2);
    expect(taskIds(result)).toEqual(['task-007-cross']);
  });

  it('selects exactly one task with --task', async () => {
    const { planDirectory } = await buildOrdinary();

    const result = await dispatch({ planDirectory, task: 'task-002-frontend' });

    expect(taskIds(result)).toEqual(['task-002-frontend']);
  });

  it('refuses a task that is outside the selected phase', async () => {
    const { planDirectory } = await buildOrdinary();

    await expect(dispatch({ planDirectory, task: 'task-007-cross' })).rejects.toThrow(/task-007-cross.*phase|phase.*task-007-cross/i);
  });

  it('adds the packet skeleton only in verbose mode', async () => {
    const { root, planDirectory } = await buildOrdinary();
    const anchors = await anchorContext(root);

    const plain = await dispatch({ planDirectory });
    const verbose = await dispatch({ planDirectory, verbose: true });

    expect(plain.packet).toBeUndefined();
    const skeleton = verbose.packet ?? '';
    expect(skeleton).toContain('task-001-backend');
    const relativeAnchors = [
      `.ai-workflow/plans/${ORDINARY_PLAN_ID}`,
      `.ai-workflow/plans/${ORDINARY_PLAN_ID}/tasks/task-001-backend.md`,
      '.',
      `.ai-workflow/plans/${ORDINARY_PLAN_ID}/reports`,
    ];
    for (const relative of relativeAnchors) {
      const variants = [join(anchors.root, relative), join(anchors.resolvedRoot, relative)];
      expect(variants.some((variant) => skeleton.includes(variant)), `skeleton contains ${relative}`).toBe(true);
    }
  });

  it('refuses a plan without task documents instead of falling back to prose steps', async () => {
    const { planDirectory } = await buildOrdinary([]);

    await expect(dispatch({ planDirectory })).rejects.toThrow(/no task documents/i);
  });

  it('refuses an unknown phase and an unknown task', async () => {
    const { planDirectory } = await buildOrdinary();

    await expect(dispatch({ planDirectory, phase: 99 })).rejects.toThrow(/99/);
    await expect(dispatch({ planDirectory, task: 'task-999-missing' })).rejects.toThrow(/task-999-missing/);
  });

  it('uses the non-null workspace execution phase without --phase and honors an explicit phase', async () => {
    const planId = '20261113-dispatch-workspace';
    const { root, planDirectory } = await buildWorkspace(planId);
    await writeCompletedRecord(join(root, 'packages/app/.ai-workflow/plans', planId), planId);
    const anchors = await anchorContext(root);

    const current = await dispatch({ planDirectory });
    const explicit = await dispatch({ planDirectory, phase: 1 });

    expect(current.phase).toBe(2);
    expect(taskIds(current)).toEqual(['task-002-lib']);
    expect(current.tasks[0]?.repository).toBe('lib');
    expectAnchor(current.tasks[0]?.repository_path ?? '', anchors, 'packages/lib');
    expectAnchor(current.tasks[0]?.plan_path ?? '', anchors, `packages/lib/.ai-workflow/plans/${planId}`);
    expectAnchor(current.tasks[0]?.reports_path ?? '', anchors, `packages/lib/.ai-workflow/plans/${planId}/reports`);
    expectAnchor(current.tasks[0]?.task_anchor ?? '', anchors, `.ai-workflow/plans/${planId}/tasks/task-002-lib.md`);
    expectAnchor(current.tasks[0]?.plan_anchor ?? '', anchors, `.ai-workflow/plans/${planId}/plan.md`);
    expect(explicit.phase).toBe(1);
    expect(taskIds(explicit)).toEqual(['task-001-app']);
  });

  it('refuses a workspace plan with a missing manifest', async () => {
    const planId = '20261113-dispatch-no-manifest';
    const root = await temporary('ai-workflow-dispatch-no-manifest-');
    const planDirectory = await workspacePlanFixture(root, workspaceSpec(planId));

    await expect(dispatch({ planDirectory })).rejects.toThrow(/workspace\.yaml|manifest/i);
  });

  it('refuses a workspace plan whose workspace status is invalid', async () => {
    const planId = '20261113-dispatch-invalid-status';
    const { planDirectory } = await buildWorkspace(planId, { ...validManifest(planId), planId: '20260101-other' });

    await expect(dispatch({ planDirectory })).rejects.toThrow(/plan_id mismatch|workspace status/i);
  });

  it('refuses a completed workspace plan with no pending phase when --phase is absent', async () => {
    const planId = '20261113-dispatch-completed';
    const { root, planDirectory } = await buildWorkspace(planId);
    await writeCompletedRecord(join(root, 'packages/app/.ai-workflow/plans', planId), planId);
    await writeCompletedRecord(join(root, '.ai-workflow/plans', planId), planId);

    await expect(dispatch({ planDirectory })).rejects.toThrow(/no pending phase|pending phase/i);
    const explicit = await dispatch({ planDirectory, phase: 1 });
    expect(taskIds(explicit)).toEqual(['task-001-app']);
  });
});
