import { executionPaths } from './paths.js';
import { appendEvent, readRun, writeRun } from './store.js';
import { readExecutionConfig } from './config.js';
import { cancelRun, completeRun, failRun, pauseRun, recordFailure, recordTask, startRun } from './manager.js';
import { resumeRun } from './recovery.js';
import {
  executionAnalytics,
  executionEvents,
  executionHistory,
  executionShow,
  executionStatus,
  type QueryScope,
} from './report.js';
import type { FailureCategory } from './types.js';
import { FAILURE_CATEGORIES } from './types.js';

/** A printed command body together with the process exit code it requires. */
export interface ExecutionCommandOutcome {
  body: Record<string, unknown>;
  exitCode: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refusal(error: unknown): ExecutionCommandOutcome {
  return { body: { valid: false, error: errorMessage(error) }, exitCode: 1 };
}

async function success(build: () => Promise<Record<string, unknown>>): Promise<ExecutionCommandOutcome> {
  try {
    return { body: await build(), exitCode: 0 };
  } catch (error) {
    return refusal(error);
  }
}

export interface StartExecutionInput {
  plan: string;
  repository?: string;
}

/** Start or adopt one repository run and optionally bind its repository name. */
export async function startExecutionCommand(input: StartExecutionInput): Promise<ExecutionCommandOutcome> {
  return await success(async () => {
    const result = await startRun({ planDirectory: input.plan });
    let run = result.run;
    if (input.repository !== undefined) {
      run = { ...run, repository: input.repository };
      await writeRun(executionPaths(input.plan), run);
    }
    return {
      valid: true,
      plan_id: run.plan_id,
      plan_digest: run.plan_digest,
      run_id: run.run_id,
      status: run.status,
      phase: run.phase ?? null,
      tasks: result.tasks.map((task) => task.id),
      adopted: result.adopted,
      warnings: result.warnings,
    };
  });
}

export interface TaskExecutionInput {
  plan: string;
  task: string;
  commit?: string;
  head?: string;
}

/** Record one completed split task and report any next-phase tasks it opened. */
export async function taskExecutionCommand(input: TaskExecutionInput): Promise<ExecutionCommandOutcome> {
  return await success(async () => {
    const result = await recordTask({
      planDirectory: input.plan,
      taskId: input.task,
      ...(input.commit === undefined ? {} : { commit: input.commit }),
      ...(input.head === undefined ? {} : { head: input.head }),
    });
    return {
      valid: true,
      plan_id: result.run.plan_id,
      run_id: result.run.run_id,
      status: result.run.status,
      phase: result.run.phase ?? null,
      task_id: input.task,
      task_status: result.run.tasks?.[input.task]?.status ?? null,
      idempotent: result.idempotent,
      opened_phase: result.openedPhase,
      warnings: result.warnings,
    };
  });
}

export interface CompleteExecutionInput {
  plan: string;
  commit: string;
  validation?: string;
  review?: string;
}

/**
 * Complete a running run. Optional validation and review results are recorded before the
 * canonical completion event so their order stays stable in the event stream.
 */
export async function completeExecutionCommand(input: CompleteExecutionInput): Promise<ExecutionCommandOutcome> {
  return await success(async () => {
    const paths = executionPaths(input.plan);
    const warnings: string[] = [];
    let existing;
    try {
      existing = await readRun(paths);
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && existing.status !== 'COMPLETED') {
      const config = readExecutionConfig();
      if (input.validation !== undefined) {
        try {
          await appendEvent(paths, {
            run_id: existing.run_id,
            plan_id: existing.plan_id,
            type: 'validation.completed',
            payload: { result: input.validation },
          }, config);
        } catch (error) {
          warnings.push(`Unable to record validation.completed: ${errorMessage(error)}`);
        }
      }
      if (input.review !== undefined) {
        try {
          await appendEvent(paths, {
            run_id: existing.run_id,
            plan_id: existing.plan_id,
            type: 'review.completed',
            payload: { result: input.review },
          }, config);
        } catch (error) {
          warnings.push(`Unable to record review.completed: ${errorMessage(error)}`);
        }
      }
    }

    const result = await completeRun({ planDirectory: input.plan, commit: input.commit });
    return {
      valid: true,
      plan_id: result.run.plan_id,
      run_id: result.run.run_id,
      status: result.run.status,
      commit: input.commit,
      recovered: result.recovered,
      warnings: [...warnings, ...result.warnings],
    };
  });
}

export interface PauseExecutionInput {
  plan: string;
  summary?: string;
}

/** Pause a running run, record the interruption and release the lock. */
export async function pauseExecutionCommand(input: PauseExecutionInput): Promise<ExecutionCommandOutcome> {
  return await success(async () => {
    const result = await pauseRun({
      planDirectory: input.plan,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    });
    return { valid: true, plan_id: result.run.plan_id, run_id: result.run.run_id, status: result.run.status, warnings: result.warnings };
  });
}

export interface CancelExecutionInput {
  plan: string;
  summary?: string;
}

/** Cancel a non-terminal run and release its lock. */
export async function cancelExecutionCommand(input: CancelExecutionInput): Promise<ExecutionCommandOutcome> {
  return await success(async () => {
    const result = await cancelRun({
      planDirectory: input.plan,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    });
    return { valid: true, plan_id: result.run.plan_id, run_id: result.run.run_id, status: result.run.status, warnings: result.warnings };
  });
}

export interface FailureExecutionInput {
  plan: string;
  category: string;
  summary?: string;
  retryAfter?: string;
  terminal?: boolean;
  task?: string;
}

/**
 * Record one failure attempt. A retry action reports exit 2 and its bounded delay, a pause or repair
 * reports exit 0, and `--terminal` fails the run outright.
 */
export async function failureExecutionCommand(input: FailureExecutionInput): Promise<ExecutionCommandOutcome> {
  try {
    if (!FAILURE_CATEGORIES.includes(input.category as FailureCategory)) {
      throw new Error(`Unknown failure category: ${input.category}`);
    }
    const category = input.category as FailureCategory;
    const summary = input.summary;

    if (input.terminal === true) {
      const result = await failRun({
        planDirectory: input.plan,
        category,
        ...(summary === undefined ? {} : { summary }),
      });
      return {
        body: {
          valid: true,
          plan_id: result.run.plan_id,
          run_id: result.run.run_id,
          category,
          action: 'terminal',
          status: result.run.status,
          failure_count: result.run.failure_count,
          warnings: result.warnings,
        },
        exitCode: 0,
      };
    }

    let retryAfter: number | undefined;
    if (input.retryAfter !== undefined) {
      const parsed = Number(input.retryAfter);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid retry delay: ${input.retryAfter}`);
      retryAfter = parsed;
    }

    const result = await recordFailure({
      planDirectory: input.plan,
      category,
      ...(summary === undefined ? {} : { summary }),
      ...(input.task === undefined ? {} : { taskId: input.task }),
    });
    const delay = result.action === 'retry' && retryAfter !== undefined ? retryAfter : result.retryDelaySeconds;
    const body: Record<string, unknown> = {
      valid: true,
      plan_id: result.run.plan_id,
      run_id: result.run.run_id,
      category: result.category,
      action: result.action,
      status: result.run.status,
      failure_count: result.failureCount,
      warnings: result.warnings,
    };
    if (delay !== undefined) body.retry_delay_seconds = delay;
    return { body, exitCode: result.action === 'retry' ? 2 : 0 };
  } catch (error) {
    return refusal(error);
  }
}

export interface ResumeExecutionInput {
  plan?: string;
  project?: string;
  repository?: string;
}

/** Resolve and validate an explicit resume request, printing the bounded recovery packet. */
export async function resumeExecutionCommand(input: ResumeExecutionInput): Promise<ExecutionCommandOutcome> {
  const result = await resumeRun({
    ...(input.plan === undefined ? {} : { planDirectory: input.plan }),
    ...(input.project === undefined ? {} : { projectRoot: input.project }),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
  });
  return { body: { ...result.packet }, exitCode: result.exitCode };
}

async function query(build: () => Promise<Record<string, unknown>>): Promise<ExecutionCommandOutcome> {
  try {
    return { body: await build(), exitCode: 0 };
  } catch (error) {
    return refusal(error);
  }
}

/** Read-only project or plan status. */
export async function statusExecutionCommand(scope: QueryScope): Promise<ExecutionCommandOutcome> {
  return await query(async () => ({ ...(await executionStatus(scope)) }));
}

/** Read-only single-run inspection. */
export async function showExecutionCommand(scope: QueryScope): Promise<ExecutionCommandOutcome> {
  return await query(async () => ({ ...(await executionShow(scope)) }));
}

/** Read-only bounded event tail. */
export async function eventsExecutionCommand(scope: QueryScope & { limit?: string }): Promise<ExecutionCommandOutcome> {
  return await query(async () => ({ ...(await executionEvents(scope)) }));
}

/** Read-only per-run history. */
export async function historyExecutionCommand(scope: QueryScope): Promise<ExecutionCommandOutcome> {
  return await query(async () => ({ ...(await executionHistory(scope)) }));
}

/** Read-only analytics derived from stored run and event data. */
export async function analyticsExecutionCommand(scope: QueryScope): Promise<ExecutionCommandOutcome> {
  return await query(async () => ({ ...(await executionAnalytics(scope)) }));
}
