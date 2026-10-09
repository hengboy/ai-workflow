import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateWorkspaceManifest } from '../workflow/workspace.js';
import { classifySlice, computeSliceFiles, resolveWorkspacePlan, type ResolvedWorkspacePlan, type SliceFileState } from './distribute.js';
import { projectWorkspaceExecution, type ExecutionProjection } from './execution.js';

const RESERVED_ROOT = 'workspace';

export type ImplementationRecordState = 'missing' | 'in-progress' | 'completed';
export type SlicePresence = 'missing' | 'divergent' | 'present';

export interface StatusRepository {
  name: string;
  path: string;
  slice: SlicePresence;
  record: ImplementationRecordState;
  delivery_commit: string | null;
}

export interface StatusWorkspaceRootEntry {
  name: string;
  path: string;
  record: ImplementationRecordState;
  tasks_delivered: boolean;
  delivery_commit: string | null;
}

export interface StatusResult {
  valid: boolean;
  plan_id?: string;
  workspace_root?: string;
  order?: string[];
  repositories?: StatusRepository[];
  workspace_root_entry?: StatusWorkspaceRootEntry;
  next_repository?: string | null;
  ready_for_finalization?: boolean;
  execution?: ExecutionProjection;
  errors?: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fullCommit(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : null;
}

/** Read a matching implementation record; malformed, wrong-plan or unknown-status records report `missing`. */
async function readRecordState(directory: string, planId: string): Promise<{ state: ImplementationRecordState; commit: string | null; rootTasksCommit: string | null }> {
  const missing = { state: 'missing' as const, commit: null, rootTasksCommit: null };
  let source: string;
  try {
    source = await readFile(join(directory, 'implementation.yaml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    return missing;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return missing;
  const record = parsed as Record<string, unknown>;
  if (record.plan_id !== planId || (record.status !== 'in-progress' && record.status !== 'completed')) return missing;
  return {
    state: record.status,
    commit: record.status === 'completed' ? fullCommit(record.commit) : null,
    rootTasksCommit: fullCommit(record.root_tasks_commit),
  };
}

function slicePresence(states: Map<string, SliceFileState>): SlicePresence {
  let anyPresent = false;
  let allIdentical = true;
  for (const state of states.values()) {
    if (state !== 'missing') anyPresent = true;
    if (state !== 'identical') allIdentical = false;
  }
  if (!anyPresent) return 'missing';
  return allIdentical ? 'present' : 'divergent';
}

export async function workspaceStatus(planDirectory: string): Promise<StatusResult> {
  let resolved: ResolvedWorkspacePlan;
  try {
    resolved = await resolveWorkspacePlan(planDirectory);
  } catch (error) {
    return { valid: false, errors: [errorMessage(error)] };
  }

  const { root, plan, tasks, schedule, manifest } = resolved;
  if (manifest === undefined || manifest.role !== 'workspace') {
    return { valid: false, plan_id: plan.planId, errors: ['workspace status requires a workspace manifest (role "workspace")'] };
  }

  const validationErrors = validateWorkspaceManifest(manifest, plan, tasks, schedule);
  if (validationErrors.length > 0) {
    return { valid: false, plan_id: plan.planId, errors: validationErrors };
  }

  const taskRepositories = new Map(tasks.map((task) => [task.id, task.repo]));
  const order: string[] = [];
  for (const phase of schedule.phases) for (const id of phase.parallel) {
    const name = taskRepositories.get(id);
    if (name !== undefined && !order.includes(name)) order.push(name);
  }
  for (const repository of plan.workspaceRepos ?? []) {
    if (!order.includes(repository.name)) order.push(repository.name);
  }
  const repositories: StatusRepository[] = [];
  for (const name of order) {
    const repository = manifest.repositories.find((entry) => entry.name === name);
    if (repository === undefined || name === RESERVED_ROOT) continue;
    const sliceDirectory = join(root, repository.path, '.ai-workflow', 'plans', plan.planId);
    const expected = await computeSliceFiles(resolved, repository);
    const states = await classifySlice(sliceDirectory, expected);
    const record = await readRecordState(sliceDirectory, plan.planId);
    repositories.push({
      name: repository.name,
      path: repository.path,
      slice: slicePresence(states),
      record: record.state,
      delivery_commit: record.commit,
    });
  }

  const workspaceEntry = manifest.repositories.find((repository) => repository.name === RESERVED_ROOT);
  const workspaceRecord = await readRecordState(join(root, '.ai-workflow', 'plans', plan.planId), plan.planId);
  const hasRootTasks = tasks.some((task) => task.repo === RESERVED_ROOT);
  const rootDeliveryCommit = hasRootTasks ? workspaceRecord.rootTasksCommit ?? workspaceRecord.commit : null;
  const rootTasksDelivered = !hasRootTasks || rootDeliveryCommit !== null;
  const delivered = new Set(repositories
    .filter((repository) => repository.slice === 'present' && repository.record === 'completed' && repository.delivery_commit !== null)
    .map((repository) => repository.name));
  const nextRepository = order.find((name) => name === RESERVED_ROOT ? !rootTasksDelivered : !delivered.has(name)) ?? null;
  const result: StatusResult = {
    valid: true,
    plan_id: plan.planId,
    workspace_root: root,
    order,
    repositories,
    workspace_root_entry: {
      name: workspaceEntry?.name ?? RESERVED_ROOT,
      path: workspaceEntry?.path ?? '.',
      record: workspaceRecord.state,
      tasks_delivered: rootTasksDelivered,
      delivery_commit: rootDeliveryCommit,
    },
    next_repository: nextRepository,
    ready_for_finalization: rootTasksDelivered && delivered.size === repositories.length,
  };
  if (manifest.repositories.some((repository) => repository.name !== RESERVED_ROOT)) result.execution = await projectWorkspaceExecution(resolved);
  return result;
}
