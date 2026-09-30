import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { readPlan, readTasks } from '../../src/workflow/parse.js';
import { readWorkspaceManifest, renderWorkspaceManifest, validateWorkspaceManifest, type WorkspaceManifest } from '../../src/workflow/workspace.js';
import type { PlanDocument, TaskDocument, TaskSchedule } from '../../src/workflow/types.js';
import { temporary, workspacePlanFixture, writePlanTriplet } from '../helpers.js';

const PLAN_ID = '20260930-workspace-example';
const PLAN_DIRECTORY = '/tmp/ai-workflow-workspace-unit';

function planDocument(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    planId: PLAN_ID,
    status: 'frozen',
    requirements: ['REQ-001', 'REQ-002', 'REQ-003'],
    acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003'],
    specDigest: `sha256:${'0'.repeat(64)}`,
    planDigest: `sha256:${'0'.repeat(64)}`,
    digest: `sha256:${'0'.repeat(64)}`,
    directory: PLAN_DIRECTORY,
    workspaceRepos: [
      { name: 'workspace', path: '.', depends_on: [] },
      { name: 'app', path: 'packages/app', depends_on: [] },
      { name: 'lib', path: 'packages/lib', depends_on: ['app'] },
    ],
    ...overrides,
  };
}

function taskDocument(id: string, repo: string, requirements: string[], acceptanceCriteria: string[]): TaskDocument {
  return { id, repo, requirements, acceptanceCriteria, dependsOn: [], surface: 'backend', readScope: [], writeScope: [`src/${id}.ts`], testCommands: [], path: `tasks/${id}.md` };
}

