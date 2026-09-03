import type {
  AggregateRepairCapability,
  CodingActionCapability,
  CodingGate,
  CodingTaskCapability,
  RepairTestCapability,
  ReviewRecheckCapability,
  ScopeConflict,
  ConcurrencyGroupPolicy,
} from '../generated/coding-manifest.schema.js';
import { fixedTaskContext } from './read-scope.js';

export type TaskSurface = 'backend' | 'frontend' | 'cross-stack' | 'test' | 'docs' | 'research' | 'documentation';

export interface TaskCapabilityInput {
  id: string;
  requirements: string[];
  acceptanceCriteria: string[];
  dependsOn: string[];
  surface: TaskSurface;
  feature: string;
  locatorReadOrder: string[];
  readScope: string[];
  newModuleDirectories: string[];
  writeScope: string[];
  testCommands: string[];
  activation?: 'required' | 'conditional';
}

export interface TaskCapabilityCompilation {
  tasks: CodingTaskCapability[];
  actions: CodingActionCapability[];
  scope_conflicts: ScopeConflict[];
  concurrency_groups: ConcurrencyGroupPolicy[];
  aggregate_repair: AggregateRepairCapability;
  repair_tests: RepairTestCapability[];
  review_rechecks: ReviewRecheckCapability[];
  mandatory_gates: CodingGate[];
}

const implementationRole: Record<TaskSurface, CodingActionCapability['role']> = {
  backend: 'backend', frontend: 'frontend', 'cross-stack': 'task-worker', test: 'test',
  docs: 'backend', research: 'researcher', documentation: 'documentation-maintainer',
};

