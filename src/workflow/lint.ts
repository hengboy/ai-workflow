import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdown } from '../utils/frontmatter.js';
import { computePlanMetrics } from './metrics.js';
import { readExecutionOrder } from './order.js';
import { readPlan, readTasks } from './parse.js';
import type { PlanDocument, TaskDocument, TaskPhase } from './types.js';

/** Task surfaces that make a phase carry implementation work rather than verification. */
const implementationSurfaces = new Set(['backend', 'frontend', 'cross-stack']);

/**
 * Graph-validation failures that advisory lint tolerates: a frozen plan can still be linted
 * read-only when its dependency graph is incomplete or cyclic.
 */
function isDependencyGraphError(error: unknown): boolean {
  return error instanceof Error && /^(Unknown task dependency|Task dependency cycle):/.test(error.message);
}

/** Read task frontmatter without dependency-graph validation, used only after that validation fails. */
async function readLintTasks(directory: string): Promise<TaskDocument[]> {
  const taskDir = join(directory, 'tasks');
  const names = await readdir(taskDir).catch(() => [] as string[]);
  const tasks: TaskDocument[] = [];
  for (const name of names.filter((item) => item.endsWith('.md') && !item.endsWith('.zh.md')).sort()) {
    const path = join(taskDir, name);
    const attributes = parseMarkdown(await readFile(path, 'utf8')).attributes;
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    tasks.push({
      id: text(attributes.id),
      requirements: list(attributes.requirements),
      acceptanceCriteria: list(attributes.acceptance_criteria),
      dependsOn: list(attributes.depends_on),
      surface: text(attributes.surface),
      readScope: list(attributes.read_scope),
      writeScope: list(attributes.write_scope),
      testCommands: list(attributes.test_commands),
      path,
    });
  }
  return tasks;
}

/** Task documents for advisory lint, degrading leniently only for an unknown or cyclic dependency. */
async function readLintableTasks(directory: string): Promise<TaskDocument[]> {
  try {
    return await readTasks(directory);
  } catch (error) {
    if (!isDependencyGraphError(error)) throw error;
    return readLintTasks(directory);
  }
}

export interface PlanLintWarning {
  code: string;
  path: string;
  message: string;
}

export interface PlanLintResult {
  valid: true;
  plan_id: string;
  warnings: PlanLintWarning[];
}

