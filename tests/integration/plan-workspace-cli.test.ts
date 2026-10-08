import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { frozenDocumentDigest, frozenPlanDigest } from '../../src/workflow/digest.js';
import { frozenPlan, temporary, workspacePlanFixture, type WorkspacePlanFixtureSpec } from '../helpers.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;

const WORKSPACE_ID = '20260930-workspace-example';
const SLICE_ID = '20260930-slice-example';

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', [...cli, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

const workspaceRepos = [
  { name: 'workspace', path: '.', dependsOn: [] },
  { name: 'app', path: 'packages/app', dependsOn: [] },
  { name: 'lib', path: 'packages/lib', dependsOn: ['app'] },
];

const workspaceManifest = {
  planId: WORKSPACE_ID,
  role: 'workspace' as const,
  repositories: [
    { name: 'workspace', path: '.', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
    { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
    { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
  ],
};

function validWorkspaceSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: WORKSPACE_ID,
    requirements: ['REQ-001', 'REQ-002', 'REQ-003'],
    acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003'],
    workspaceRepos,
    tasks: [
      { id: 'task-001-workspace', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/workspace.ts'] },
      { id: 'task-002-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
      { id: 'task-003-lib', repo: 'lib', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], writeScope: ['src/lib.ts'] },
    ],
    phases: [['task-001-workspace'], ['task-002-app'], ['task-003-lib']],
    manifest: workspaceManifest,
  };
}

describe('plan validate for workspace plans', () => {
  it('reports the manifest repositories in declaration order for a valid workspace plan', async () => {
    const root = await temporary('ai-workflow-plan-workspace-');
    const directory = await workspacePlanFixture(root, validWorkspaceSpec());

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      valid: boolean;
      plan_id: string;
      repos?: { name: string; path: string; depends_on: string[] }[];
      execution_order?: string[][];
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.plan_id).toBe(WORKSPACE_ID);
    expect(parsed.repos).toEqual([
      { name: 'workspace', path: '.', depends_on: [] },
      { name: 'app', path: 'packages/app', depends_on: [] },
      { name: 'lib', path: 'packages/lib', depends_on: ['app'] },
    ]);
    expect(parsed.execution_order).toEqual([['task-001-workspace'], ['task-002-app'], ['task-003-lib']]);
  });

  it('fails workspace coverage and names the uncovered requirement', async () => {
    const root = await temporary('ai-workflow-plan-workspace-coverage-');
    const spec = validWorkspaceSpec();
    spec.tasks = [
      { id: 'task-001-workspace', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/workspace.ts'] },
      { id: 'task-002-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
    ];
    spec.phases = [['task-001-workspace'], ['task-002-app']];
    spec.manifest = {
      planId: WORKSPACE_ID,
      role: 'workspace',
      repositories: [
        { name: 'workspace', path: '.', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: [], acceptanceCriteria: [] },
      ],
    };
    const directory = await workspacePlanFixture(root, spec);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    expect(outputOf(result)).toContain('REQ-003');
  });

  it('rejects a workspace plan with no manifest whose tasks leave a requirement and criterion uncovered', async () => {
    const root = await temporary('ai-workflow-plan-workspace-no-manifest-coverage-');
    const spec = validWorkspaceSpec();
    spec.tasks = [
      { id: 'task-001-workspace', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/workspace.ts'] },
      { id: 'task-002-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
    ];
    spec.phases = [['task-001-workspace'], ['task-002-app']];
    delete spec.manifest;
    const directory = await workspacePlanFixture(root, spec);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    expect(outputOf(result)).toContain('Frozen plan REQ/AC coverage is incomplete');
  });

  it('accepts equal repository-relative write scopes in different repositories within one phase', async () => {
    const root = await temporary('ai-workflow-plan-workspace-overlap-');
    const directory = await workspacePlanFixture(root, {
      planId: WORKSPACE_ID,
      requirements: ['REQ-001', 'REQ-002'],
      acceptanceCriteria: ['AC-001', 'AC-002'],
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: [] },
        { name: 'app', path: 'packages/app', dependsOn: [] },
        { name: 'lib', path: 'packages/lib', dependsOn: [] },
      ],
      tasks: [
        { id: 'task-001-app', repo: 'app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/shared.ts'] },
        { id: 'task-002-lib', repo: 'lib', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/shared.ts'] },
      ],
      phases: [['task-001-app', 'task-002-lib']],
      manifest: {
        planId: WORKSPACE_ID,
        role: 'workspace',
        repositories: [
          { name: 'workspace', path: '.', dependsOn: [], requirements: [], acceptanceCriteria: [] },
          { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
          { name: 'lib', path: 'packages/lib', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        ],
      },
    });

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; repos?: unknown[] };
    expect(parsed.valid).toBe(true);
    expect(parsed.repos).toHaveLength(3);
  });

  it('fails when a dependent repository task is scheduled before its dependency repository', async () => {
    const root = await temporary('ai-workflow-plan-workspace-order-');
    const spec = validWorkspaceSpec();
    spec.phases = [['task-001-workspace'], ['task-003-lib'], ['task-002-app']];
    const directory = await workspacePlanFixture(root, spec);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    const output = outputOf(result);
    expect(output).toContain('task-003-lib');
    expect(output).toContain('app');
  });

  it('rejects a workspace plan with no manifest whose dependent task is scheduled before its dependency', async () => {
    const root = await temporary('ai-workflow-plan-workspace-no-manifest-order-');
    const spec = validWorkspaceSpec();
    spec.phases = [['task-001-workspace'], ['task-003-lib'], ['task-002-app']];
    delete spec.manifest;
    const directory = await workspacePlanFixture(root, spec);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Workspace repository order violation');
    expect(result.stderr).toContain('task-003-lib');
    expect(result.stderr).toContain('app');
  });

  it('keeps a non-workspace frozen plan output byte-identical', async () => {
    const root = await temporary('ai-workflow-plan-workspace-legacy-');
    const directory = await frozenPlan(root, true);
    const specSource = await readFile(join(directory, 'spec.md'), 'utf8');
    const planSource = await readFile(join(directory, 'plan.md'), 'utf8');
    const expected = `${JSON.stringify({
      valid: true,
      plan_id: '20260831-example',
      digests: {
        spec: frozenDocumentDigest(specSource),
        plan: frozenDocumentDigest(planSource),
        combined: frozenPlanDigest(specSource, planSource),
      },
      execution_order: [['task-001-example']],
    }, null, 2)}\n`;

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(expected);
    expect(result.stdout).not.toContain('repos');
  });

  it('rejects an acyclic workspace plan whose reserved workspace root declares a non-empty depends_on', async () => {
    const root = await temporary('ai-workflow-plan-workspace-root-depends-');
    const spec: WorkspacePlanFixtureSpec = {
      planId: WORKSPACE_ID,
      requirements: ['REQ-001', 'REQ-002', 'REQ-003'],
      acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003'],
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: ['app'] },
        { name: 'app', path: 'packages/app', dependsOn: [] },
        { name: 'lib', path: 'packages/lib', dependsOn: ['app'] },
      ],
      tasks: [
        { id: 'task-001-workspace', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/workspace.ts'] },
        { id: 'task-002-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
        { id: 'task-003-lib', repo: 'lib', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], writeScope: ['src/lib.ts'] },
      ],
      phases: [['task-002-app'], ['task-001-workspace'], ['task-003-lib']],
      manifest: {
        planId: WORKSPACE_ID,
        role: 'workspace',
        repositories: [
          { name: 'workspace', path: '.', dependsOn: ['app'], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
          { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
          { name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
        ],
      },
    };
    const directory = await workspacePlanFixture(root, spec);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    const output = outputOf(result);
    expect(output).toMatch(/empty/i);
    expect(output).toContain('depends_on');
  });
});

describe('plan validate for slice manifests', () => {
  function sliceSpec(overrides: Partial<WorkspacePlanFixtureSpec> = {}): WorkspacePlanFixtureSpec {
    return {
      planId: SLICE_ID,
      requirements: ['REQ-001', 'REQ-002'],
      acceptanceCriteria: ['AC-001', 'AC-002'],
      workspaceRepos: [
        { name: 'workspace', path: '.', dependsOn: [] },
        { name: 'app', path: 'packages/app', dependsOn: [] },
      ],
      tasks: [
        { id: 'task-001-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
      ],
      phases: [['task-001-app']],
      manifest: {
        planId: SLICE_ID,
        role: 'slice',
        repositories: [
          { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        ],
      },
      ...overrides,
    };
  }

  it('validates a slice whose task subset equals the declared subset and omits repos', async () => {
    const root = await temporary('ai-workflow-plan-slice-ok-');
    const directory = await workspacePlanFixture(root, sliceSpec());

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; repos?: unknown };
    expect(parsed.valid).toBe(true);
    expect(parsed.repos).toBeUndefined();
  });

  it('fails a slice whose subset diverges and names the diverging ids', async () => {
    const root = await temporary('ai-workflow-plan-slice-divergent-');
    const directory = await workspacePlanFixture(root, sliceSpec({
      manifest: {
        planId: SLICE_ID,
        role: 'slice',
        repositories: [
          { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        ],
      },
    }));

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    const output = outputOf(result);
    expect(output).toContain('REQ-001');
    expect(output).toContain('REQ-002');
  });
});