const outputSchema = 'schemas/coding-agent-result.schema.json';

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function overlaps(left: string[], right: string[]): boolean {
  const within = (scope: string, path: string): boolean => path === scope || path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`);
  return left.some((leftPath) => right.some((rightPath) => within(leftPath, rightPath)));
}

function action(
  task: TaskCapabilityInput,
  operation: CodingActionCapability['operation'],
  role: CodingActionCapability['role'],
  actionId: string,
  requiresActions: string[],
  writeScope: string[],
  optional: boolean,
  hostOnly: boolean,
  allowedCommands = task.testCommands,
): CodingActionCapability {
  return {
    action_id: actionId,
    task_id: task.id,
    operation,
    role,
    locator_read_order: [...task.locatorReadOrder],
    read_scope: [...task.readScope],
    write_scope: [...writeScope],
    new_module_directories: [...task.newModuleDirectories],
    allowed_commands: [...allowedCommands],
    test_commands: [...task.testCommands],
    output_schema: outputSchema,
    requires_actions: [...requiresActions],
    max_attempts: 1,
    optional,
    write_access: writeScope.length > 0,
    host_only: hostOnly,
  };
}

function validateTaskGraph(tasks: TaskCapabilityInput[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) for (const dependency of task.dependsOn) if (!ids.has(dependency)) throw new Error(`${task.id} depends on unknown task ${dependency}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Task dependency cycle detected at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const task = tasks.find((candidate) => candidate.id === id);
    for (const dependency of task?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export function compileTaskCapabilities(tasks: TaskCapabilityInput[]): TaskCapabilityCompilation {
  validateTaskGraph(tasks);
  const compiledTasks: CodingTaskCapability[] = [];
  const actions: CodingActionCapability[] = [];
  const repairTests: RepairTestCapability[] = [];
  const concurrencyGroups: ConcurrencyGroupPolicy[] = [];

  for (const task of tasks) {
    const prefix = task.id;
    const exploreId = `${prefix}-explore`;
    const implementId = `${prefix}-implement`;
    const testId = `${prefix}-test`;
    const repairId = `${prefix}-repair`;
    const finalizeId = `${prefix}-finalize`;
    const dependencyFinalizers = task.dependsOn.map((dependency) => `${dependency}-finalize`);
    const role = implementationRole[task.surface];
    const explore = action(task, 'explore', 'file-explorer', exploreId, dependencyFinalizers, [], false, false, []);
    const implement = action(task, 'implement', role, implementId, [exploreId], task.writeScope, false, false);
    const test = action(task, 'test', 'test', testId, [implementId], [], false, false, []);
    const repair = { ...action(task, 'repair', role === 'researcher' || role === 'documentation-maintainer' ? 'task-worker' : role, repairId, [testId], task.writeScope, true, false), repair_for_action_id: testId };
    const finalize = action(task, 'finalize', 'git-operator', finalizeId, [testId], [], false, true, ['git add', 'git commit', 'git merge', 'git worktree remove']);
    actions.push(explore, implement, test, repair, finalize);
    compiledTasks.push({
      task_id: task.id,
      requirements: [...task.requirements],
      acceptance_criteria: [...task.acceptanceCriteria],
      feature: task.feature,
      activation: task.activation ?? 'required',
      depends_on: [...task.dependsOn],
      required_actions: [exploreId, implementId, testId],
      optional_actions: [repairId],
      finalization_action: finalizeId,
      finalization_mode: task.writeScope.length ? 'commit-and-merge' : 'read-only-finalize',
      worktree_policy: 'isolated-task-worktree',
      max_repair_rounds: 1,
    });
    repairTests.push({
      action_id: `${prefix}-repair-test`, task_id: task.id, operation: 'test', role: 'test',
      locator_read_order: [...task.locatorReadOrder], read_scope: [...task.readScope], write_scope: [],
      new_module_directories: [], allowed_commands: [], test_commands: [...task.testCommands],
      output_schema: outputSchema, requires_actions: [], max_attempts: 1, optional: false,
      write_access: false, host_only: true,
      source_test_action_id: testId,
      worktree_policy: 'isolated-repair-test-worktree',
      base_source: 'plan-head-after-repair-merge',
      resource_kinds: ['repair-test-worktree', 'repair-test-branch'],
      coordinator_action_id: repairId,
      coordinator_call_id_template: 'host/repair-test/<repair-transaction-id>/<task-id>',
      repair_transaction_id: `${prefix}-repair-transaction`,
    });
    concurrencyGroups.push({
      group_id: `${prefix}-concurrency`,
      kind: 'parallel',
      action_ids: [exploreId, implementId, testId, repairId, finalizeId],
      conflict_policy: 'reject-before-second-admission',
      outside_group_policy: 'submission-fifo-after-predecessor-terminal',
    });
  }

  const scopeConflicts: ScopeConflict[] = [];
  for (let left = 0; left < actions.length; left++) for (let right = left + 1; right < actions.length; right++) {
    const first = actions[left];
    const second = actions[right];
    if (!first || !second) continue;
    if (overlaps(first.write_scope, second.write_scope)) scopeConflicts.push({ left_action_id: first.action_id, right_action_id: second.action_id, kind: 'write-write' });
    else if (overlaps(first.write_scope, second.read_scope) || overlaps(second.write_scope, first.read_scope)) scopeConflicts.push({ left_action_id: first.action_id, right_action_id: second.action_id, kind: 'write-read' });
  }

  const allReadScope = unique([...fixedTaskContext, ...tasks.flatMap((task) => task.readScope)]);
  const allLocatorOrder = unique(tasks.flatMap((task) => task.locatorReadOrder));
  const allWriteScope = unique(tasks.flatMap((task) => task.writeScope));
  const aggregateRepair: AggregateRepairCapability = {
    action_id: 'plan-aggregate-repair', task_id: 'plan', operation: 'repair',
    role: tasks.find((task) => task.writeScope.length)?.surface === 'frontend' ? 'frontend' : 'task-worker',
    locator_read_order: allLocatorOrder, read_scope: allReadScope, write_scope: allWriteScope,
    new_module_directories: unique(tasks.flatMap((task) => task.newModuleDirectories)), allowed_commands: [],
    test_commands: unique(tasks.flatMap((task) => task.testCommands)), output_schema: outputSchema,
    requires_actions: [], max_attempts: 1, optional: false, write_access: true, host_only: true,
    maximum_write_scope: allWriteScope,
    test_actions_by_task: Object.fromEntries(tasks.map((task) => [task.id, [`${task.id}-test`]])),
    worktree_policy: 'isolated-repair-worktree',
  };
  const reviewRechecks: ReviewRecheckCapability[] = (['standards-review', 'spec-review'] as const).map((gateId) => ({
    gate_id: gateId, action_id: `${gateId}-recheck`, task_id: 'plan', operation: 'review', role: gateId,
    locator_read_order: allLocatorOrder, read_scope: allReadScope, write_scope: [], new_module_directories: [],
    allowed_commands: [], test_commands: [], output_schema: 'schemas/review-repair-resolution.schema.json',
    requires_actions: [], max_attempts: 1, optional: false, write_access: false, host_only: true,
    read_scope_source: 'original-review-action', coordinator_call_id_template: 'host/finding-recheck/<gate-id>/<finding-id>',
  }));
  const mandatoryGates: CodingGate[] = [
    { gate_id: 'task-closure', owner: 'host', requires: compiledTasks.map((task) => task.finalization_action), predicate: 'all-required-tasks-finalized', repair_budget: 0 },
    { gate_id: 'plan-validation', owner: 'host', requires: ['task-closure'], predicate: 'plan-validation-passed', repair_budget: 0 },
    { gate_id: 'standards-review', owner: 'host', requires: ['plan-validation'], predicate: 'review-findings-have-no-errors', repair_budget: 1 },
    { gate_id: 'spec-review', owner: 'host', requires: ['plan-validation'], predicate: 'review-findings-have-no-errors', repair_budget: 1 },
    { gate_id: 'repair-closure', owner: 'host', requires: ['standards-review', 'spec-review'], predicate: 'every-original-finding-targeted-recheck-closed', repair_budget: 1 },
    { gate_id: 'baseline-stable', owner: 'host', requires: ['repair-closure'], predicate: 'baseline-matches-receipt', repair_budget: 0 },
    { gate_id: 'integration', owner: 'host', requires: ['baseline-stable'], predicate: 'target-no-ff-merge-observed', repair_budget: 0 },
  ];
  return { tasks: compiledTasks, actions, scope_conflicts: scopeConflicts, concurrency_groups: concurrencyGroups, aggregate_repair: aggregateRepair, repair_tests: repairTests, review_rechecks: reviewRechecks, mandatory_gates: mandatoryGates };
}
