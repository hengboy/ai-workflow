import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { planReport } from '../../src/workflow/report.js';
import { commitFile, frozenPlan, gitInit, renderWorkspaceManifestYaml, temporary, workspacePlanFixture, writePlanTriplet, type WorkspacePlanFixtureSpec } from '../helpers.js';

const exec = promisify(execFile);

type Unknown = 'unknown';

/**
 * The stable plan-report contract exercised by these tests.
 *
 * - `critical_path_length` is the number of tasks on the longest `depends_on` chain; a single
 *   task is 1.
 * - `duration_seconds` is `completed_at - started_at` in whole seconds, only when both are
 *   recorded; otherwise it is the literal `unknown`.
 * - `review_rounds` counts files directly under `reports/` whose basename starts with
 *   `review-round`; otherwise it is `unknown`.
 * - `status` is `unknown` with no implementation record, `in-progress` while the records are
 *   incomplete, and `completed` when every participating repository record is completed.
 * - `commit_count` is a number only when every delivered repository record carries an execution
 *   anchor with `base_commit` and a final `commit` or `root_tasks_commit`; otherwise it is `null`
 *   and `commit_count_reason` explains why no count is available.
 */
interface WorkspaceExecutionProjection {
  phase: number | null;
  pending_tasks: { task: string; repo: string; repository_path: string; plan_path: string }[];
  awaiting_delivery: string[];
  blockers: string[];
  completed: boolean;
}

interface PlanReport {
  plan_id: string;
  created_at: string | Unknown;
  started_at: string | Unknown;
  completed_at: string | Unknown;
  duration_seconds: number | Unknown;
  status: 'unknown' | 'in-progress' | 'completed';
  task_count: number;
  phase_count: number;
  critical_path_length: number;
  review_rounds: number | Unknown;
  commit_count: number | null;
  commit_count_reason: string | null;
  execution?: WorkspaceExecutionProjection;
}

const WORKSPACE_PLAN_ID = '20260930-report-workspace';

const workspaceRepos = [
  { name: 'workspace', path: '.', dependsOn: [] },
  { name: 'app', path: 'packages/app', dependsOn: [] },
  { name: 'lib', path: 'packages/lib', dependsOn: [] },
];

function workspaceSpec(overrides: Partial<WorkspacePlanFixtureSpec> = {}): WorkspacePlanFixtureSpec {
  return {
    planId: WORKSPACE_PLAN_ID,
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    workspaceRepos,
    tasks: [
      { id: 'task-001-app', repo: 'app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/app.ts'] },
      { id: 'task-002-lib', repo: 'lib', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/lib.ts'] },
    ],
    phases: [['task-001-app', 'task-002-lib']],
    manifest: {
      planId: WORKSPACE_PLAN_ID,
      role: 'workspace',
      repositories: [
        { name: 'workspace', path: '.', dependsOn: [], requirements: [], acceptanceCriteria: [] },
        { name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { name: 'lib', path: 'packages/lib', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
      ],
    },
    ...overrides,
  };
}

function implementationPath(root: string, repositoryPath: string, planId: string): string {
  return join(root, repositoryPath, '.ai-workflow', 'plans', planId, 'implementation.yaml');
}

async function writeRecord(root: string, repositoryPath: string, planId: string, record: Record<string, unknown>): Promise<string> {
  const path = implementationPath(root, repositoryPath, planId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(record));
  return path;
}

function executionAnchor(repository: string, baseCommit: string): Record<string, unknown> {
  return {
    purpose: 'tasks',
    source_root: '/tmp/report-source',
    repository,
    worktree: `/tmp/report-worktree/${repository}`,
    branch: 'ai-workflow/report',
    target_branch: 'main',
    base_commit: baseCommit,
  };
}

async function headOf(repository: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repository });
  return stdout.trim();
}

