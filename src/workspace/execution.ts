import { join } from 'node:path';
import type { TaskDocument, TaskSchedule } from '../workflow/types.js';
import { validateWorkspaceManifest } from '../workflow/workspace.js';
import { resolveWorkspacePlan, type ResolvedWorkspacePlan } from './distribute.js';
import {
  RESERVED_ROOT,
  errorMessage,
  implementationRecordPath,
  isFullSha,
  nowCst,
  readWorkspaceRecord,
  writeWorkspaceRecord,
  type ExecutionAnchor,
  type TaskCheckpoint,
  type WorkspaceExecutionRecord,
} from './record.js';

export interface ExecutionPendingTask {
  task: string;
  repo: string;
  repository_path: string;
  plan_path: string;
}

export interface ExecutionProjection {
  phase: number | null;
  pending_tasks: ExecutionPendingTask[];
  awaiting_delivery: string[];
  blockers: string[];
  completed: boolean;
}

interface RepositoryState {
  name: string;
  path: string;
  repositoryPath: string;
  planPath: string;
  record?: WorkspaceExecutionRecord;
  error?: string;
  hasTasks: boolean;
}

interface ExecutionAnalysis {
  schedule: TaskSchedule;
  taskById: Map<string, TaskDocument>;
  states: Map<string, RepositoryState>;
  order: string[];
  delivered: Set<string>;
  doneTasks: Set<string>;
  rootCompleted: boolean;
  blockers: string[];
}

function repositoryPathOf(root: string, repositoryPath: string): string {
  return join(root, repositoryPath);
}

function planPathOf(root: string, repositoryPath: string, planId: string): string {
  return join(root, repositoryPath, '.ai-workflow', 'plans', planId);
}

function repositoryTasks(tasks: TaskDocument[], name: string): TaskDocument[] {
  return tasks.filter((task) => task.repo === name);
}

function phaseIndexOf(schedule: TaskSchedule, taskId: string): number {
  return schedule.phases.findIndex((phase) => phase.parallel.includes(taskId));
}

/**
 * Deterministic read of every participating repository's implementation record for a resolved plan.
 * Present-but-invalid records stay blockers; the reserved root is exempt from the started-anchor rule.
 */
async function analyzeExecution(resolved: ResolvedWorkspacePlan): Promise<ExecutionAnalysis> {
  const { root, plan, tasks, schedule, manifest } = resolved;
  const blockers: string[] = [];
  const doneTasks = new Set<string>();
  const delivered = new Set<string>();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const repositories = manifest?.repositories ?? [];

  const order: string[] = [];
  for (const phase of schedule.phases) for (const id of phase.parallel) {
    const task = taskById.get(id);
    if (task?.repo !== undefined && !order.includes(task.repo)) order.push(task.repo);
  }
  for (const repository of repositories) if (repository.name !== RESERVED_ROOT && !order.includes(repository.name)) order.push(repository.name);

  const pathByName = new Map<string, string>();
  for (const repository of repositories) pathByName.set(repository.name, repository.path);
  if (!pathByName.has(RESERVED_ROOT)) pathByName.set(RESERVED_ROOT, '.');

  const states = new Map<string, RepositoryState>();
  const stateNames = new Set<string>([...order, RESERVED_ROOT]);
  for (const name of stateNames) {
    const repositoryPath = pathByName.get(name) ?? '.';
    const repositoryPathAbsolute = repositoryPathOf(root, repositoryPath);
    const planPath = planPathOf(root, repositoryPath, plan.planId);
    const recordPath = join(planPath, 'implementation.yaml');
    let record: WorkspaceExecutionRecord | undefined;
    let error: string | undefined;
    try {
      record = await readWorkspaceRecord(recordPath, plan.planId);
    } catch (caught) {
      error = errorMessage(caught);
    }
    states.set(name, { name, path: repositoryPath, repositoryPath: repositoryPathAbsolute, planPath, ...(record === undefined ? {} : { record }), ...(error === undefined ? {} : { error }), hasTasks: repositoryTasks(tasks, name).length > 0 });
  }

  for (const [name, state] of states) {
    if (state.error !== undefined) {
      if (name !== RESERVED_ROOT || state.hasTasks) blockers.push(`Implementation record for repository "${name}" is invalid: ${state.error}`);
      continue;
    }
    const record = state.record;
    if (record === undefined) continue;
    if (name === RESERVED_ROOT) {
      if (isFullSha(record.root_tasks_commit) || (record.status === 'completed' && isFullSha(record.commit))) delivered.add(name);
    } else if (record.status === 'completed' && isFullSha(record.commit)) {
      delivered.add(name);
    }
    if (name !== RESERVED_ROOT && record.status === 'in-progress' && record.execution === undefined) {
      blockers.push(`Implementation record for repository "${name}" is in-progress without an execution anchor: ${join(state.planPath, 'implementation.yaml')}`);
    }
  }

  for (const name of order) {
    const state = states.get(name);
    if (state === undefined) continue;
    const repoTasks = repositoryTasks(tasks, name);
    if (delivered.has(name)) {
      for (const task of repoTasks) doneTasks.add(task.id);
      continue;
    }
    const checkpoints = state.record?.task_checkpoints;
    if (checkpoints === undefined) continue;
    for (const taskId of Object.keys(checkpoints)) {
      const task = taskById.get(taskId);
      if (task === undefined) {
        blockers.push(`Checkpoint for unknown task "${taskId}" in repository "${name}"`);
        continue;
      }
      if (task.repo !== name) {
        blockers.push(`Checkpoint for task "${taskId}" is outside the repository "${name}" slice`);
        continue;
      }
      doneTasks.add(taskId);
    }
  }

  const firstPendingIndex = schedule.phases.findIndex((phase) => phase.parallel.some((id) => !doneTasks.has(id)));
  if (firstPendingIndex !== -1) {
    schedule.phases.forEach((phase, index) => {
      if (index <= firstPendingIndex) return;
      for (const id of phase.parallel) if (doneTasks.has(id)) blockers.push(`Task "${id}" is checkpointed in a later phase than the current phase ${firstPendingIndex + 1}`);
    });
  }

  const rootState = states.get(RESERVED_ROOT);
  const rootCompleted = rootState?.error === undefined && rootState?.record?.status === 'completed';
  return { schedule, taskById, states, order, delivered, doneTasks, rootCompleted, blockers };
}

