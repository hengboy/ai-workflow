import { describe, expect, it } from 'vitest';
import { computePlanMetrics } from '../../src/workflow/metrics.js';
import type { TaskDocument, TaskPhase } from '../../src/workflow/types.js';

/**
 * The stable plan-metrics contract exercised here:
 * - `task_count` and `critical_path_length` come from the task documents and their `depends_on` graph.
 * - `phase_count` and `parallel_width` come from the frozen schedule phases, where width is the largest phase.
 * - `estimated_commit_count` is `task_count + 1` and `estimated_delegation_count` is
 *   `2 * task_count + 3`; a plan without tasks reports zero for both estimates.
 */
interface PlanMetrics {
  task_count: number;
  phase_count: number;
  parallel_width: number;
  critical_path_length: number;
  estimated_commit_count: number;
  estimated_delegation_count: number;
}

function task(id: string, dependsOn: string[] = []): TaskDocument {
  return {
    id,
    requirements: ['REQ-001'],
    acceptanceCriteria: ['AC-001'],
    dependsOn,
    surface: 'backend',
    readScope: ['MEMORY.md'],
    writeScope: [`src/${id}.ts`],
    testCommands: ['pnpm test'],
    path: `.ai-workflow/plans/20260831-example/tasks/${id}.md`,
  };
}

function phases(...parallel: string[][]): TaskPhase[] {
  return parallel.map((ids) => ({ parallel: ids }));
}

describe('computePlanMetrics', () => {
  it('reports zero cost for a frozen plan without task documents', () => {
    const metrics = computePlanMetrics([], []) as PlanMetrics;

    expect(metrics).toEqual({
      task_count: 0,
      phase_count: 0,
      parallel_width: 0,
      critical_path_length: 0,
      estimated_commit_count: 0,
      estimated_delegation_count: 0,
    });
  });

  it('reports counts, maximum phase width and the longest dependency chain for a known split graph', () => {
    const tasks = [
      task('task-001-a'),
      task('task-002-b', ['task-001-a']),
      task('task-003-c', ['task-001-a']),
      task('task-004-d', ['task-002-b', 'task-003-c']),
    ];
    const schedule = phases(['task-001-a'], ['task-002-b', 'task-003-c'], ['task-004-d']);

    const metrics = computePlanMetrics(tasks, schedule) as PlanMetrics;

    expect(metrics).toEqual({
      task_count: 4,
      phase_count: 3,
      parallel_width: 2,
      critical_path_length: 3,
      estimated_commit_count: 5,
      estimated_delegation_count: 11,
    });
    expect(metrics.estimated_commit_count).toBe(tasks.length + 1);
    expect(metrics.estimated_delegation_count).toBe(2 * tasks.length + 3);
  });

  it('keeps the critical path on dependencies rather than on phases', () => {
    const tasks = [task('task-001-a'), task('task-002-b'), task('task-003-c'), task('task-004-d', ['task-001-a'])];
    const schedule = phases(['task-001-a', 'task-002-b', 'task-003-c'], ['task-004-d']);

    const metrics = computePlanMetrics(tasks, schedule) as PlanMetrics;

    expect(metrics).toEqual({
      task_count: 4,
      phase_count: 2,
      parallel_width: 3,
      critical_path_length: 2,
      estimated_commit_count: 5,
      estimated_delegation_count: 11,
    });
  });
});
