import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdown } from '../utils/frontmatter.js';
import { objectDigest } from '../utils/hash.js';
import type { PlanDocument, TaskDocument } from './types.js';

function listStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function stringValue(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }

export async function readPlan(directory: string): Promise<PlanDocument> {
  const [spec, plan] = await Promise.all([readFile(join(directory, 'spec.md'), 'utf8'), readFile(join(directory, 'plan.md'), 'utf8')]);
  const specDoc = parseMarkdown(spec); const planDoc = parseMarkdown(plan);
  const specPlanId = stringValue(specDoc.attributes.plan_id); const planPlanId = stringValue(planDoc.attributes.plan_id); if (!specPlanId || !planPlanId || specPlanId !== planPlanId) throw new Error('spec.md and plan.md must have matching plan_id'); const planId = planPlanId;
  if (!/^[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(planId)) throw new Error(`Invalid plan_id: ${planId}`);
  if (planDoc.attributes.status !== 'frozen' || specDoc.attributes.status !== 'frozen') throw new Error('spec.md and plan.md must both be frozen');
  const requirements = [...listStrings(specDoc.attributes.requirements), ...extractHeadings(specDoc.body, /^###?\s*(REQ-\d+)/gm)];
  const acceptanceCriteria = [...listStrings(specDoc.attributes.acceptance_criteria), ...extractHeadings(specDoc.body, /^###?\s*(AC-\d+)/gm)];
  const declaredReqs = Number(specDoc.attributes.requirement_count); const declaredAcs = Number(specDoc.attributes.acceptance_criteria_count); if (Number.isFinite(declaredReqs) && declaredReqs !== requirements.length) throw new Error(`Requirement count mismatch: declared ${declaredReqs}, found ${requirements.length}`); if (Number.isFinite(declaredAcs) && declaredAcs !== acceptanceCriteria.length) throw new Error(`Acceptance criteria count mismatch: declared ${declaredAcs}, found ${acceptanceCriteria.length}`);
  return { planId, status: 'frozen', requirements, acceptanceCriteria, digest: objectDigest({ spec, plan }), directory };
}

function extractHeadings(body: string, pattern: RegExp): string[] { return [...body.matchAll(pattern)].map((match) => match[1] ?? ''); }

export async function readTasks(directory: string): Promise<TaskDocument[]> {
  const taskDir = join(directory, 'tasks');
  let names: string[]; try { names = await readdir(taskDir); } catch { return []; }
  const tasks: TaskDocument[] = [];
  for (const name of names.filter((item) => /^task-\d{3}-.+\.md$/.test(item)).sort()) {
    const path = join(taskDir, name); const doc = parseMarkdown(await readFile(path, 'utf8')); const a = doc.attributes;
    const id = stringValue(a.id, name.replace(/\.md$/, '')); const surface = stringValue(a.surface, 'backend'); if (!/^task-\d{3}(?:-[a-z0-9-]+)?$/.test(id)) throw new Error(`Invalid task id: ${id}`); if (!['backend', 'frontend', 'cross-stack', 'test', 'docs'].includes(surface)) throw new Error(`Invalid task surface: ${surface}`); if ([...listStrings(a.read_scope), ...listStrings(a.write_scope)].some((item) => item === '.' || item.startsWith('/') || item.split('/').includes('..'))) throw new Error(`Unsafe task scope: ${id}`); tasks.push({ id, requirements: listStrings(a.requirements), acceptanceCriteria: listStrings(a.acceptance_criteria), dependsOn: listStrings(a.depends_on), surface, readScope: listStrings(a.read_scope), writeScope: listStrings(a.write_scope), testCommands: listStrings(a.test_commands), path });
  }
  return tasks;
}