/** Project the global workspace execution state: current one-based parent phase, pending tasks and delivery barriers. */
export async function projectWorkspaceExecution(resolved: ResolvedWorkspacePlan): Promise<ExecutionProjection> {
  const analysis = await analyzeExecution(resolved);
  const { schedule, taskById, states, order, doneTasks } = analysis;
  const firstPendingIndex = schedule.phases.findIndex((phase) => phase.parallel.some((id) => !doneTasks.has(id)));
  let phase: number | null = null;
  const pending_tasks: ExecutionPendingTask[] = [];
  if (firstPendingIndex !== -1) {
    phase = firstPendingIndex + 1;
    for (const id of schedule.phases[firstPendingIndex]?.parallel ?? []) {
      if (doneTasks.has(id)) continue;
      const task = taskById.get(id);
      const repo = task?.repo ?? '';
      const state = states.get(repo);
      pending_tasks.push({
        task: id,
        repo,
        repository_path: state?.repositoryPath ?? join(resolved.root, ''),
        plan_path: state?.planPath ?? join(resolved.root, '.ai-workflow', 'plans', resolved.plan.planId),
      });
    }
  }
  const awaiting_delivery: string[] = [];
  for (const name of order) {
    const repoTasks = repositoryTasks(resolved.tasks, name);
    if (repoTasks.length === 0 || analysis.delivered.has(name)) continue;
    if (repoTasks.every((task) => doneTasks.has(task.id))) awaiting_delivery.push(name);
  }
  return { phase, pending_tasks, awaiting_delivery, blockers: analysis.blockers, completed: analysis.rootCompleted };
}

export interface CheckpointSuccess {
  valid: true;
  plan_id: string;
  repository: string;
  status: string;
  path: string;
}

export interface CheckpointRefusal {
  valid: false;
  errors: string[];
}

export type CheckpointResult = CheckpointSuccess | CheckpointRefusal;

type StartEvent = {
  event: 'start';
  purpose: 'tasks' | 'finalization';
  source_root: string;
  repository: string;
  worktree: string;
  branch: string;
  target_branch: string;
  base_commit: string;
};

type TaskEvent =
  | { event: 'task'; task: string; kind: 'commit'; commit: string }
  | { event: 'task'; task: string; kind: 'no-change'; head: string };

type SimpleEvent = { event: 'reviewed' | 'delivered' | 'finalized'; commit: string };