function workspaceManifest(overrides: Partial<WorkspaceManifest> = {}): WorkspaceManifest {
  return {
    planId: PLAN_ID,
    role: 'workspace',
    repositories: [
      { name: 'workspace', path: '.', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
      { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
      { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
    ],
    ...overrides,
  };
}

function workspaceTasks(): TaskDocument[] {
  return [
    taskDocument('task-001-workspace', 'workspace', ['REQ-001'], ['AC-001']),
    taskDocument('task-002-app', 'app', ['REQ-002'], ['AC-002']),
    taskDocument('task-003-lib', 'lib', ['REQ-003'], ['AC-003']),
  ];
}

function scheduleOf(phases: string[][]): TaskSchedule {
  return { planId: PLAN_ID, phases: phases.map((parallel) => ({ parallel })) };
}

const validSchedule = scheduleOf([['task-001-workspace'], ['task-002-app'], ['task-003-lib']]);

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the operation to reject, but it resolved');
}

/** Write a minimal frozen pair whose plan frontmatter carries a raw (possibly malformed) `workspace_repos`. */
async function rawWorkspacePlan(root: string, workspaceRepos: unknown): Promise<string> {
  const directory = join(root, '.ai-workflow/plans', PLAN_ID);
  await mkdir(join(directory, 'tasks'), { recursive: true });
  const base = { plan_id: PLAN_ID, status: 'frozen', created_at: '2026-09-30T00:00:00.000Z', supersedes: null, requirement_count: 1, acceptance_criteria_count: 1, digest: 'sha256:placeholder' };
  const body = '# Specification\n\n## REQ-001: requirement\n\nprose.\n\n## AC-001: acceptance criteria\n\nprose.\n';
  const planBody = '# Implementation Plan\n\n## Requirement coverage\n\n| Requirement | Acceptance criteria | Implementation step |\n| --- | --- | --- |\n| REQ-001 | AC-001 | Step 1 |\n\n## Implementation sequence\n\n1. Implement REQ-001.\n';
  await writePlanTriplet(directory, 'spec.md', body, body, (source) => renderFrozenMarkdown(base, source));
  await writePlanTriplet(directory, 'plan.md', planBody, planBody, (source) => renderFrozenMarkdown({ ...base, workspace_repos: workspaceRepos }, source));
  return directory;
}

describe('readWorkspaceManifest', () => {
  it('returns undefined when workspace.yaml is absent', async () => {
    const directory = await temporary('ai-workflow-manifest-none-');

    await expect(readWorkspaceManifest(directory)).resolves.toBeUndefined();
  });

  it('reads a complete manifest back into its typed shape', async () => {
    const directory = await temporary('ai-workflow-manifest-read-');
    const expected = workspaceManifest();
    await writeFile(join(directory, 'workspace.yaml'), renderWorkspaceManifest(expected));

    await expect(readWorkspaceManifest(directory)).resolves.toEqual(expected);
  });

  it('reports malformed YAML with the manifest path', async () => {
    const directory = await temporary('ai-workflow-manifest-malformed-');
    await writeFile(join(directory, 'workspace.yaml'), 'plan_id: [unclosed\n');

    const message = await rejection(readWorkspaceManifest(directory));

    expect(message).toContain('Malformed workspace manifest YAML');
    expect(message).toContain('workspace.yaml');
  });

  it('reports a bad shape with the manifest path', async () => {
    const directory = await temporary('ai-workflow-manifest-shape-');
    await writeFile(join(directory, 'workspace.yaml'), 'plan_id: x\nrole: workspace\nrepositories: nope\n');

    const message = await rejection(readWorkspaceManifest(directory));

    expect(message).toContain('Invalid workspace manifest shape');
    expect(message).toContain('workspace.yaml');
  });

  it('rejects an unknown role by name', async () => {
    const directory = await temporary('ai-workflow-manifest-role-');
    await writeFile(
      join(directory, 'workspace.yaml'),
      'plan_id: x\nrole: mystery\nrepositories:\n  - name: app\n    path: packages/app\n    depends_on: []\n    requirements: []\n    acceptance_criteria: []\n',
    );

    const message = await rejection(readWorkspaceManifest(directory));

    expect(message).toBe('Invalid workspace manifest role: mystery');
  });
});

describe('renderWorkspaceManifest', () => {
  it('round-trips a workspace role manifest through the reader', async () => {
    const directory = await temporary('ai-workflow-manifest-roundtrip-');
    const manifest = workspaceManifest();
    await writeFile(join(directory, 'workspace.yaml'), renderWorkspaceManifest(manifest));

    await expect(readWorkspaceManifest(directory)).resolves.toEqual(manifest);
  });

  it('round-trips a slice role manifest through the reader', async () => {
    const directory = await temporary('ai-workflow-manifest-roundtrip-slice-');
    const manifest = workspaceManifest({
      role: 'slice',
      repositories: [{ name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] }],
    });
    await writeFile(join(directory, 'workspace.yaml'), renderWorkspaceManifest(manifest));

    await expect(readWorkspaceManifest(directory)).resolves.toEqual(manifest);
  });
});

describe('validateWorkspaceManifest workspace role', () => {
  it('accepts a manifest whose subsets and order match the plan and schedule', () => {
    expect(validateWorkspaceManifest(workspaceManifest(), planDocument(), workspaceTasks(), validSchedule)).toEqual([]);
  });

  it('rejects a plan_id that differs from the frozen plan', () => {
    const errors = validateWorkspaceManifest(workspaceManifest({ planId: 'other' }), planDocument(), workspaceTasks(), validSchedule);

    expect(errors).toContain(`Workspace manifest plan_id mismatch: other, expected ${PLAN_ID}`);
  });

  it('rejects repositories that do not match the plan declaration', () => {
    const manifest = workspaceManifest({
      repositories: [
        { name: 'workspace', path: '.', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { name: 'app', path: 'packages/other', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
      ],
    });

    const errors = validateWorkspaceManifest(manifest, planDocument(), workspaceTasks(), validSchedule);

    expect(errors).toContain('Workspace manifest repositories do not match the plan declaration');
  });

  it('names a requirement a repository manifest omits that its tasks cover', () => {
    const manifest = workspaceManifest({
      repositories: [
        { name: 'workspace', path: '.', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002', 'REQ-003'], acceptanceCriteria: ['AC-002'] },
        { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: [], acceptanceCriteria: ['AC-003'] },
      ],
    });

    const errors = validateWorkspaceManifest(manifest, planDocument(), workspaceTasks(), validSchedule);

    expect(errors).toContain('Repository "app" requirements do not match its tasks: missing REQ-003');
  });

  it('names a requirement a repository manifest declares that its tasks do not cover', () => {
    const manifest = workspaceManifest({
      repositories: [
        { name: 'workspace', path: '.', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
      ],
    });
    const tasks = [
      taskDocument('task-001-workspace', 'workspace', ['REQ-001'], ['AC-001']),
      taskDocument('task-002-app', 'app', ['REQ-002', 'REQ-003'], ['AC-002']),
      taskDocument('task-003-lib', 'lib', [], ['AC-003']),
    ];

    const errors = validateWorkspaceManifest(manifest, planDocument(), tasks, validSchedule);

    expect(errors).toContain('Repository "app" requirements do not match its tasks: unexpected REQ-003');
  });

  it('names an acceptance criterion a repository manifest omits that its tasks cover', () => {
    const manifest = workspaceManifest({
      repositories: [
        { name: 'workspace', path: '.', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002', 'AC-003'] },
        { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: ['REQ-003'], acceptanceCriteria: [] },
      ],
    });

    const errors = validateWorkspaceManifest(manifest, planDocument(), workspaceTasks(), validSchedule);

    expect(errors).toContain('Repository "app" acceptance criteria do not match its tasks: missing AC-003');
  });

  it('names an acceptance criterion a repository manifest declares that its tasks do not cover', () => {
    const errors = validateWorkspaceManifest(workspaceManifest(), planDocument(), [
      taskDocument('task-001-workspace', 'workspace', ['REQ-001'], ['AC-001']),
      taskDocument('task-002-app', 'app', ['REQ-002'], ['AC-002', 'AC-003']),
      taskDocument('task-003-lib', 'lib', ['REQ-003'], []),
    ], validSchedule);

    expect(errors).toContain('Repository "app" acceptance criteria do not match its tasks: unexpected AC-003');
  });

  it('names plan requirements and acceptance criteria no manifest subset covers', () => {
    const manifest = workspaceManifest({
      repositories: [
        { name: 'workspace', path: '.', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: [], acceptanceCriteria: [] },
      ],
    });
    const tasks = [
      taskDocument('task-001-workspace', 'workspace', ['REQ-001'], ['AC-001']),
      taskDocument('task-002-app', 'app', ['REQ-002'], ['AC-002']),
    ];

    const errors = validateWorkspaceManifest(manifest, planDocument(), tasks, scheduleOf([['task-001-workspace'], ['task-002-app']]));
    const message = errors.join('\n');

    expect(message).toContain('Frozen plan coverage is incomplete');
    expect(message).toContain('REQ-003');
    expect(message).toContain('AC-003');
  });

  it('rejects a dependent repository task scheduled before its dependency repository task', () => {
    const errors = validateWorkspaceManifest(workspaceManifest(), planDocument(), workspaceTasks(), scheduleOf([
      ['task-001-workspace'],
      ['task-003-lib'],
      ['task-002-app'],
    ]));

    expect(errors).toContain('Workspace repository order violation: task task-003-lib of repository "lib" must be scheduled after repository "app"');
  });

  it('rejects a dependent repository task scheduled in the same phase as its dependency repository task', () => {
    const errors = validateWorkspaceManifest(workspaceManifest(), planDocument(), workspaceTasks(), scheduleOf([
      ['task-001-workspace'],
      ['task-002-app', 'task-003-lib'],
    ]));

    expect(errors).toContain('Workspace repository order violation: task task-003-lib of repository "lib" must be scheduled after repository "app"');
  });
});

describe('validateWorkspaceManifest slice role', () => {
  const sliceManifest = (overrides: Partial<WorkspaceManifest> = {}): WorkspaceManifest => workspaceManifest({
    role: 'slice',
    repositories: [{ name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] }],
    ...overrides,
  });

  function sliceTasks(): TaskDocument[] {
    return [taskDocument('task-002-app', 'app', ['REQ-002'], ['AC-002'])];
  }

  it('accepts a slice whose task subset equals the declared subset without full-plan coverage', () => {
    expect(validateWorkspaceManifest(sliceManifest(), planDocument(), sliceTasks(), scheduleOf([['task-002-app']]))).toEqual([]);
  });

  it('requires exactly one repository entry', () => {
    const manifest = workspaceManifest({
      role: 'slice',
      repositories: [
        { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: [], acceptanceCriteria: [] },
      ],
    });

    const errors = validateWorkspaceManifest(manifest, planDocument(), sliceTasks(), scheduleOf([['task-002-app']]));

    expect(errors).toContain('Slice manifest must declare exactly one repository');
  });

  it('rejects a plan_id that differs from the frozen plan', () => {
    const errors = validateWorkspaceManifest(sliceManifest({ planId: 'other' }), planDocument(), sliceTasks(), scheduleOf([['task-002-app']]));

    expect(errors).toContain(`Workspace manifest plan_id mismatch: other, expected ${PLAN_ID}`);
  });

  it('names a declared requirement missing from the frozen plan', () => {
    const manifest = sliceManifest({
      repositories: [{ name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-999'], acceptanceCriteria: ['AC-002'] }],
    });

    const errors = validateWorkspaceManifest(manifest, planDocument(), sliceTasks(), scheduleOf([['task-002-app']]));

    expect(errors).toContain('Slice subset references unknown requirement: REQ-999');
  });

  it('names a declared acceptance criterion missing from the frozen plan', () => {
    const manifest = sliceManifest({
      repositories: [{ name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-999'] }],
    });

    const errors = validateWorkspaceManifest(manifest, planDocument(), sliceTasks(), scheduleOf([['task-002-app']]));

    expect(errors).toContain('Slice subset references unknown acceptance criterion: AC-999');
  });

  it('names a slice task that belongs to another repository', () => {
    const tasks = [taskDocument('task-002-app', 'lib', ['REQ-002'], ['AC-002'])];

    const errors = validateWorkspaceManifest(sliceManifest(), planDocument(), tasks, scheduleOf([['task-002-app']]));

    expect(errors).toContain('Slice task task-002-app belongs to repository "lib", expected "app"');
  });

  it('names a requirement the declared subset omits that the tasks cover', () => {
    const errors = validateWorkspaceManifest(sliceManifest(), planDocument(), [
      taskDocument('task-002-app', 'app', ['REQ-002', 'REQ-003'], ['AC-002']),
    ], scheduleOf([['task-002-app']]));

    expect(errors).toContain('Slice requirements do not match the declared subset: unexpected REQ-003');
  });

  it('names a requirement the declared subset declares that the tasks omit', () => {
    const manifest = sliceManifest({
      repositories: [{ name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-002'] }],
    });

    const errors = validateWorkspaceManifest(manifest, planDocument(), sliceTasks(), scheduleOf([['task-002-app']]));

    expect(errors).toContain('Slice requirements do not match the declared subset: missing REQ-001');
  });

  it('names an acceptance criterion the declared subset omits that the tasks cover', () => {
    const errors = validateWorkspaceManifest(sliceManifest(), planDocument(), [
      taskDocument('task-002-app', 'app', ['REQ-002'], ['AC-002', 'AC-003']),
    ], scheduleOf([['task-002-app']]));

    expect(errors).toContain('Slice acceptance criteria do not match the declared subset: unexpected AC-003');
  });

  it('names an acceptance criterion the declared subset declares that the tasks omit', () => {
    const manifest = sliceManifest({
      repositories: [{ name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-001'] }],
    });

    const errors = validateWorkspaceManifest(manifest, planDocument(), sliceTasks(), scheduleOf([['task-002-app']]));

    expect(errors).toContain('Slice acceptance criteria do not match the declared subset: missing AC-001');
  });
});

describe('readPlan workspace repository declarations', () => {
  const base = { tasks: [], phases: [] as string[][] };

  it('reads a valid workspace_repos declaration into workspaceRepos', async () => {
    const directory = await workspacePlanFixture(await temporary('ai-workflow-repos-valid-'), {
      planId: PLAN_ID,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      workspaceRepos: [{ name: 'workspace', path: '.', dependsOn: [] }],
      ...base,
    });

    const document = await readPlan(directory);

    expect(document.workspaceRepos).toEqual([{ name: 'workspace', path: '.', depends_on: [] }]);
  });

  it('requires exactly one reserved workspace root entry', async () => {
    const directory = await workspacePlanFixture(await temporary('ai-workflow-repos-root-'), {
      planId: PLAN_ID,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      workspaceRepos: [{ name: 'app', path: 'packages/app', dependsOn: [] }],
      ...base,
    });

    const message = await rejection(readPlan(directory));

    expect(message).toContain('workspace_repos must declare exactly one reserved "workspace" root entry');
  });

  it('requires the workspace root entry to use path "."', async () => {
    const directory = await workspacePlanFixture(await temporary('ai-workflow-repos-root-path-'), {
      planId: PLAN_ID,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      workspaceRepos: [{ name: 'workspace', path: 'packages/root', dependsOn: [] }],
      ...base,
    });

    const message = await rejection(readPlan(directory));

    expect(message).toContain('workspace repository "workspace" must use path "."');
  });

  it('rejects a duplicate repository name', async () => {
    const directory = await workspacePlanFixture(await temporary('ai-workflow-repos-duplicate-'), {
      planId: PLAN_ID,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: [] },
        { name: 'app', path: 'packages/app', dependsOn: [] },
        { name: 'app', path: 'packages/app-two', dependsOn: [] },
      ],
      ...base,
    });

    const message = await rejection(readPlan(directory));

    expect(message).toContain('duplicate workspace repository name: app');
  });

  it('rejects a non-root repository that uses path "."', async () => {
    const directory = await workspacePlanFixture(await temporary('ai-workflow-repos-reserved-path-'), {
      planId: PLAN_ID,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: [] },
        { name: 'app', path: '.', dependsOn: [] },
      ],
      ...base,
    });

    const message = await rejection(readPlan(directory));

    expect(message).toContain('workspace repository path "." is reserved for the workspace root entry');
  });

  it('rejects an unknown repository dependency', async () => {
    const directory = await workspacePlanFixture(await temporary('ai-workflow-repos-unknown-dep-'), {
      planId: PLAN_ID,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: [] },
        { name: 'app', path: 'packages/app', dependsOn: ['ghost'] },
      ],
      ...base,
    });

    const message = await rejection(readPlan(directory));

    expect(message).toContain('unknown workspace repository dependency: app -> ghost');
  });

  it('rejects a repository dependency cycle', async () => {
    const directory = await workspacePlanFixture(await temporary('ai-workflow-repos-cycle-'), {
      planId: PLAN_ID,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: [] },
        { name: 'app', path: 'packages/app', dependsOn: ['lib'] },
        { name: 'lib', path: 'packages/lib', dependsOn: ['app'] },
      ],
      ...base,
    });

    const message = await rejection(readPlan(directory));

    expect(message).toContain('workspace repository dependency cycle:');
  });

  it('rejects a malformed workspace_repos entry', async () => {
    const directory = await rawWorkspacePlan(await temporary('ai-workflow-repos-malformed-'), [
      { name: 'workspace', path: '.', depends_on: [] },
      'oops',
    ]);

    const message = await rejection(readPlan(directory));

    expect(message).toContain('Invalid workspace_repos entry');
  });
});

describe('readTasks repository rules', () => {
  async function taskPlan(root: string, overrides: { workspaceRepos?: { name: string; path: string; dependsOn: string[] }[]; tasks: { id: string; repo?: string; requirements: string[]; acceptanceCriteria: string[]; dependsOn?: string[] }[] }, requirements: string[], acceptanceCriteria: string[]): Promise<string> {
    return workspacePlanFixture(root, {
      planId: PLAN_ID,
      requirements,
      acceptanceCriteria,
      ...(overrides.workspaceRepos ? { workspaceRepos: overrides.workspaceRepos } : {}),
      tasks: overrides.tasks,
      phases: overrides.tasks.map((task) => [task.id]),
    });
  }

  it('requires repo when the plan declares repositories', async () => {
    const directory = await taskPlan(await temporary('ai-workflow-task-repo-required-'), {
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: [] },
        { name: 'app', path: 'packages/app', dependsOn: [] },
      ],
      tasks: [{ id: 'task-001-app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] }],
    }, ['REQ-001'], ['AC-001']);

    const message = await rejection(readTasks(directory));

    expect(message).toContain('Task must declare repo: task-001-app');
  });

  it('forbids repo outside a workspace plan', async () => {
    const directory = await taskPlan(await temporary('ai-workflow-task-repo-forbidden-'), {
      tasks: [{ id: 'task-001-app', repo: 'app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] }],
    }, ['REQ-001'], ['AC-001']);

    const message = await rejection(readTasks(directory));

    expect(message).toContain('Task must not declare repo outside a workspace plan: task-001-app');
  });

  it('rejects a repo that is not declared', async () => {
    const directory = await taskPlan(await temporary('ai-workflow-task-repo-unknown-'), {
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: [] },
        { name: 'app', path: 'packages/app', dependsOn: [] },
      ],
      tasks: [{ id: 'task-001-app', repo: 'lib', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] }],
    }, ['REQ-001'], ['AC-001']);

    const message = await rejection(readTasks(directory));

    expect(message).toContain('Task repo is not declared: task-001-app -> lib');
  });

  it('rejects a task dependency on another repository', async () => {
    const directory = await taskPlan(await temporary('ai-workflow-task-cross-repo-'), {
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: [] },
        { name: 'app', path: 'packages/app', dependsOn: [] },
        { name: 'lib', path: 'packages/lib', dependsOn: [] },
      ],
      tasks: [
        { id: 'task-001-app', repo: 'app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { id: 'task-002-lib', repo: 'lib', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], dependsOn: ['task-001-app'] },
      ],
    }, ['REQ-001', 'REQ-002'], ['AC-001', 'AC-002']);

    const message = await rejection(readTasks(directory));

    expect(message).toContain('Cross-repository task dependency: task-002-lib -> task-001-app');
  });
});
