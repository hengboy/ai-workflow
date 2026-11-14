import type { TaskDocument, TaskPhase } from './types.js';

/** Informational plan-size metrics shared by `plan validate` and `plan report`. */
export interface PlanMetrics {
  task_count: number;
  phase_count: number;
  parallel_width: number;
  critical_path_length: number;
  estimated_commit_count: number;
  estimated_delegation_count: number;
}

/** Count the tasks on the longest `depends_on` chain; a single task is one and no tasks is zero. */
function criticalPathLength(tasks: TaskDocument[]): number {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const visit = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const task = byId.get(id);
    if (task === undefined) return 0;
    let longestDependency = 0;
    for (const dependency of task.dependsOn) longestDependency = Math.max(longestDependency, visit(dependency));
    const length = longestDependency + 1;
    memo.set(id, length);
    return length;
  };
  let longest = 0;
  for (const task of tasks) longest = Math.max(longest, visit(task.id));
  return longest;
}

/**
 * Compute the informational plan cost metrics: task and phase counts, the widest schedule
 * phase, the longest dependency chain, and the estimated commits and delegations. A plan
 * without tasks estimates zero commits and zero delegations.
 */
export function computePlanMetrics(tasks: TaskDocument[], phases: TaskPhase[]): PlanMetrics {
  const taskCount = tasks.length;
  const phaseCount = phases.length;
  const parallelWidth = phases.reduce((widest, phase) => Math.max(widest, phase.parallel.length), 0);
  return {
    task_count: taskCount,
    phase_count: phaseCount,
    parallel_width: parallelWidth,
    critical_path_length: criticalPathLength(tasks),
    estimated_commit_count: taskCount === 0 ? 0 : taskCount + 1,
    estimated_delegation_count: taskCount === 0 ? 0 : 2 * taskCount + 3,
  };
}