/** A level-two Markdown section body, ending at the next level-two heading. */
function sectionBody(body: string, title: string): string | undefined {
  const heading = new RegExp(`^##\\s+${title}\\s*$`, 'm').exec(body);
  if (!heading) return undefined;
  const rest = body.slice((heading.index ?? 0) + heading[0].length);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Rows of the first Markdown table in a section, with the delimiter row removed. */
function tableRows(section: string | undefined): string[][] {
  if (section === undefined) return [];
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

/** Acceptance criteria headings and their bounded bodies. */
function acceptanceCriteriaBodies(body: string): { id: string; content: string }[] {
  const matches = [...body.matchAll(/^###?\s*(AC-\d+)\b[^\n]*$/gm)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]?.index ?? body.length : body.length;
    return { id: match[1] ?? '', content: body.slice(start, end) };
  });
}

function hasScenario(content: string): boolean {
  return /\bGiven\b/.test(content) && /\bWhen\b/.test(content) && /\bThen\b/.test(content);
}

function writeScopeTooWide(scope: string[]): boolean {
  if (scope.length > 5) return true;
  return scope.some((path) => scope.some((other) => other !== path && other.startsWith(`${path}/`)));
}

/**
 * Topological depth groups derived from `depends_on`, with unknown dependency IDs ignored.
 * A dependency cycle has no grouping, so the caller omits schedule warnings instead of throwing.
 */
function dependencyPhases(tasks: TaskDocument[]): TaskPhase[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number | undefined => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return undefined;
    visiting.add(id);
    let depth = 0;
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const dependencyDepth = depthOf(dependency);
      if (dependencyDepth === undefined) return undefined;
      depth = Math.max(depth, dependencyDepth + 1);
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  const groups = new Map<number, string[]>();
  for (const task of tasks) {
    const depth = depthOf(task.id);
    if (depth === undefined) return undefined;
    const group = groups.get(depth) ?? [];
    group.push(task.id);
    groups.set(depth, group);
  }
  return [...groups.keys()].sort((left, right) => left - right).map((depth) => ({ parallel: groups.get(depth) ?? [] }));
}

/** The frozen execution order when it is valid, otherwise a read-only `depends_on` depth grouping. */
async function lintPhases(directory: string, planId: string, tasks: TaskDocument[]): Promise<TaskPhase[] | undefined> {
  try {
    return (await readExecutionOrder(directory, planId, tasks)).phases;
  } catch {
    return dependencyPhases(tasks);
  }
}

/** 1-based numbers of phases that run parallel implementation without later cross-task verification. */
function uncoveredParallelPhases(tasks: TaskDocument[], phases: TaskPhase[]): number[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const uncovered: number[] = [];
  phases.forEach((phase, index) => {
    const implementation = new Set(phase.parallel.filter((id) => implementationSurfaces.has(byId.get(id)?.surface ?? '')));
    if (implementation.size < 2) return;
    const covered = phases.slice(index + 1).some((later) =>
      later.parallel.some((id) => {
        const candidate = byId.get(id);
        return candidate?.surface === 'test'
          && candidate.dependsOn.filter((dependency) => implementation.has(dependency)).length >= 2;
      }),
    );
    if (!covered) uncovered.push(index + 1);
  });
  return uncovered;
}

/**
 * Lint a frozen plan and its optional tasks, returning stable advisory warnings about
 * requirement and acceptance form. The result never authorizes a workflow phase and the
 * function writes no file.
 */
export async function lintPlan(directory: string): Promise<PlanLintResult> {
  let document: PlanDocument;
  let tasks: TaskDocument[];
  let specSource: string;
  let planSource: string;
  try {
    document = await readPlan(directory);
    tasks = await readLintableTasks(directory);
    [specSource, planSource] = await Promise.all([
      readFile(join(directory, 'spec.md'), 'utf8'),
      readFile(join(directory, 'plan.md'), 'utf8'),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid frozen plan at ${directory}: ${message}`);
  }

  const specPath = join(directory, 'spec.md');
  const planPath = join(directory, 'plan.md');
  const specBody = parseMarkdown(specSource).body;
  const planBody = parseMarkdown(planSource).body;
  const warnings: PlanLintWarning[] = [];

  const coverage = tableRows(sectionBody(planBody, 'Requirement coverage'))
    .filter((cells) => /^REQ-\d+$/.test(cells[0] ?? ''))
    .map((cells) => ({ requirement: cells[0] ?? '', acceptance: (cells[1] ?? '').match(/AC-\d+/g) ?? [] }));
  for (const requirement of document.requirements) {
    if (!coverage.some((row) => row.requirement === requirement && row.acceptance.length > 0)) {
      warnings.push({
        code: 'requirement-without-acceptance-criterion',
        path: specPath,
        message: `${requirement} has no acceptance criterion in the requirement coverage table`,
      });
    }
  }

  for (const criterion of acceptanceCriteriaBodies(specBody)) {
    if (!hasScenario(criterion.content)) {
      warnings.push({
        code: 'acceptance-criterion-missing-given-when-then',
        path: specPath,
        message: `${criterion.id} does not state a Given/When/Then scenario`,
      });
    }
  }

  const nonGoals = sectionBody(specBody, 'Non-goals');
  if (nonGoals === undefined || nonGoals.trim().length === 0) {
    warnings.push({ code: 'missing-non-goals', path: specPath, message: 'spec.md has no non-goals content' });
  }

  if (!/^\s*[-*]\s+Boundary\b/m.test(specBody)) {
    warnings.push({ code: 'missing-boundary', path: specPath, message: 'spec.md states no boundary condition' });
  }
  if (!/^\s*[-*]\s+Counterexample\b/m.test(specBody)) {
    warnings.push({ code: 'missing-counterexample', path: specPath, message: 'spec.md states no counterexample' });
  }

  const verification = tableRows(sectionBody(specBody, 'Verification layers and RED criteria'))
    .flatMap((cells) => (cells[0] ?? '').match(/REQ-\d+/g) ?? []);
  for (const requirement of document.requirements) {
    if (!verification.includes(requirement)) {
      warnings.push({
        code: 'missing-verification-layer',
        path: specPath,
        message: `${requirement} has no row in the verification layers table`,
      });
    }
  }

  for (const task of tasks) {
    if (task.testCommands.length === 0) {
      warnings.push({ code: 'task-missing-test-command', path: task.path, message: `${task.id} declares no test command` });
    }
    if (writeScopeTooWide(task.writeScope)) {
      warnings.push({ code: 'task-write-scope-too-wide', path: task.path, message: `${task.id} writes to a wide or overlapping scope` });
    }
  }

  if (tasks.length >= 6 && tasks.every((task) => task.writeScope.length <= 1)) {
    warnings.push({
      code: 'task-over-split',
      path: planPath,
      message: `${tasks.length} tasks each touch at most one write path; the split looks finer than the work requires`,
    });
  }

  if (tasks.length > 0) {
    const phases = await lintPhases(directory, document.planId, tasks);
    if (phases !== undefined) {
      const metrics = computePlanMetrics(tasks, phases);
      if (tasks.length >= 3 && metrics.parallel_width === 1 && metrics.critical_path_ratio >= 0.8) {
        warnings.push({
          code: 'plan-schedule-serial',
          path: planPath,
          message: `${tasks.length} tasks run one at a time across ${metrics.phase_count} phases; the schedule leaves no parallel slack`,
        });
      }
      const uncovered = uncoveredParallelPhases(tasks, phases);
      if (uncovered.length > 0) {
        warnings.push({
          code: 'parallel-tasks-without-integration-verify',
          path: planPath,
          message: `parallel implementation phases ${uncovered.join(', ')} lack a later test task depending on at least two of their implementation tasks`,
        });
      }
    }
  }

  warnings.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return { valid: true, plan_id: document.planId, warnings };
}
