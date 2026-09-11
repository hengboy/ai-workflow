import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdown } from '../utils/frontmatter.js';
import { frozenDocumentDigest, frozenPlanDigest } from './digest.js';
import { normalizeProjectPaths } from './read-scope.js';
import type { PlanDocument, TaskDocument } from './types.js';

function listStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function stringValue(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
const allowedSurfaces: string[] = ['backend', 'frontend', 'cross-stack', 'test', 'docs', 'research', 'documentation'];
export { fixedTaskContext } from './read-scope.js';

export async function readPlan(directory: string): Promise<PlanDocument> {
  const [spec, plan] = await Promise.all([readFile(join(directory, 'spec.md'), 'utf8'), readFile(join(directory, 'plan.md'), 'utf8')]);
  const specDoc = parseMarkdown(spec); const planDoc = parseMarkdown(plan);
  const specPlanId = stringValue(specDoc.attributes.plan_id); const planPlanId = stringValue(planDoc.attributes.plan_id); if (!specPlanId || !planPlanId || specPlanId !== planPlanId) throw new Error('spec.md and plan.md must have matching plan_id'); const planId = planPlanId;
  if (!/^[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(planId)) throw new Error(`Invalid plan_id: ${planId}`);
  if (planDoc.attributes.status !== 'frozen' || specDoc.attributes.status !== 'frozen') throw new Error('spec.md and plan.md must both be frozen');
  const requirements = [...listStrings(specDoc.attributes.requirements), ...extractHeadings(specDoc.body, /^###?\s*(REQ-\d+)/gm)];
  const acceptanceCriteria = [...listStrings(specDoc.attributes.acceptance_criteria), ...extractHeadings(specDoc.body, /^###?\s*(AC-\d+)/gm)];
  const declaredReqs = Number(specDoc.attributes.requirement_count); const declaredAcs = Number(specDoc.attributes.acceptance_criteria_count); if (Number.isFinite(declaredReqs) && declaredReqs !== requirements.length) throw new Error(`Requirement count mismatch: declared ${declaredReqs}, found ${requirements.length}`); if (Number.isFinite(declaredAcs) && declaredAcs !== acceptanceCriteria.length) throw new Error(`Acceptance criteria count mismatch: declared ${declaredAcs}, found ${acceptanceCriteria.length}`);
  const specDigest = frozenDocumentDigest(spec); const planDigest = frozenDocumentDigest(plan);
  const declaredSpecDigest = stringValue(specDoc.attributes.digest); const declaredPlanDigest = stringValue(planDoc.attributes.digest);
  if (!/^sha256:[0-9a-f]{64}$/.test(declaredSpecDigest) || declaredSpecDigest !== specDigest) throw new Error(`spec.md digest mismatch: declared ${declaredSpecDigest || '<missing>'}, computed ${specDigest}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(declaredPlanDigest) || declaredPlanDigest !== planDigest) throw new Error(`plan.md digest mismatch: declared ${declaredPlanDigest || '<missing>'}, computed ${planDigest}`);
  return { planId, status: 'frozen', requirements, acceptanceCriteria, specDigest, planDigest, digest: frozenPlanDigest(spec, plan), directory };
}

function extractHeadings(body: string, pattern: RegExp): string[] { return [...body.matchAll(pattern)].map((match) => match[1] ?? ''); }

export async function readTasks(directory: string): Promise<TaskDocument[]> {
  const taskDir = join(directory, 'tasks');
  let names: string[];
  try { names = await readdir(taskDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const tasks: TaskDocument[] = [];
  const plan = await readPlan(directory);
  const seen = new Set<string>();
  for (const name of names.filter((item) => item.endsWith('.md')).sort()) {
    const path = join(taskDir, name); const doc = parseMarkdown(await readFile(path, 'utf8')); const a = doc.attributes;
    const id = stringValue(a.id); const rawSurface = a.surface; const rawReadScope = listStrings(a.read_scope); const rawWriteScope = listStrings(a.write_scope);
    const expectedId = name.replace(/\.md$/, '');
    if (!/^task-\d{3}-.+\.md$/.test(name)) throw new Error(`Invalid task filename: ${name}`);
    if (id !== expectedId) throw new Error(`Task filename and frontmatter id differ: ${name} / ${id || '<missing>'}`);
    if (seen.has(id)) throw new Error(`Duplicate task id: ${id}`); seen.add(id);
    if (!/^task-\d{3}(?:-[a-z0-9-]+)?$/.test(id)) throw new Error(`Invalid task id: ${id}`);
    if (typeof rawSurface !== 'string' || rawSurface.length === 0) throw new Error(`Invalid task surface: <missing>. Allowed surfaces: ${allowedSurfaces.join(', ')}; ${id}`);
    if (!allowedSurfaces.includes(rawSurface)) throw new Error(`Invalid task surface: ${rawSurface}. Allowed surfaces: ${allowedSurfaces.join(', ')}`);
    const surface = rawSurface;
    const scope = normalizeProjectPaths(rawReadScope);
    const writeScope = normalizeProjectPaths(rawWriteScope);
    if (!scope.paths.length || scope.errors.length || writeScope.errors.length) throw new Error(`Invalid task scope: ${id}: ${[...scope.errors, ...writeScope.errors].join('; ')}`);
    const requirements = listStrings(a.requirements); const acceptanceCriteria = listStrings(a.acceptance_criteria); const dependsOn = listStrings(a.depends_on);
    if (!requirements.length || !acceptanceCriteria.length) throw new Error(`Task must declare requirements and acceptance_criteria: ${id}`);
    if (requirements.some((item) => !plan.requirements.includes(item)) || acceptanceCriteria.some((item) => !plan.acceptanceCriteria.includes(item))) throw new Error(`Task references unknown REQ/AC: ${id}`);
    if (['backend', 'frontend', 'cross-stack'].includes(surface) && !writeScope.paths.length) throw new Error(`Coding task requires write_scope: ${id}`);
    tasks.push({ id, requirements, acceptanceCriteria, dependsOn, surface, readScope: scope.paths, writeScope: writeScope.paths, testCommands: listStrings(a.test_commands), path });
  }
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) for (const dependency of task.dependsOn) if (!ids.has(dependency)) throw new Error(`Unknown task dependency: ${task.id} -> ${dependency}`);
  if (tasks.length) {
    const coveredReqs = new Set(tasks.flatMap((task) => task.requirements)); const coveredAcs = new Set(tasks.flatMap((task) => task.acceptanceCriteria));
    if (plan.requirements.some((item) => !coveredReqs.has(item)) || plan.acceptanceCriteria.some((item) => !coveredAcs.has(item))) throw new Error('Frozen plan REQ/AC coverage is incomplete');
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => { if (visiting.has(id)) throw new Error(`Task dependency cycle: ${id}`); if (visited.has(id)) return; visiting.add(id); for (const dep of tasks.find((task) => task.id === id)?.dependsOn ?? []) visit(dep); visiting.delete(id); visited.add(id); };
  for (const task of tasks) visit(task.id);
  return tasks;
}
