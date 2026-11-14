import { dirname, join, resolve } from 'node:path';
import { readExecutionOrder } from './order.js';
import { readPlan, readTasks } from './parse.js';
import { readWorkspaceManifest } from './workspace.js';
import { workspaceStatus } from '../workspace/status.js';

export interface DispatchRequest {
  planDirectory: string;
  phase?: number;
  task?: string;
  verbose?: boolean;
}

export interface DispatchTask {
  id: string;
  repository: string;
  surface: string;
  roles: string[];
  requirements: string[];
  acceptance_criteria: string[];
  read_scope: string[];
  write_scope: string[];
  test_commands: string[];
  plan_path: string;
  repository_path: string;
  reports_path: string;
  task_anchor: string;
  plan_anchor: string;
}

export interface DispatchResult {
  plan_id: string;
  phase: number;
  tasks: DispatchTask[];
  packet?: string;
}

const ROLE_BY_SURFACE: Record<string, string[]> = {
  backend: ['Backend Developer'],
  frontend: ['Frontend Developer'],
  'cross-stack': ['Backend Developer', 'Frontend Developer'],
  research: ['Researcher'],
  documentation: ['Documentation Maintainer'],
  test: ['Test'],
  docs: ['Documentation Maintainer'],
};

function rolesFor(surface: string): string[] {
  const roles = ROLE_BY_SURFACE[surface];
  if (roles === undefined) throw new Error(`Unknown task surface: ${surface}`);
  return [...roles];
}

/** The workspace root of a plan directory shaped `<root>/.ai-workflow/plans/<planId>`. */
function workspaceRootOf(planDirectory: string): string {
  return dirname(dirname(dirname(planDirectory)));
}

function renderPacket(tasks: DispatchTask[]): string {
  return tasks
    .map((task) =>
      [
        `Task ${task.id}`,
        `  plan: ${task.plan_path}`,
        `  task: ${task.task_anchor}`,
        `  repository: ${task.repository_path}`,
        `  reports: ${task.reports_path}`,
        `  plan_anchor: ${task.plan_anchor}`,
        `  surface: ${task.surface}`,
        `  roles: ${task.roles.join(', ')}`,
      ].join('\n'),
    )
    .join('\n\n');
}

/**
 * Assemble the dispatch packets for one frozen plan phase. The schedule and task documents are
 * read as frozen inputs; the selected phase is explicit, projected from workspace status, or the
 * first phase of an ordinary plan. Paths resolve to absolute anchors under the plan's workspace
 * root, and the command writes nothing.
 */
export async function planDispatch(request: DispatchRequest): Promise<DispatchResult> {
  const planDirectory = resolve(request.planDirectory);
  const plan = await readPlan(planDirectory);
  const tasks = await readTasks(planDirectory);
  if (tasks.length === 0) throw new Error(`Plan has no task documents: ${planDirectory}`);
  const schedule = await readExecutionOrder(planDirectory, plan.planId, tasks);
  const workspaceRoot = workspaceRootOf(planDirectory);
  const isWorkspace = plan.workspaceRepos !== undefined;

  const repositoryPaths = new Map<string, string>();
  let selectedPhase: number;
  if (isWorkspace) {
    const status = await workspaceStatus(planDirectory);
    if (!status.valid) throw new Error(`Invalid workspace status: ${(status.errors ?? ['unknown workspace status error']).join('; ')}`);
    const manifest = await readWorkspaceManifest(planDirectory);
    if (manifest === undefined || manifest.role !== 'workspace') throw new Error(`Missing or invalid workspace manifest: ${join(planDirectory, 'workspace.yaml')}`);
    for (const repository of manifest.repositories) repositoryPaths.set(repository.name, repository.path);
    if (request.phase === undefined) {
      const execution = status.execution;
      if (execution === undefined || execution.phase === null || execution.completed) throw new Error(`Workspace plan has no pending phase: ${planDirectory}`);
      selectedPhase = execution.phase;
    } else {
      selectedPhase = request.phase;
    }
  } else {
    selectedPhase = request.phase ?? 1;
  }

  if (!Number.isInteger(selectedPhase) || selectedPhase < 1 || selectedPhase > schedule.phases.length) {
    throw new Error(`Unknown phase ${selectedPhase}: ${planDirectory} declares ${schedule.phases.length} phase(s)`);
  }
  const phaseTaskIds = schedule.phases[selectedPhase - 1]?.parallel ?? [];

  let selectedTaskIds = phaseTaskIds;
  if (request.task !== undefined) {
    const task = tasks.find((candidate) => candidate.id === request.task);
    if (task === undefined) throw new Error(`Unknown task "${request.task}": ${planDirectory}`);
    if (!phaseTaskIds.includes(task.id)) throw new Error(`Task "${task.id}" is outside the selected phase ${selectedPhase}`);
    selectedTaskIds = [task.id];
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const selectedTasks = selectedTaskIds.map((id) => {
    const task = taskById.get(id);
    if (task === undefined) throw new Error(`Unknown task "${id}": ${planDirectory}`);
    return task;
  });

  const dispatched: DispatchTask[] = selectedTasks.map((task) => {
    let repository = '';
    let repositoryPath = workspaceRoot;
    if (isWorkspace) {
      repository = task.repo ?? '';
      const declaredPath = repositoryPaths.get(repository);
      if (declaredPath === undefined) throw new Error(`Task "${task.id}" references unknown repository "${repository}"`);
      repositoryPath = join(workspaceRoot, declaredPath);
    }
    const planPath = isWorkspace ? join(repositoryPath, '.ai-workflow', 'plans', plan.planId) : planDirectory;
    return {
      id: task.id,
      repository,
      surface: task.surface,
      roles: rolesFor(task.surface),
      requirements: task.requirements,
      acceptance_criteria: task.acceptanceCriteria,
      read_scope: task.readScope,
      write_scope: task.writeScope,
      test_commands: task.testCommands,
      plan_path: planPath,
      repository_path: repositoryPath,
      reports_path: join(planPath, 'reports'),
      task_anchor: join(planDirectory, 'tasks', `${task.id}.md`),
      plan_anchor: join(planDirectory, 'plan.md'),
    };
  });

  const packet = request.verbose ? renderPacket(dispatched) : undefined;
  return {
    plan_id: plan.planId,
    phase: selectedPhase,
    tasks: dispatched,
    ...(packet === undefined ? {} : { packet }),
  };
}