type CheckpointEvent = StartEvent | TaskEvent | SimpleEvent;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(raw: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`field "${key}" must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requireSha(raw: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = raw[key];
  if (!isFullSha(value)) {
    errors.push(`field "${key}" must be a full lowercase 40- or 64-hex SHA`);
    return undefined;
  }
  return value;
}

/** Validate exactly one JSON event against the strict per-event schema; every error names its field. */
function validateEvent(raw: unknown): { ok: true; event: CheckpointEvent } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) return { ok: false, errors: ['event must be a JSON object'] };
  const name = raw.event;
  if (name !== 'start' && name !== 'task' && name !== 'reviewed' && name !== 'delivered' && name !== 'finalized') {
    return { ok: false, errors: [`unknown event type "${String(name)}"`] };
  }
  const allowed: Record<string, string[]> = {
    start: ['event', 'purpose', 'source_root', 'repository', 'worktree', 'branch', 'target_branch', 'base_commit'],
    task: ['event', 'task', 'kind', 'commit', 'head'],
    reviewed: ['event', 'commit'],
    delivered: ['event', 'commit'],
    finalized: ['event', 'commit'],
  };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) if (!(allowed[name] ?? []).includes(key)) errors.push(`unknown field "${key}"`);

  if (name === 'start') {
    const purpose = raw.purpose;
    if (purpose !== 'tasks' && purpose !== 'finalization') errors.push('field "purpose" must be "tasks" or "finalization"');
    const sourceRoot = requireString(raw, 'source_root', errors);
    const repository = requireString(raw, 'repository', errors);
    const worktree = requireString(raw, 'worktree', errors);
    const branch = requireString(raw, 'branch', errors);
    const targetBranch = requireString(raw, 'target_branch', errors);
    const baseCommit = requireSha(raw, 'base_commit', errors);
    if (errors.length) return { ok: false, errors };
    return { ok: true, event: { event: 'start', purpose: purpose as 'tasks' | 'finalization', source_root: sourceRoot as string, repository: repository as string, worktree: worktree as string, branch: branch as string, target_branch: targetBranch as string, base_commit: baseCommit as string } };
  }

  if (name === 'task') {
    const task = requireString(raw, 'task', errors);
    const kind = raw.kind;
    if (kind !== 'commit' && kind !== 'no-change') {
      errors.push('field "kind" must be "commit" or "no-change"');
    } else if (kind === 'commit') {
      const commit = requireSha(raw, 'commit', errors);
      if (raw.head !== undefined) errors.push('field "head" is not allowed for kind "commit"');
      if (errors.length) return { ok: false, errors };
      return { ok: true, event: { event: 'task', task: task as string, kind: 'commit', commit: commit as string } };
    } else {
      const head = requireSha(raw, 'head', errors);
      if (raw.commit !== undefined) errors.push('field "commit" is not allowed for kind "no-change"');
      if (errors.length) return { ok: false, errors };
      return { ok: true, event: { event: 'task', task: task as string, kind: 'no-change', head: head as string } };
    }
    return { ok: false, errors };
  }

  const commit = requireSha(raw, 'commit', errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, event: { event: name, commit: commit as string } };
}

function anchorEquals(anchor: ExecutionAnchor, event: StartEvent): boolean {
  return anchor.purpose === event.purpose
    && anchor.source_root === event.source_root
    && anchor.repository === event.repository
    && anchor.worktree === event.worktree
    && anchor.branch === event.branch
    && anchor.target_branch === event.target_branch
    && anchor.base_commit === event.base_commit;
}

function checkpointOf(event: TaskEvent): TaskCheckpoint {
  return event.kind === 'commit' ? { kind: 'commit', commit: event.commit } : { kind: 'no-change', head: event.head };
}

function checkpointEquals(left: TaskCheckpoint, right: TaskCheckpoint): boolean {
  if (left.kind === 'commit' && right.kind === 'commit') return left.commit === right.commit;
  if (left.kind === 'no-change' && right.kind === 'no-change') return left.head === right.head;
  return false;
}

/**
 * Apply exactly one checkpoint event to one repository's `implementation.yaml`. The command is
 * filesystem-only, refuses on any invalid precondition, and leaves the record byte-identical on refusal.
 */
export async function checkpointWorkspace(planDirectory: string, repository: string, input: string): Promise<CheckpointResult> {
  const refuse = (errors: string[]): CheckpointRefusal => ({ valid: false, errors });
  try {
    const resolved = await resolveWorkspacePlan(planDirectory);
    const { root, plan, manifest } = resolved;
    if (manifest === undefined || manifest.role !== 'workspace') return refuse(['workspace checkpoint requires a workspace manifest (role "workspace")']);
    if (manifest.repositories.every((entry) => entry.name === RESERVED_ROOT)) return refuse(['workspace checkpoint requires at least one participating non-root repository']);
    const validationErrors = validateWorkspaceManifest(manifest, plan, resolved.tasks, resolved.schedule);
    if (validationErrors.length > 0) return refuse(validationErrors);

    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(input);
    } catch {
      return refuse(['workspace checkpoint requires exactly one JSON event on stdin']);
    }
    const validated = validateEvent(parsedInput);
    if (!validated.ok) return refuse(validated.errors);
    const event = validated.event;
    if (event.event === 'start' && event.repository !== repository) return refuse([`event repository "${event.repository}" does not match --repo "${repository}"`]);

    const entry = manifest.repositories.find((candidate) => candidate.name === repository);
    if (entry === undefined) return refuse([`Repository "${repository}" is not declared in the workspace plan`]);
    const recordPath = implementationRecordPath(root, entry.path, plan.planId);

    let existing: WorkspaceExecutionRecord | undefined;
    try {
      existing = await readWorkspaceRecord(recordPath, plan.planId);
    } catch (error) {
      return refuse([errorMessage(error)]);
    }

    const analysis = await analyzeExecution(resolved);
    const successful = (record: WorkspaceExecutionRecord): CheckpointSuccess => ({ valid: true, plan_id: plan.planId, repository, status: record.status, path: recordPath });

    // Repository delivery barrier: a non-root repository may not checkpoint any event while a
    // declared dependency is not yet delivered. Completed records keep their idempotent success.
    if (repository !== RESERVED_ROOT && !(existing !== undefined && existing.status === 'completed')) {
      const pendingDependencies = entry.dependsOn.filter((dependency) => !analysis.delivered.has(dependency));
      if (pendingDependencies.length > 0) return refuse([`repository "${repository}" cannot checkpoint before its dependencies are delivered: ${pendingDependencies.join(', ')}`]);
    }

    if (event.event === 'start') {
      if (event.purpose === 'finalization' && repository !== RESERVED_ROOT) return refuse(['finalization start is only valid for the reserved workspace root']);
      if (event.purpose === 'finalization') {
        const childrenDelivered = manifest.repositories.filter((candidate) => candidate.name !== RESERVED_ROOT).every((candidate) => analysis.delivered.has(candidate.name));
        const rootHasTasks = repositoryTasks(resolved.tasks, RESERVED_ROOT).length > 0;
        const rootTasksDelivered = !rootHasTasks || analysis.delivered.has(RESERVED_ROOT);
        if (!childrenDelivered || !rootTasksDelivered) return refuse(['finalization start requires every child delivered and root tasks delivered']);
      }
      if (existing !== undefined) {
        if (existing.status === 'completed') return refuse([`repository "${repository}" is already completed`]);
        if (existing.execution !== undefined) {
          if (existing.execution.purpose === event.purpose) {
            if (!anchorEquals(existing.execution, event)) return refuse([`execution anchor for repository "${repository}" is already established with different values`]);
          } else if (!(repository === RESERVED_ROOT && existing.execution.purpose === 'tasks' && event.purpose === 'finalization')) {
            return refuse([`execution purpose for repository "${repository}" cannot change from "${existing.execution.purpose}" to "${event.purpose}"`]);
          }
        }
      }
      const record: WorkspaceExecutionRecord = {
        plan_id: plan.planId,
        status: 'in-progress',
        started_at: existing?.started_at ?? nowCst(),
        ...(existing?.root_tasks_commit === undefined ? {} : { root_tasks_commit: existing.root_tasks_commit }),
        ...(existing?.task_checkpoints === undefined ? {} : { task_checkpoints: existing.task_checkpoints }),
        execution: { purpose: event.purpose, source_root: event.source_root, repository: event.repository, worktree: event.worktree, branch: event.branch, target_branch: event.target_branch, base_commit: event.base_commit },
      };
      await writeWorkspaceRecord(recordPath, record);
      return successful(record);
    }

    if (existing !== undefined && existing.status === 'completed') {
      if ((event.event === 'delivered' || event.event === 'finalized') && existing.commit === event.commit) return successful(existing);
      if (event.event === 'delivered' && repository === RESERVED_ROOT && existing.root_tasks_commit === event.commit) return successful(existing);
      return refuse([`repository "${repository}" is already completed`]);
    }
    if (repository === RESERVED_ROOT && event.event === 'delivered' && existing?.root_tasks_commit === event.commit) return successful(existing as WorkspaceExecutionRecord);

    if (event.event === 'task') {
      if (existing === undefined || existing.execution === undefined) return refuse([`repository "${repository}" has no execution anchor`]);
      if (existing.execution.purpose !== 'tasks') return refuse(['task checkpoints are only valid for the tasks purpose']);
      const task = repositoryTasks(resolved.tasks, repository).find((candidate) => candidate.id === event.task);
      if (task === undefined) return refuse([`task "${event.task}" is not authorized for repository "${repository}"`]);
      const checkpoint = checkpointOf(event);
      const existingCheckpoint = existing.task_checkpoints?.[event.task];
      if (existingCheckpoint !== undefined) {
        if (checkpointEquals(existingCheckpoint, checkpoint)) return successful(existing);
        return refuse([`task "${event.task}" already has a contradictory checkpoint`]);
      }
      const phaseIndex = phaseIndexOf(analysis.schedule, event.task);
      const firstPendingIndex = analysis.schedule.phases.findIndex((phase) => phase.parallel.some((id) => !analysis.doneTasks.has(id)));
      if (firstPendingIndex === -1 || phaseIndex !== firstPendingIndex) return refuse([`task "${event.task}" is not in the current global phase`]);
      const record: WorkspaceExecutionRecord = { ...existing, task_checkpoints: { ...(existing.task_checkpoints ?? {}), [event.task]: checkpoint } };
      await writeWorkspaceRecord(recordPath, record);
      return successful(record);
    }

    if (existing === undefined || existing.execution === undefined) return refuse([`repository "${repository}" has no execution anchor`]);

    if (event.event === 'reviewed') {
      if (existing.execution.purpose === 'tasks') {
        const allDone = repositoryTasks(resolved.tasks, repository).every((task) => analysis.doneTasks.has(task.id));
        if (!allDone) return refuse([`review requires every task of repository "${repository}" to be checkpointed`]);
      } else {
        const childrenDelivered = manifest.repositories.filter((candidate) => candidate.name !== RESERVED_ROOT).every((candidate) => analysis.delivered.has(candidate.name));
        if (!childrenDelivered) return refuse(['finalization review requires every child delivered']);
      }
      if (existing.reviewed_commit !== undefined && existing.reviewed_commit !== event.commit) return refuse([`repository "${repository}" already reviewed a different commit`]);
      const record: WorkspaceExecutionRecord = { ...existing, reviewed_commit: event.commit };
      await writeWorkspaceRecord(recordPath, record);
      return successful(record);
    }

    if (event.event === 'delivered') {
      if (existing.execution.purpose !== 'tasks') return refuse(['delivery requires a tasks execution anchor']);
      const allDone = repositoryTasks(resolved.tasks, repository).every((task) => analysis.doneTasks.has(task.id));
      if (!allDone) return refuse(['every task must be checkpointed before delivery']);
      if (existing.reviewed_commit === undefined) return refuse([`delivery requires a reviewed commit for repository "${repository}"`]);
      if (repository === RESERVED_ROOT) {
        const record: WorkspaceExecutionRecord = { ...existing, root_tasks_commit: event.commit };
        delete record.execution;
        delete record.reviewed_commit;
        await writeWorkspaceRecord(recordPath, record);
        return successful(record);
      }
      const completedAt = nowCst();
      const record: WorkspaceExecutionRecord = { ...existing, status: 'completed', completed_at: completedAt, commit: event.commit };
      await writeWorkspaceRecord(recordPath, record);
      return successful(record);
    }

    if (repository !== RESERVED_ROOT) return refuse(['finalized is only valid for the reserved workspace root']);
    if (existing.execution.purpose !== 'finalization') return refuse(['finalized requires a finalization execution anchor']);
    if (existing.reviewed_commit === undefined) return refuse(['finalization requires a reviewed commit']);
    const completedAt = nowCst();
    const record: WorkspaceExecutionRecord = { ...existing, status: 'completed', completed_at: completedAt, commit: event.commit };
    delete record.execution;
    delete record.reviewed_commit;
    await writeWorkspaceRecord(recordPath, record);
    return successful(record);
  } catch (error) {
    return refuse([errorMessage(error)]);
  }
}
