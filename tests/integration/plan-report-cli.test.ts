import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import {
  changedPaths,
  commitFile,
  frozenPlan,
  gitInit,
  snapshotTree,
  temporary,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
} from '../helpers.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;

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

interface PlanReport {
  plan_id: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  duration_seconds: number | 'unknown';
  status: string;
  task_count: number;
  phase_count: number;
  critical_path_length: number;
  review_rounds: number | 'unknown';
  commit_count: number | null;
  commit_count_reason: string | null;
  execution?: {
    phase: number | null;
    pending_tasks: { task: string; repo: string; repository_path: string; plan_path: string }[];
    awaiting_delivery: string[];
    blockers: string[];
    completed: boolean;
  };
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

describe('ai-workflow plan report', () => {
  it('prints an unstarted frozen plan without creating an implementation record', async () => {
    const root = await temporary('ai-workflow-report-cli-not-started-');
    const directory = await frozenPlan(root, true);

    const result = await runCli(['plan', 'report', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const report = JSON.parse(result.stdout) as PlanReport;
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
    expect(report.execution).toBeUndefined();
    await expect(access(implementationPath(root, '.', '20260831-example'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints a frozen plan without task documents instead of failing on the missing execution order', async () => {
    const root = await temporary('ai-workflow-report-cli-no-tasks-');
    const directory = await frozenPlan(root, false);

    const result = await runCli(['plan', 'report', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const report = JSON.parse(result.stdout) as PlanReport;
    expect(report.plan_id).toBe('20260831-example');
    expect(report.status).toBe('unknown');
    expect(report.task_count).toBe(0);
    expect(report.phase_count).toBe(0);
    expect(report.critical_path_length).toBe(0);
    expect(report.started_at).toBe('unknown');
    expect(report.completed_at).toBe('unknown');
    expect(report.commit_count).toBeNull();
    expect(typeof report.commit_count_reason).toBe('string');
  });

  it('prints an in-progress workspace plan with the execution projection', async () => {
    const root = await temporary('ai-workflow-report-cli-in-progress-');
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

    const result = await runCli(['plan', 'report', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const report = JSON.parse(result.stdout) as PlanReport;
    expect(report.started_at).toBe(startedAt);
    expect(report.completed_at).toBe('unknown');
    expect(report.duration_seconds).toBe('unknown');
    expect(report.status).toBe('in-progress');
    expect(report.commit_count).toBeNull();
    expect(report.execution).toBeDefined();
    expect(report.execution?.phase).toBe(1);
    expect(report.execution?.pending_tasks.map((task) => task.task)).toEqual(['task-001-app', 'task-002-lib']);
  });

  it('prints the real commit count for a completed workspace plan', async () => {
    const root = await temporary('ai-workflow-report-cli-completed-');
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

    const result = await runCli(['plan', 'report', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const report = JSON.parse(result.stdout) as PlanReport;
    expect(report.status).toBe('completed');
    expect(report.commit_count).toBe(3);
    expect(report.commit_count_reason).toBeNull();
    expect(report.duration_seconds).toBe(600);
  });

  it('rejects a malformed implementation record with an exact error and no stdout report', async () => {
    const root = await temporary('ai-workflow-report-cli-malformed-');
    const directory = await frozenPlan(root, true);
    const recordPath = await writeRecord(root, '.', '20260831-example', {
      plan_id: '20260831-example',
      status: 'failed',
      started_at: '2026-09-01T00:00:00.000Z',
    });

    const result = await runCli(['plan', 'report', '--plan', directory]);

    expect(result.code, outputOf(result)).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`ai-workflow: Malformed implementation record at ${recordPath}: field "status" must be "in-progress" or "completed"\n`);
  });

  it('writes no file and performs no Git mutation on a successful run', async () => {
    const root = await temporary('ai-workflow-report-cli-zero-writes-');
    await gitInit(root);
    const directory = await frozenPlan(root, true);
    const beforeTree = await snapshotTree(root);
    const beforeStatus = (await exec('git', ['status', '--porcelain'], { cwd: root })).stdout;
    const beforeHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout;

    const result = await runCli(['plan', 'report', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const report = JSON.parse(result.stdout) as PlanReport;
    expect(report.plan_id).toBe('20260831-example');
    const afterTree = await snapshotTree(root);
    expect(changedPaths(beforeTree, afterTree)).toEqual([]);
    const afterStatus = (await exec('git', ['status', '--porcelain'], { cwd: root })).stdout;
    const afterHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout;
    expect(afterStatus).toBe(beforeStatus);
    expect(afterHead).toBe(beforeHead);
  });
});
