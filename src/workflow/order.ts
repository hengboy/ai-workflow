import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { scopesOverlap } from '../utils/paths.js';
import { normalizeProjectPaths } from './read-scope.js';
import type { TaskDocument, TaskPhase, TaskSchedule } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export async function readExecutionOrder(directory: string, planId: string, tasks: TaskDocument[]): Promise<TaskSchedule> {
  const path = join(directory, 'tasks', 'execution-order.yaml');
  let source: string;
  try { source = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Missing execution order: ${path}`);
    throw error;
  }
  let parsed: unknown;
  try { parsed = parse(source); } catch { throw new Error(`Malformed execution order YAML: ${path}`); }
  if (!isRecord(parsed)) throw new Error(`Invalid execution order shape: ${path}`);
  const declaredPlanId = parsed.plan_id;
  const rawPhases = parsed.phases;
  if (typeof declaredPlanId !== 'string' || !Array.isArray(rawPhases) || rawPhases.length === 0) throw new Error(`Invalid execution order shape: ${path}`);
  const phases: TaskPhase[] = rawPhases.map((rawPhase: unknown) => {
    if (!isRecord(rawPhase) || !Array.isArray(rawPhase.parallel) || rawPhase.parallel.length === 0) throw new Error(`Invalid execution order shape: ${path}`);
    const parallel = rawPhase.parallel.map((id: unknown) => { if (typeof id !== 'string') throw new Error(`Invalid execution order shape: ${path}`); return id; });
    return { parallel };
  });
  if (declaredPlanId !== planId) throw new Error(`Execution order plan_id mismatch: declared ${declaredPlanId}, expected ${planId}`);
  const taskIds = new Set(tasks.map((task) => task.id));
  const scheduled = new Set<string>();
  for (const phase of phases) for (const id of phase.parallel) {
    if (!taskIds.has(id)) throw new Error(`Unknown task in execution order: ${id}`);
    if (scheduled.has(id)) throw new Error(`Duplicate task in execution order: ${id}`);
    scheduled.add(id);
  }
  for (const task of tasks) if (!scheduled.has(task.id)) throw new Error(`Task missing from execution order: ${task.id}`);
  const phaseOf = new Map<string, number>();
  phases.forEach((phase, index) => phase.parallel.forEach((id) => phaseOf.set(id, index)));
  for (const task of tasks) {
    const taskPhase = phaseOf.get(task.id) ?? -1;
    for (const dependency of task.dependsOn) {
      const dependencyPhase = phaseOf.get(dependency) ?? -1;
      if (dependencyPhase === taskPhase) throw new Error(`Dependency in the same phase: ${task.id} -> ${dependency}`);
      if (dependencyPhase > taskPhase) throw new Error(`Dependency in a later phase: ${task.id} -> ${dependency}`);
    }
  }
  phases.forEach((phase, index) => {
    const scopes: string[][] = [];
    for (const id of phase.parallel) {
      const task = tasks.find((item) => item.id === id);
      if (task) scopes.push(normalizeProjectPaths(task.writeScope).paths);
    }
    for (let later = 1; later < scopes.length; later += 1) {
      const laterScope = scopes[later] ?? [];
      for (let earlier = 0; earlier < later; earlier += 1) {
        const earlierScope = scopes[earlier] ?? [];
        if (!scopesOverlap(laterScope, earlierScope)) continue;
        const path = laterScope.find((candidate) => scopesOverlap([candidate], earlierScope));
        throw new Error(`Overlapping write scope in phase ${index + 1}: ${path}`);
      }
    }
  });
  return { planId, phases };
}
