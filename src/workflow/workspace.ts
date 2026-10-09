import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { PlanDocument, TaskDocument, TaskSchedule } from './types.js';

export interface WorkspaceRepository { name: string; path: string; dependsOn: string[]; requirements: string[]; acceptanceCriteria: string[] }
export interface WorkspaceManifest { planId: string; role: 'workspace' | 'slice'; repositories: WorkspaceRepository[] }

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }

function parseRepository(raw: unknown, path: string): WorkspaceRepository {
  if (!isRecord(raw)) throw new Error(`Invalid workspace manifest shape: ${path}`);
  const { name, path: repositoryPath, depends_on: dependsOn, requirements, acceptance_criteria: acceptanceCriteria } = raw;
  if (typeof name !== 'string' || typeof repositoryPath !== 'string' || !isStringArray(dependsOn) || !isStringArray(requirements) || !isStringArray(acceptanceCriteria)) {
    throw new Error(`Invalid workspace manifest shape: ${path}`);
  }
  return { name, path: repositoryPath, dependsOn, requirements, acceptanceCriteria };
}

export async function readWorkspaceManifest(directory: string): Promise<WorkspaceManifest | undefined> {
  const path = join(directory, 'workspace.yaml');
  let source: string;
  try { source = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try { parsed = parseYaml(source); } catch { throw new Error(`Malformed workspace manifest YAML: ${path}`); }
  if (!isRecord(parsed)) throw new Error(`Invalid workspace manifest shape: ${path}`);
  if (typeof parsed.plan_id !== 'string' || typeof parsed.role !== 'string' || !Array.isArray(parsed.repositories)) throw new Error(`Invalid workspace manifest shape: ${path}`);
  const repositories = parsed.repositories.map((raw) => parseRepository(raw, path));
  if (parsed.role !== 'workspace' && parsed.role !== 'slice') throw new Error(`Invalid workspace manifest role: ${parsed.role}`);
  return { planId: parsed.plan_id, role: parsed.role, repositories };
}

export function renderWorkspaceManifest(manifest: WorkspaceManifest): string {
  return stringifyYaml({
    plan_id: manifest.planId,
    role: manifest.role,
    repositories: manifest.repositories.map((repository) => ({
      name: repository.name,
      path: repository.path,
      depends_on: repository.dependsOn,
      requirements: repository.requirements,
      acceptance_criteria: repository.acceptanceCriteria,
    })),
  });
}

function setDifference(left: Iterable<string>, right: Set<string>): string[] {
  const seen = new Set<string>();
  const difference: string[] = [];
  for (const item of left) {
    if (right.has(item) || seen.has(item)) continue;
    seen.add(item);
    difference.push(item);
  }
  return difference;
}

function repositorySignatures(repositories: { name: string; path: string; dependsOn: string[] }[]): string[] {
  return repositories.map((repository) => `${repository.name}\u0000${repository.path}\u0000${[...repository.dependsOn].sort().join(',')}`).sort();
}

function subsetErrors(prefix: string, declared: string[], covered: string[]): string[] {
  const declaredSet = new Set(declared);
  const coveredSet = new Set(covered);
  const errors: string[] = [];
  const missing = setDifference(declared, coveredSet);
  const unexpected = setDifference(covered, declaredSet);
  if (missing.length) errors.push(`${prefix}: missing ${missing.join(', ')}`);
  if (unexpected.length) errors.push(`${prefix}: unexpected ${unexpected.join(', ')}`);
  return errors;
}

/**
 * Enforce that every task of a repository is scheduled strictly after every task of the
 * repositories it depends on. Shared by the manifest validation and the no-manifest
 * workspace check that `plan validate` runs from the plan's `workspace_repos` declaration.
 */
export function validateWorkspaceRepositoryOrder(repositories: { name: string; dependsOn: string[] }[], tasks: TaskDocument[], schedule: TaskSchedule): string[] {
  const errors: string[] = [];
  const tasksOf = (name: string): TaskDocument[] => tasks.filter((task) => task.repo === name);
  const phaseOf = new Map<string, number>();
  schedule.phases.forEach((phase, index) => phase.parallel.forEach((id) => phaseOf.set(id, index)));
  for (const repository of repositories) {
    for (const dependency of repository.dependsOn) {
      const dependencyTasks = tasksOf(dependency);
      for (const task of tasksOf(repository.name)) {
        const taskPhase = phaseOf.get(task.id) ?? -1;
        const violation = dependencyTasks.some((candidate) => (phaseOf.get(candidate.id) ?? -1) >= taskPhase);
        if (violation) errors.push(`Workspace repository order violation: task ${task.id} of repository "${repository.name}" must be scheduled after repository "${dependency}"`);
      }
    }
  }
  return errors;
}

export function validateWorkspaceManifest(manifest: WorkspaceManifest, plan: PlanDocument, tasks: TaskDocument[], schedule: TaskSchedule): string[] {
  const errors: string[] = [];
  const ROOT = 'workspace';
  if (manifest.planId !== plan.planId) errors.push(`Workspace manifest plan_id mismatch: ${manifest.planId}, expected ${plan.planId}`);
  const tasksOf = (name: string): TaskDocument[] => tasks.filter((task) => task.repo === name);
  const coveredRequirements = (name: string): string[] => tasksOf(name).flatMap((task) => task.requirements);
  const coveredAcceptanceCriteria = (name: string): string[] => tasksOf(name).flatMap((task) => task.acceptanceCriteria);

  if (manifest.role === 'slice') {
    if (manifest.repositories.length !== 1) {
      errors.push('Slice manifest must declare exactly one repository');
      return errors;
    }
    const repository = manifest.repositories[0] as WorkspaceRepository;
    for (const requirement of repository.requirements) if (!plan.requirements.includes(requirement)) errors.push(`Slice subset references unknown requirement: ${requirement}`);
    for (const criterion of repository.acceptanceCriteria) if (!plan.acceptanceCriteria.includes(criterion)) errors.push(`Slice subset references unknown acceptance criterion: ${criterion}`);
    for (const task of tasks) if (task.repo !== repository.name) errors.push(`Slice task ${task.id} belongs to repository "${task.repo}", expected "${repository.name}"`);
    const finalization = plan.workspaceFinalization;
    if (finalization) {
      const carries = [...repository.requirements, ...repository.acceptanceCriteria].some((id) => finalization.requirements.includes(id) || finalization.acceptanceCriteria.includes(id));
      if (carries) errors.push('Slice manifest must not carry workspace_finalization criteria');
    }
    errors.push(...subsetErrors('Slice requirements do not match the declared subset', repository.requirements, coveredRequirements(repository.name)));
    errors.push(...subsetErrors('Slice acceptance criteria do not match the declared subset', repository.acceptanceCriteria, coveredAcceptanceCriteria(repository.name)));
    return errors;
  }

  const declared = plan.workspaceRepos ?? [];
  const declaredSignatures = repositorySignatures(declared.map((repository) => ({ name: repository.name, path: repository.path, dependsOn: repository.depends_on })));
  if (declared.length !== manifest.repositories.length || declaredSignatures.join('\n') !== repositorySignatures(manifest.repositories).join('\n')) {
    errors.push('Workspace manifest repositories do not match the plan declaration');
  }

  const finalization = plan.workspaceFinalization;
  const finalizationRequirements = finalization?.requirements ?? [];
  const finalizationCriteria = finalization?.acceptanceCriteria ?? [];
  if (finalization) {
    for (const requirement of finalization.requirements) if (!plan.requirements.includes(requirement)) errors.push(`workspace_finalization references unknown requirement: ${requirement}`);
    for (const criterion of finalization.acceptanceCriteria) if (!plan.acceptanceCriteria.includes(criterion)) errors.push(`workspace_finalization references unknown acceptance criterion: ${criterion}`);
    for (const task of tasks) {
      for (const criterion of task.acceptanceCriteria) if (finalization.acceptanceCriteria.includes(criterion)) errors.push(`Finalization acceptance criterion ${criterion} is assigned to task ${task.id}`);
    }
  }

  if (tasks.length) {
    for (const repository of manifest.repositories) {
      if (repository.name === ROOT) continue;
      if (tasksOf(repository.name).length === 0) errors.push(`Participating child repository "${repository.name}" owns zero tasks`);
    }
  }

  for (const repository of manifest.repositories) {
    const isRoot = repository.name === ROOT;
    const expectedRequirements = [...coveredRequirements(repository.name), ...(isRoot ? finalizationRequirements : [])];
    const expectedCriteria = [...coveredAcceptanceCriteria(repository.name), ...(isRoot ? finalizationCriteria : [])];
    errors.push(...subsetErrors(`Repository "${repository.name}" requirements do not match its tasks`, repository.requirements, expectedRequirements));
    errors.push(...subsetErrors(`Repository "${repository.name}" acceptance criteria do not match its tasks`, repository.acceptanceCriteria, expectedCriteria));
  }
  if (tasks.length) {
    const coverageRequirements = new Set([...tasks.flatMap((task) => task.requirements), ...finalizationRequirements]);
    const coverageCriteria = new Set([...tasks.flatMap((task) => task.acceptanceCriteria), ...finalizationCriteria]);
    const reqMissing = plan.requirements.filter((requirement) => !coverageRequirements.has(requirement));
    const acMissing = plan.acceptanceCriteria.filter((criterion) => !coverageCriteria.has(criterion));
    if (reqMissing.length || acMissing.length) errors.push(`Frozen plan coverage is incomplete: missing ${[...reqMissing, ...acMissing].join(', ')}`);
  }
  errors.push(...validateWorkspaceRepositoryOrder(manifest.repositories, tasks, schedule));
  return errors;
}