describe('planReport', () => {
  it('reports an unstarted frozen plan without inventing timestamps, status or commits', async () => {
    const root = await temporary('ai-workflow-report-not-started-');
    const directory = await frozenPlan(root, true);

    const report = (await planReport(directory)) as PlanReport;

    expect(report.plan_id).toBe('20260831-example');
    expect(report.created_at).toBe('2026-08-31T00:00:00.000Z');
    expect(report.started_at).toBe('unknown');
    expect(report.completed_at).toBe('unknown');
    expect(report.duration_seconds).toBe('unknown');
    expect(report.status).toBe('unknown');
    expect(report.task_count).toBe(1);
    expect(report.phase_count).toBe(1);
    expect(report.critical_path_length).toBe(1);
    expect(report.review_rounds).toBe('unknown');
    expect(report.commit_count).toBeNull();
    expect(typeof report.commit_count_reason).toBe('string');
    expect(report.commit_count_reason).toMatch(/record|anchor/i);
    expect(report.execution).toBeUndefined();
    await expect(access(implementationPath(root, '.', '20260831-example'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a frozen plan without task documents instead of requiring an execution order', async () => {
    const root = await temporary('ai-workflow-report-no-tasks-');
    const directory = await frozenPlan(root, false);

    const report = (await planReport(directory)) as PlanReport;

    expect(report.plan_id).toBe('20260831-example');
    expect(report.status).toBe('unknown');
    expect(report.task_count).toBe(0);
    expect(report.phase_count).toBe(0);
    expect(report.critical_path_length).toBe(0);
    expect(report.started_at).toBe('unknown');
    expect(report.completed_at).toBe('unknown');
    expect(report.commit_count).toBeNull();
    expect(typeof report.commit_count_reason).toBe('string');
    expect(report.commit_count_reason).toMatch(/record|anchor/i);
    await expect(access(implementationPath(root, '.', '20260831-example'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a root-only workspace plan without tasks as in-progress, not completed', async () => {
    const root = await temporary('ai-workflow-report-root-only-workspace-');
    const planId = '20260930-report-root-only';
    const directory = join(root, '.ai-workflow/plans', planId);
    await mkdir(join(directory, 'tasks'), { recursive: true });
    const baseAttributes = {
      plan_id: planId,
      status: 'frozen',
      created_at: '2026-09-30T00:00:00.000Z',
      supersedes: null,
      requirement_count: 0,
      acceptance_criteria_count: 0,
      digest: 'sha256:placeholder',
    };
    await writePlanTriplet(directory, 'spec.md', '# Specification\n', '# Specification\n', (body) => renderFrozenMarkdown(baseAttributes, body));
    await writePlanTriplet(directory, 'plan.md', '# Implementation Plan\n', '# Implementation Plan\n', (body) => renderFrozenMarkdown({ ...baseAttributes, workspace_repos: [{ name: 'workspace', path: '.', depends_on: [] }] }, body));
    await writeFile(join(directory, 'workspace.yaml'), renderWorkspaceManifestYaml({
      planId,
      role: 'workspace',
      repositories: [{ name: 'workspace', path: '.', dependsOn: [], requirements: [], acceptanceCriteria: [] }],
    }));
    const startedAt = '2026-10-02T00:00:00.000Z';
    await writeRecord(root, '.', planId, { plan_id: planId, status: 'in-progress', started_at: startedAt });

    const report = (await planReport(directory)) as PlanReport;

    expect(report.status).toBe('in-progress');
    expect(report.started_at).toBe(startedAt);
    expect(report.completed_at).toBe('unknown');
    expect(report.task_count).toBe(0);
    expect(report.phase_count).toBe(0);
    expect(report.critical_path_length).toBe(0);
  });

  it('reports recorded timestamps for a completed root-only workspace plan without tasks', async () => {
    const root = await temporary('ai-workflow-report-root-only-completed-');
    const planId = '20260930-report-root-only-completed';
    const directory = join(root, '.ai-workflow/plans', planId);
    await mkdir(join(directory, 'tasks'), { recursive: true });
    const baseAttributes = {
      plan_id: planId,
      status: 'frozen',
      created_at: '2026-09-30T00:00:00.000Z',
      supersedes: null,
      requirement_count: 0,
      acceptance_criteria_count: 0,
      digest: 'sha256:placeholder',
    };
    await writePlanTriplet(directory, 'spec.md', '# Specification\n', '# Specification\n', (body) => renderFrozenMarkdown(baseAttributes, body));
    await writePlanTriplet(directory, 'plan.md', '# Implementation Plan\n', '# Implementation Plan\n', (body) => renderFrozenMarkdown({ ...baseAttributes, workspace_repos: [{ name: 'workspace', path: '.', depends_on: [] }] }, body));
    await writeFile(join(directory, 'workspace.yaml'), renderWorkspaceManifestYaml({
      planId,
      role: 'workspace',
      repositories: [{ name: 'workspace', path: '.', dependsOn: [], requirements: [], acceptanceCriteria: [] }],
    }));
    const startedAt = '2026-10-02T00:00:00.000Z';
    const completedAt = '2026-10-02T00:10:00.000Z';
    await writeRecord(root, '.', planId, { plan_id: planId, status: 'completed', started_at: startedAt, completed_at: completedAt });

    const report = (await planReport(directory)) as PlanReport;

    expect(report.status).toBe('completed');
    expect(report.started_at).toBe(startedAt);
    expect(report.completed_at).toBe(completedAt);
    expect(report.duration_seconds).toBe(600);
    expect(report.task_count).toBe(0);
  });

  it('counts only review-round files directly under reports/', async () => {
    const root = await temporary('ai-workflow-report-review-rounds-');
    const directory = await frozenPlan(root, true);
    const reports = join(directory, 'reports');
    await mkdir(reports, { recursive: true });
    await writeFile(join(reports, 'review-round-1.md'), '# Round 1\n');
    await writeFile(join(reports, 'review-round-2.md'), '# Round 2\n');
    await writeFile(join(reports, 'summary.md'), '# Summary\n');
    await mkdir(join(reports, 'review-round-nested'), { recursive: true });
    await writeFile(join(reports, 'review-round-nested', 'inside.md'), '# Inside\n');

    const report = (await planReport(directory)) as PlanReport;

    expect(report.review_rounds).toBe(2);
    expect(report.status).toBe('unknown');
  });

  it('reports an in-progress workspace plan with its execution projection', async () => {
    const root = await temporary('ai-workflow-report-in-progress-');
    const directory = await workspacePlanFixture(root, workspaceSpec());
    await mkdir(join(root, 'packages/app'), { recursive: true });
    await mkdir(join(root, 'packages/lib'), { recursive: true });
    const startedAt = '2026-10-01T00:00:00.000Z';
    await writeRecord(root, 'packages/app', WORKSPACE_PLAN_ID, {
      plan_id: WORKSPACE_PLAN_ID,
      status: 'in-progress',
      started_at: startedAt,
      execution: executionAnchor('app', 'c'.repeat(40)),
    });

    const report = (await planReport(directory)) as PlanReport;

    expect(report.plan_id).toBe(WORKSPACE_PLAN_ID);
    expect(report.created_at).toBe('2026-09-30T00:00:00.000Z');
    expect(report.started_at).toBe(startedAt);
    expect(report.completed_at).toBe('unknown');
    expect(report.duration_seconds).toBe('unknown');
    expect(report.status).toBe('in-progress');
    expect(report.task_count).toBe(2);
    expect(report.phase_count).toBe(1);
    expect(report.critical_path_length).toBe(1);
    expect(report.review_rounds).toBe('unknown');
    expect(report.commit_count).toBeNull();
    expect(report.execution).toBeDefined();
    const execution = report.execution as WorkspaceExecutionProjection;
    expect(execution.phase).toBe(1);
    expect(execution.pending_tasks.map((task) => task.task)).toEqual(['task-001-app', 'task-002-lib']);
    expect(execution.completed).toBe(false);
  });

  it('sums real git ranges only when every delivered workspace record has an anchor and final commit', async () => {
    const root = await temporary('ai-workflow-report-completed-');
    const directory = await workspacePlanFixture(root, workspaceSpec());
    const app = join(root, 'packages/app');
    const lib = join(root, 'packages/lib');
    await mkdir(app, { recursive: true });
    await mkdir(lib, { recursive: true });
    await gitInit(app);
    await gitInit(lib);
    const appBase = await headOf(app);
    await commitFile(app, 'src/app-1.ts', 'export const appOne = true;\n', 'app one');
    const appFinal = await commitFile(app, 'src/app-2.ts', 'export const appTwo = true;\n', 'app two');
    const libBase = await headOf(lib);
    const libFinal = await commitFile(lib, 'src/lib-1.ts', 'export const libOne = true;\n', 'lib one');
    const startedAt = '2026-10-01T00:00:00.000Z';
    const completedAt = '2026-10-01T00:10:00.000Z';
    await writeRecord(root, 'packages/app', WORKSPACE_PLAN_ID, {
      plan_id: WORKSPACE_PLAN_ID,
      status: 'completed',
      started_at: startedAt,
      completed_at: completedAt,
      commit: appFinal,
      execution: executionAnchor('app', appBase),
    });
    await writeRecord(root, 'packages/lib', WORKSPACE_PLAN_ID, {
      plan_id: WORKSPACE_PLAN_ID,
      status: 'completed',
      started_at: startedAt,
      completed_at: completedAt,
      commit: libFinal,
      execution: executionAnchor('lib', libBase),
    });

    const report = (await planReport(directory)) as PlanReport;

    expect(report.commit_count).toBe(3);
    expect(report.commit_count_reason).toBeNull();
    expect(report.status).toBe('completed');
    expect(report.started_at).toBe(startedAt);
    expect(report.completed_at).toBe(completedAt);
    expect(report.duration_seconds).toBe(600);
    expect(report.task_count).toBe(2);
    expect(report.phase_count).toBe(1);
    expect(report.critical_path_length).toBe(1);
  });

  it('reports null and names the missing repository when a workspace record is absent', async () => {
    const root = await temporary('ai-workflow-report-partial-');
    const directory = await workspacePlanFixture(root, workspaceSpec());
    const app = join(root, 'packages/app');
    await mkdir(app, { recursive: true });
    await mkdir(join(root, 'packages/lib'), { recursive: true });
    await gitInit(app);
    const appBase = await headOf(app);
    const appFinal = await commitFile(app, 'src/app.ts', 'export const app = true;\n', 'app delivery');
    await writeRecord(root, 'packages/app', WORKSPACE_PLAN_ID, {
      plan_id: WORKSPACE_PLAN_ID,
      status: 'completed',
      started_at: '2026-10-01T00:00:00.000Z',
      completed_at: '2026-10-01T00:05:00.000Z',
      commit: appFinal,
      execution: executionAnchor('app', appBase),
    });

    const report = (await planReport(directory)) as PlanReport;

    expect(report.status).toBe('in-progress');
    expect(report.commit_count).toBeNull();
    expect(typeof report.commit_count_reason).toBe('string');
    expect(report.commit_count_reason).toContain('lib');
  });

  it('reports null for an ordinary completed record without an execution anchor', async () => {
    const root = await temporary('ai-workflow-report-ordinary-');
    const directory = await frozenPlan(root, true);
    const startedAt = '2026-09-01T00:00:00.000Z';
    const completedAt = '2026-09-01T00:01:05.000Z';
    await writeRecord(root, '.', '20260831-example', {
      plan_id: '20260831-example',
      status: 'completed',
      started_at: startedAt,
      completed_at: completedAt,
      commit: 'b'.repeat(40),
    });

    const report = (await planReport(directory)) as PlanReport;

    expect(report.status).toBe('completed');
    expect(report.started_at).toBe(startedAt);
    expect(report.completed_at).toBe(completedAt);
    expect(report.duration_seconds).toBe(65);
    expect(report.commit_count).toBeNull();
    expect(typeof report.commit_count_reason).toBe('string');
    expect(report.commit_count_reason).toMatch(/execution anchor|base_commit/i);
    expect(report.execution).toBeUndefined();
  });

  it('computes the longest depends_on chain and counts tasks and phases', async () => {
    const root = await temporary('ai-workflow-report-critical-path-');
    const directory = await workspacePlanFixture(root, {
      planId: '20260930-report-critical-path',
      requirements: ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004'],
      acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003', 'AC-004'],
      tasks: [
        { id: 'task-001-a', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/a.ts'] },
        { id: 'task-002-b', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], dependsOn: ['task-001-a'], writeScope: ['src/b.ts'] },
        { id: 'task-003-c', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], dependsOn: ['task-001-a'], writeScope: ['src/c.ts'] },
        { id: 'task-004-d', requirements: ['REQ-004'], acceptanceCriteria: ['AC-004'], dependsOn: ['task-002-b', 'task-003-c'], writeScope: ['src/d.ts'] },
      ],
      phases: [['task-001-a'], ['task-002-b', 'task-003-c'], ['task-004-d']],
    });
    const reports = join(directory, 'reports');
    await mkdir(reports, { recursive: true });
    await writeFile(join(reports, 'review-round-1.md'), '# Round 1\n');
    await writeFile(join(reports, 'review-round-2.md'), '# Round 2\n');
    await writeFile(join(reports, 'notes.md'), '# Notes\n');

    const report = (await planReport(directory)) as PlanReport;

    expect(report.task_count).toBe(4);
    expect(report.phase_count).toBe(3);
    expect(report.critical_path_length).toBe(3);
    expect(report.review_rounds).toBe(2);
    expect(report.status).toBe('unknown');
    expect(report.commit_count).toBeNull();
  });

  it('rejects a malformed implementation record with its exact error', async () => {
    const root = await temporary('ai-workflow-report-malformed-');
    const directory = await frozenPlan(root, true);
    const recordPath = await writeRecord(root, '.', '20260831-example', {
      plan_id: '20260831-example',
      status: 'failed',
      started_at: '2026-09-01T00:00:00.000Z',
    });
    const expected = `Malformed implementation record at ${recordPath}: field "status" must be "in-progress" or "completed"`;

    await expect(planReport(directory)).rejects.toMatchObject({ message: expected });
  });
});
