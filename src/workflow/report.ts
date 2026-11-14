import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseMarkdown } from '../utils/frontmatter.js';
import { readPlan, readTasks } from './parse.js';
import { computePlanMetrics } from './metrics.js';
import { readExecutionOrder } from './order.js';
import { readWorkspaceManifest } from './workspace.js';
import { commitCount } from '../workspace/git.js';
import { RESERVED_ROOT, implementationRecordPath, readWorkspaceRecord, type WorkspaceExecutionRecord } from '../workspace/record.js';
import { workspaceStatus } from '../workspace/status.js';
import type { ExecutionProjection } from '../workspace/execution.js';
import type { TaskSchedule } from './types.js';

const UNKNOWN = 'unknown' as const;

/** One participating repository of a plan and the repository path recorded for it. */
interface ReportRepository {
  name: string;
  path: string;
}

/** The stable plan-report value returned by `planReport`. */
export interface PlanReport {
  plan_id: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  duration_seconds: number | typeof UNKNOWN;
  status: 'unknown' | 'in-progress' | 'completed';
  task_count: number;
  phase_count: number;
  critical_path_length: number;
  review_rounds: number | typeof UNKNOWN;
  commit_count: number | null;
  commit_count_reason: string | null;
  execution?: ExecutionProjection;
}

/** The plan directory shape `<root>/.ai-workflow/plans/<planId>` resolves to its workspace root. */
function workspaceRootOf(planDirectory: string): string {
  return dirname(dirname(dirname(planDirectory)));
}

/** The earliest recorded start and, only for a completed plan, the latest recorded completion. */
function aggregateTimestamps(records: WorkspaceExecutionRecord[]): { startedAt: string; completedAt: string } {
  let earliest: { time: number; value: string } | undefined;
  let latest: { time: number; value: string } | undefined;
  for (const record of records) {
    const started = Date.parse(record.started_at);
    if (!Number.isNaN(started) && (earliest === undefined || started < earliest.time)) earliest = { time: started, value: record.started_at };
    if (record.completed_at !== undefined) {
      const completed = Date.parse(record.completed_at);
      if (!Number.isNaN(completed) && (latest === undefined || completed > latest.time)) latest = { time: completed, value: record.completed_at };
    }
  }
  return { startedAt: earliest?.value ?? UNKNOWN, completedAt: latest?.value ?? UNKNOWN };
}

