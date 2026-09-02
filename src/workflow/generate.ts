import { fixedTaskContext, readPlan, readTasks } from './parse.js';
import { normalizeProjectPaths, pathIsWithin, taskReadScopeDiagnostics, type TaskReadAuthorization } from './read-scope.js';
import { locateContext } from '../context/locate.js';
import { resolveProjectRoot } from '../context/paths.js';
import { resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import type { Host, Workflow, Node, TaskDocument } from './types.js';
import { objectDigest } from '../utils/hash.js';
import { scopesOverlap } from '../utils/paths.js';
import { validateWorkflow } from './validate.js';

const roleBySurface: Record<string, Node['role']> = { backend: 'backend', frontend: 'frontend', docs: 'backend', research: 'researcher', documentation: 'documentation-maintainer', 'cross-stack': 'task-worker' };
const base = { timeout_ms: 3600000, retry: 2, result_schema: 'schemas/result.schema.json' as const, on_failure: 'pause' as Node['on_failure'] };
function node(value: Omit<Node, keyof typeof base> & Partial<typeof base>): Node { return { ...base, ...value }; }
function broadOrUnknown(task: TaskDocument): boolean { return task.writeScope.length === 0 || task.writeScope.some((path) => !path.includes('/') && !path.includes('.')); }
function serializeConflicts(tasks: TaskDocument[]): TaskDocument[] { const result = structuredClone(tasks); for (let index = 0; index < result.length; index++) { const current = result[index]; if (!current) continue; for (let earlier = 0; earlier < index; earlier++) { const previous = result[earlier]; if (!previous) continue; if ((broadOrUnknown(current) || broadOrUnknown(previous) || scopesOverlap(current.writeScope, previous.writeScope)) && !current.dependsOn.includes(previous.id)) current.dependsOn.push(previous.id); } } return result; }
async function broadReadScopePaths(project: string, paths: string[]): Promise<string[]> {
  const directories: string[] = [];
  for (const path of paths) {
    try { if ((await lstat(resolve(project, path))).isDirectory()) directories.push(path); } catch { /* Missing paths are assessed against locator authorization. */ }
  }
  return directories;
}
async function validateNewModuleDirectories(project: string, task: TaskDocument, exactPaths: string[]): Promise<string[]> {
  const diagnostics: string[] = [];
  for (const directory of task.newModuleDirectories) {
    if (exactPaths.includes(directory)) diagnostics.push(`new module directory is locator-authorized as an exact path: ${directory}`);
    if (!task.writeScope.some((scope) => pathIsWithin(directory, scope))) diagnostics.push(`new module directory has no constrained write_scope: ${directory}`);
    try { await lstat(resolve(project, directory)); diagnostics.push(`new module directory already exists: ${directory}`); } catch { /* A new module directory must not exist yet. */ }
  }
  return diagnostics;
}
function taskNodes(task: TaskDocument, planScope: string): Node[] { const prefix = task.id; const dependencyCommits = task.dependsOn.map((dependency) => `${dependency}-commit`); const screenshot = `${planScope}/screenshot`; const context = task.readScope; const implementationRole = roleBySurface[task.surface] ?? 'task-worker'; return [
  node({ id: `${prefix}-setup`, phase: 'plan_setup', kind: 'git', role: 'git-operator', task_id: task.id, depends_on: dependencyCommits, read_scope: context, write_scope: [], allowed_commands: ['git worktree add'] }),
  node({ id: `${prefix}-explore`, phase: 'executing', kind: 'agent', role: 'file-explorer', task_id: task.id, depends_on: [`${prefix}-setup`], read_scope: context, write_scope: [], allowed_commands: [] }),
  node({ id: `${prefix}-coordinate`, phase: 'executing', kind: 'pipeline', role: 'task-worker', task_id: task.id, depends_on: [`${prefix}-explore`], read_scope: context, write_scope: [], allowed_commands: [] }),
  node({ id: `${prefix}-implement`, phase: 'executing', kind: 'agent', role: implementationRole, task_id: task.id, depends_on: [`${prefix}-coordinate`], read_scope: context, write_scope: task.writeScope, allowed_commands: ['researcher', 'documentation-maintainer'].includes(implementationRole) ? [] : task.testCommands }),
  node({ id: `${prefix}-test`, phase: 'validating', kind: 'agent', role: 'test', task_id: task.id, depends_on: [`${prefix}-implement`], read_scope: context, write_scope: [screenshot], allowed_commands: task.testCommands, on_failure: 'repair_once' }),
  node({ id: `${prefix}-commit`, phase: 'executing', kind: 'git', role: 'git-operator', task_id: task.id, depends_on: [`${prefix}-test`], read_scope: context, write_scope: [], allowed_commands: ['git add', 'git commit', 'git merge', 'git worktree remove'] })
]; }

export async function generateWorkflow(planDirectory: string, host: Host, concurrency = 3): Promise<Workflow> {
  const plan = await readPlan(planDirectory); const parsedTasks = await readTasks(planDirectory); const project = resolveProjectRoot(resolve(planDirectory, '../../..')); const planScope = `.ai-workflow/plans/${plan.planId}`;
  const taskReadAuthorizations: TaskReadAuthorization[] = [];
  for (const task of parsedTasks) {
    if (!task.feature) throw new Error(`Task feature is required: ${task.id}`);
    const located = await locateContext(project, { feature: task.feature, verify: true });
    if (located.status !== 'hit') throw new Error(`Task locator status for ${task.id} (${task.feature}): ${located.status}${'reason' in located ? `: ${located.reason}` : ''}`);
    const locator = normalizeProjectPaths(located.read_order);
    if (locator.errors.length) throw new Error(`Task locator returned invalid paths for ${task.id}: ${locator.errors.join('; ')}`);
    const authorization: TaskReadAuthorization = { task_id: task.id, exact_paths: locator.paths, module_directories: task.newModuleDirectories };
    const taskLocator = normalizeProjectPaths(task.locatorReadOrder);
    const sequenceMatches = taskLocator.paths.length === locator.paths.length && taskLocator.paths.every((path, index) => path === locator.paths[index]);
    if (!sequenceMatches) throw new Error(`Task locator_read_order sequence does not match feature ${task.feature}: ${task.id}; task: ${taskLocator.paths.join(', ') || '<none>'}; locator: ${locator.paths.join(', ') || '<none>'}`);
    const newModuleDiagnostics = await validateNewModuleDirectories(project, task, locator.paths);
    if (newModuleDiagnostics.length) throw new Error(`Task ${task.id} read_scope: ${newModuleDiagnostics.join('; ')}`);
    const broadPaths = await broadReadScopePaths(project, task.readScope);
    if (broadPaths.length) throw new Error(`Task ${task.id} broad directory read_scope path: ${broadPaths.join(', ')}`);
    const diagnostics = taskReadScopeDiagnostics(task.readScope, authorization);
    if (diagnostics.length) throw new Error(`Task ${task.id} read_scope: ${diagnostics.join('; ')}`);
    taskReadAuthorizations.push(authorization);
  }
  const tasks = serializeConflicts(parsedTasks.length ? parsedTasks : [{ id: 'task-001-plan', requirements: plan.requirements, acceptanceCriteria: plan.acceptanceCriteria, dependsOn: [], surface: 'cross-stack', locatorReadOrder: [], readScope: fixedTaskContext, newModuleDirectories: [], writeScope: [], testCommands: [], path: `${planScope}/plan.md` }]);
  if (!parsedTasks.length) taskReadAuthorizations.push({ task_id: 'task-001-plan', exact_paths: [], module_directories: [] });
  const nodes = tasks.flatMap((task) => taskNodes(task, planScope)); const commits = tasks.map((task) => `${task.id}-commit`); const changed = [...new Set(tasks.flatMap((task) => task.writeScope))];
  nodes.push(node({ id: 'plan-validate', phase: 'validating', kind: 'gate', role: 'test', depends_on: commits, read_scope: changed.length ? changed : [planScope], write_scope: [`${planScope}/screenshot`], allowed_commands: [] }), node({ id: 'standards-review', phase: 'reviewing', kind: 'agent', role: 'standards-review', depends_on: ['plan-validate'], read_scope: ['MEMORY.md', ...changed], write_scope: [], allowed_commands: [], retry: 0 }), node({ id: 'spec-review', phase: 'reviewing', kind: 'agent', role: 'spec-review', depends_on: ['plan-validate'], read_scope: [planScope, ...changed], write_scope: [], allowed_commands: [], retry: 0 }), node({ id: 'plan-integrate', phase: 'integrating', kind: 'git', role: 'git-operator', depends_on: ['standards-review', 'spec-review'], read_scope: changed.length ? changed : [planScope], write_scope: [], allowed_commands: ['git merge --no-ff', 'git worktree remove'], retry: 0 }));
  const workflow: Workflow = { schema_version: '1.0.0', plan_id: plan.planId, host, input_digests: { plan: plan.digest, tasks: objectDigest(parsedTasks) }, concurrency: Math.min(3, Math.max(1, concurrency)), policies: { max_retries: 2, default_timeout_ms: 3600000, repair_rounds: 1, push_allowed: false, rebase_allowed: false }, phases: ['preflight', 'baseline', 'plan_setup', 'executing', 'validating', 'reviewing', 'repairing', 'integrating'], task_read_authorizations: taskReadAuthorizations, nodes: nodes as [Node, ...Node[]], gates: [{ id: 'tests', after: ['plan-validate'], kind: 'tests-pass' }, { id: 'reviews', after: ['standards-review', 'spec-review'], kind: 'reviews-pass-or-repair' }, { id: 'integration', after: ['plan-integrate'], kind: 'baseline-stable' }] };
  const validation = await validateWorkflow(workflow, project); if (!validation.valid) throw new Error(`Generated workflow is invalid: ${validation.errors.join('; ')}`); return workflow;
}
export function applyAdjustments(workflow: Workflow, operations: Array<Record<string, unknown>>): Workflow { const result: Workflow = structuredClone(workflow); for (const operation of operations) { const op = String(operation.op); const target = result.nodes.find((item) => item.id === operation.node || item.task_id === operation.node); if (op === 'set-concurrency') result.concurrency = Number(operation.value); else if (target && op === 'set-role') target.role = String(operation.value) as Node['role']; else if (target && op === 'set-retry') target.retry = Number(operation.value); else if (target && op === 'set-failure-policy') target.on_failure = String(operation.value) as Node['on_failure']; else if (target && op === 'add-dependency') target.depends_on = [...new Set([...target.depends_on, String(operation.dependency)])]; else if (target && op === 'remove-dependency') target.depends_on = target.depends_on.filter((item) => item !== operation.dependency); else if (op === 'add-gate' && operation.gate && typeof operation.gate === 'object') result.gates.push(operation.gate as Workflow['gates'][number]); else if (op === 'remove-gate' && operation.gate && typeof operation.gate === 'object') { const id = (operation.gate as { id?: unknown }).id; result.gates = result.gates.filter((gate) => gate.id !== id); } else throw new Error(`Unsupported or unknown adjustment: ${op}`); } return result; }
export function explainWorkflow(workflow: Workflow): string { const lines = [`Plan: ${workflow.plan_id}`, `Host: ${workflow.host}`, `Concurrency: ${workflow.concurrency}`, `Nodes: ${workflow.nodes.length}`, `Input digests: ${JSON.stringify(workflow.input_digests)}`, '', '```mermaid', 'graph TD']; for (const item of workflow.nodes) { if (item.depends_on.length === 0) lines.push(`  ${item.id}[${item.role}]`); for (const dependency of item.depends_on) lines.push(`  ${dependency} --> ${item.id}`); } lines.push('```', '', 'Risks: scope violations, baseline drift, conflicts, host failures and failed gates pause the run.'); return lines.join('\n'); }
