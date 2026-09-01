import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdown } from '../utils/frontmatter.js';
import { frozenDocumentDigest, frozenPlanDigest } from './digest.js';
import type { PlanDocument, TaskDocument } from './types.js';

function listStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function stringValue(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
export const fixedTaskContext = ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'];

function exactReadPath(path: string): boolean {
  return path.length > 0 && path !== '.' && !path.startsWith('/') && !path.endsWith('/') && !path.split('/').some((part) => part === '.' || part === '..' || part.length === 0) && !/[?*[\]{}$<>]/.test(path);
}

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
  let names: string[]; try { names = await readdir(taskDir); } catch { return []; }
  const tasks: TaskDocument[] = [];
  for (const name of names.filter((item) => /^task-\d{3}-.+\.md$/.test(item)).sort()) {
    const path = join(taskDir, name); const doc = parseMarkdown(await readFile(path, 'utf8')); const a = doc.attributes;
    const id = stringValue(a.id, name.replace(/\.md$/, '')); const surface = stringValue(a.surface, 'backend'); const feature = stringValue(a.feature); const locatorReadOrder = listStrings(a.locator_read_order); const readScope = listStrings(a.read_scope); const writeScope = listStrings(a.write_scope);
    if (!/^task-\d{3}(?:-[a-z0-9-]+)?$/.test(id)) throw new Error(`Invalid task id: ${id}`);
    if (!['backend', 'frontend', 'cross-stack', 'test', 'docs'].includes(surface)) throw new Error(`Invalid task surface: ${surface}`);
    if (!feature || !locatorReadOrder.length || !readScope.length || readScope.some((path) => !exactReadPath(path))) throw new Error(`Unsafe task read_scope: ${id}`);
    if (writeScope.some((path) => path === '.' || path.startsWith('/') || path.split('/').includes('..'))) throw new Error(`Unsafe task scope: ${id}`);
    const expectedReadScope = [...new Set([...fixedTaskContext, ...locatorReadOrder])];
    if (readScope.length !== expectedReadScope.length || expectedReadScope.some((path) => !readScope.includes(path))) throw new Error(`Task read_scope must equal fixed context and locator_read_order: ${id}`);
    tasks.push({ id, requirements: listStrings(a.requirements), acceptanceCriteria: listStrings(a.acceptance_criteria), dependsOn: listStrings(a.depends_on), surface, feature, locatorReadOrder, readScope, writeScope, testCommands: listStrings(a.test_commands), path });
  }
  return tasks;
}