/** Count the review-round files directly under `reports/`; `unknown` when none match or it is absent. */
async function reviewRounds(planDirectory: string): Promise<number | typeof UNKNOWN> {
  let entries;
  try {
    entries = await readdir(join(planDirectory, 'reports'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return UNKNOWN;
    throw error;
  }
  const rounds = entries.filter((entry) => entry.isFile() && entry.name.startsWith('review-round')).length;
  return rounds > 0 ? rounds : UNKNOWN;
}

function wholeSeconds(startedAt: string, completedAt: string): number | typeof UNKNOWN {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (Number.isNaN(started) || Number.isNaN(completed) || completed < started) return UNKNOWN;
  return Math.floor((completed - started) / 1000);
}

/**
 * Report a plan's lifecycle and execution from its frozen sources and implementation records.
 * Every field that is not recorded stays `unknown`; a commit count is derived only from complete
 * workspace execution anchors, and nothing is written.
 */
export async function planReport(planDirectoryInput: string): Promise<PlanReport> {
  const planDirectory = resolve(planDirectoryInput);
  const root = workspaceRootOf(planDirectory);
  const plan = await readPlan(planDirectory);
  const tasks = await readTasks(planDirectory);
  // A frozen plan may predate plan-to-tasks, so an absent schedule with no task documents is not an error.
  const schedule: TaskSchedule = tasks.length === 0 ? { planId: plan.planId, phases: [] } : await readExecutionOrder(planDirectory, plan.planId, tasks);
  const manifest = await readWorkspaceManifest(planDirectory);
  const metrics = computePlanMetrics(tasks, schedule.phases);

  const planDocument = parseMarkdown(await readFile(join(planDirectory, 'plan.md'), 'utf8'));
  const declaredCreatedAt = planDocument.attributes.created_at;
  const createdAt = typeof declaredCreatedAt === 'string' && declaredCreatedAt.length > 0 ? declaredCreatedAt : UNKNOWN;

  const isWorkspace = plan.workspaceRepos !== undefined || manifest?.role === 'workspace';
  const repositories: ReportRepository[] = manifest?.role === 'workspace'
    ? manifest.repositories.map((repository) => ({ name: repository.name, path: repository.path }))
    : plan.workspaceRepos !== undefined
      ? plan.workspaceRepos.map((repository) => ({ name: repository.name, path: repository.path }))
      : [{ name: RESERVED_ROOT, path: '.' }];

  const records = new Map<string, WorkspaceExecutionRecord | undefined>();
  for (const repository of repositories) {
    const recordPath = implementationRecordPath(root, repository.path, plan.planId);
    records.set(repository.name, await readWorkspaceRecord(recordPath, plan.planId));
  }

  const hasTasks = (name: string): boolean => tasks.some((task) => task.repo === name);
  const required = (repository: ReportRepository): boolean => !isWorkspace || repository.name !== RESERVED_ROOT || hasTasks(repository.name);
  const requiredRepositories = repositories.filter(required);
  const presentRecords = [...records.values()].filter((record): record is WorkspaceExecutionRecord => record !== undefined);

  let status: PlanReport['status'] = 'unknown';
  if (presentRecords.length > 0) {
    // A root-only plan has no required repository, so its status comes from the records that exist
    // rather than from the vacuous truth of `[].every(...)`.
    status = requiredRepositories.length === 0
      ? (presentRecords.every((record) => record.status === 'completed') ? 'completed' : 'in-progress')
      : (requiredRepositories.every((repository) => records.get(repository.name)?.status === 'completed') ? 'completed' : 'in-progress');
  }

  // A root-only plan has no required repository, so a completed status takes its timestamps from
  // the records that exist rather than from the empty required set.
  const timestamps = aggregateTimestamps(status === 'completed' && requiredRepositories.length > 0 ? requiredRepositories.flatMap((repository) => {
    const record = records.get(repository.name);
    return record === undefined ? [] : [record];
  }) : presentRecords);
  const completedAt = status === 'completed'
    ? (requiredRepositories.every((repository) => records.get(repository.name)?.completed_at !== undefined) ? timestamps.completedAt : UNKNOWN)
    : UNKNOWN;

  let commitTotal: number | null = null;
  let commitReason: string | null = null;
  const ranges: { repository: string; base: string; final: string }[] = [];
  for (const repository of requiredRepositories) {
    const record = records.get(repository.name);
    if (record === undefined) {
      commitReason = `Missing implementation record or execution anchor for repository "${repository.name}"`;
      break;
    }
    const base = record.execution?.base_commit;
    const final = record.commit ?? record.root_tasks_commit;
    if (base === undefined) {
      commitReason = `Repository "${repository.name}" has no workspace execution anchor with base_commit`;
      break;
    }
    if (final === undefined) {
      commitReason = `Repository "${repository.name}" has no final commit recorded`;
      break;
    }
    ranges.push({ repository: join(root, repository.path), base, final });
  }
  if (commitReason === null && requiredRepositories.length === 0) {
    commitReason = 'No required repository has an implementation record or execution anchor to count commits';
  }
  if (commitReason === null) {
    let total = 0;
    for (const range of ranges) {
      const counted = await commitCount(range.repository, range.base, range.final);
      if (counted === undefined) {
        commitReason = `Could not count commits for repository "${range.repository}" in range ${range.base}..${range.final}`;
        break;
      }
      total += counted;
    }
    if (commitReason === null) commitTotal = total;
  }

  const report: PlanReport = {
    plan_id: plan.planId,
    created_at: createdAt,
    started_at: status === 'unknown' ? UNKNOWN : timestamps.startedAt,
    completed_at: completedAt,
    duration_seconds: status !== 'unknown' && timestamps.startedAt !== UNKNOWN && completedAt !== UNKNOWN ? wholeSeconds(timestamps.startedAt, completedAt) : UNKNOWN,
    status,
    task_count: metrics.task_count,
    phase_count: metrics.phase_count,
    critical_path_length: metrics.critical_path_length,
    review_rounds: await reviewRounds(planDirectory),
    commit_count: commitTotal,
    commit_count_reason: commitReason,
  };

  if (isWorkspace) {
    const workspace = await workspaceStatus(planDirectory);
    if (workspace.valid && workspace.execution !== undefined) report.execution = workspace.execution;
  }
  return report;
}
