import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { atomicWrite } from '../utils/fs.js';
import { readSubmodules } from '../context/submodules.js';
import { readPlan, readTasks } from '../workflow/parse.js';
import { readExecutionOrder } from '../workflow/order.js';
import {
  readWorkspaceManifest,
  renderWorkspaceManifest,
  validateWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceRepository,
} from '../workflow/workspace.js';
import type { PlanDocument, TaskDocument, TaskSchedule } from '../workflow/types.js';
import { repositoryPreconditionErrors } from './git.js';

const PLANNING_FILES = ['spec.md', 'spec.zh.md', 'spec.i18n.yaml', 'plan.md', 'plan.zh.md', 'plan.i18n.yaml'] as const;
const TASK_EXTENSIONS = ['md', 'zh.md', 'i18n.yaml'] as const;
const RESERVED_ROOT = 'workspace';

export interface ResolvedWorkspacePlan {
  root: string;
  directory: string;
  plan: PlanDocument;
  tasks: TaskDocument[];
  schedule: TaskSchedule;
  manifest: WorkspaceManifest | undefined;
}

export type SliceFileState = 'identical' | 'missing' | 'divergent';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the workspace root from the plan directory shape `<root>/.ai-workflow/plans/<planId>`
 * and read the frozen plan, tasks, schedule and manifest. The directory basename must equal the
 * frozen `plan_id`.
 */
export async function resolveWorkspacePlan(planDirectory: string): Promise<ResolvedWorkspacePlan> {
  const absolute = resolve(planDirectory);
  const planId = basename(absolute);
  const plansDirectory = dirname(absolute);
  const aiWorkflowDirectory = dirname(plansDirectory);
  const root = dirname(aiWorkflowDirectory);
  if (basename(plansDirectory) !== 'plans' || basename(aiWorkflowDirectory) !== '.ai-workflow') {
    throw new Error(`Workspace plan must live under <root>/.ai-workflow/plans/<planId>: ${absolute}`);
  }
  const plan = await readPlan(absolute);
  if (plan.planId !== planId) {
    throw new Error(`Workspace plan must live under ${join(root, '.ai-workflow', 'plans', plan.planId)}: ${absolute}`);
  }
  const tasks = await readTasks(absolute);
  const schedule = await readExecutionOrder(absolute, plan.planId, tasks);
  const manifest = await readWorkspaceManifest(absolute);
  return { root, directory: absolute, plan, tasks, schedule, manifest };
}

/**
 * Compute the complete byte content of one repository's slice: the frozen specification and plan
 * triplets, that repository's task triplets, its filtered execution order and the slice manifest.
 */
export async function computeSliceFiles(resolved: ResolvedWorkspacePlan, repository: WorkspaceRepository): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const name of PLANNING_FILES) {
    files.set(name, await readFile(join(resolved.directory, name)));
  }
  const repositoryTaskIds = new Set<string>();
  for (const task of resolved.tasks) {
    if (task.repo !== repository.name) continue;
    repositoryTaskIds.add(task.id);
    for (const extension of TASK_EXTENSIONS) {
      const fileName = `${task.id}.${extension}`;
      files.set(`tasks/${fileName}`, await readFile(join(resolved.directory, 'tasks', fileName)));
    }
  }
  const phases = resolved.schedule.phases
    .map((phase) => phase.parallel.filter((id) => repositoryTaskIds.has(id)))
    .filter((parallel) => parallel.length > 0);
  const schedule = stringifyYaml({ plan_id: resolved.plan.planId, phases: phases.map((parallel) => ({ parallel })) });
  files.set('tasks/execution-order.yaml', Buffer.from(schedule, 'utf8'));
  const manifest = renderWorkspaceManifest({ planId: resolved.plan.planId, role: 'slice', repositories: [repository] });
  files.set('workspace.yaml', Buffer.from(manifest, 'utf8'));
  return files;
}

/** Classify every expected slice file against the existing bytes at `sliceDirectory`. */
export async function classifySlice(sliceDirectory: string, expected: Map<string, Buffer>): Promise<Map<string, SliceFileState>> {
  const states = new Map<string, SliceFileState>();
  for (const [relativePath, contents] of expected) {
    let actual: Buffer | undefined;
    try {
      actual = await readFile(join(sliceDirectory, relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      actual = undefined;
    }
    states.set(relativePath, actual === undefined ? 'missing' : actual.equals(contents) ? 'identical' : 'divergent');
  }
  return states;
}

export interface DistributeSliceEntry {
  name: string;
  path: string;
  state: 'written' | 'unchanged';
}

export interface DistributeWorkspaceRootEntry {
  name: string;
  path: string;
  state: 'workspace-root';
}

export interface DistributeResult {
  valid: boolean;
  plan_id?: string;
  workspace_root?: string;
  slices?: DistributeSliceEntry[];
  workspace_root_entry?: DistributeWorkspaceRootEntry;
  errors?: string[];
}

export async function distributeWorkspace(planDirectory: string): Promise<DistributeResult> {
  let resolved: ResolvedWorkspacePlan;
  try {
    resolved = await resolveWorkspacePlan(planDirectory);
  } catch (error) {
    return { valid: false, errors: [errorMessage(error)] };
  }

  const { root, plan, tasks, schedule, manifest } = resolved;
  if (manifest === undefined || manifest.role !== 'workspace') {
    return { valid: false, plan_id: plan.planId, errors: ['workspace distribute requires a workspace manifest (role "workspace")'] };
  }
  const validationErrors = validateWorkspaceManifest(manifest, plan, tasks, schedule);
  if (validationErrors.length > 0) {
    return { valid: false, plan_id: plan.planId, errors: validationErrors };
  }

  const participating = manifest.repositories.filter((repository) => repository.name !== RESERVED_ROOT);
  const declarations = await readSubmodules(root);
  const preconditionErrors: string[] = [];
  for (const repository of participating) {
    preconditionErrors.push(...await repositoryPreconditionErrors(root, repository.name, repository.path, declarations));
  }
  if (preconditionErrors.length > 0) {
    return { valid: false, plan_id: plan.planId, errors: preconditionErrors };
  }

  const planned: { repository: WorkspaceRepository; sliceDirectory: string; expected: Map<string, Buffer>; states: Map<string, SliceFileState> }[] = [];
  const divergenceErrors: string[] = [];
  for (const repository of participating) {
    const expected = await computeSliceFiles(resolved, repository);
    const sliceDirectory = join(root, repository.path, '.ai-workflow', 'plans', plan.planId);
    const states = await classifySlice(sliceDirectory, expected);
    planned.push({ repository, sliceDirectory, expected, states });
    for (const [relativePath, state] of states) {
      if (state === 'divergent') divergenceErrors.push(`Divergent slice file: ${repository.name}/${relativePath}`);
    }
  }
  if (divergenceErrors.length > 0) {
    return { valid: false, plan_id: plan.planId, errors: divergenceErrors };
  }

  const slices: DistributeSliceEntry[] = [];
  for (const entry of planned) {
    let written = false;
    for (const [relativePath, contents] of entry.expected) {
      if (entry.states.get(relativePath) !== 'missing') continue;
      await atomicWrite(join(entry.sliceDirectory, relativePath), contents);
      written = true;
    }
    slices.push({ name: entry.repository.name, path: entry.repository.path, state: written ? 'written' : 'unchanged' });
  }

  const workspaceEntry = manifest.repositories.find((repository) => repository.name === RESERVED_ROOT);
  return {
    valid: true,
    plan_id: plan.planId,
    workspace_root: root,
    slices,
    workspace_root_entry: {
      name: workspaceEntry?.name ?? RESERVED_ROOT,
      path: workspaceEntry?.path ?? '.',
      state: 'workspace-root',
    },
  };
}
