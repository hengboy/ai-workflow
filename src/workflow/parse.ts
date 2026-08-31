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
  const planId = stringValue(planDoc.attributes.plan_id, stringValue(specDoc.attributes.plan_id));
  if (!/^[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(planId)) throw new Error(`Invalid plan_id: ${planId}`);
  if (planDoc.attributes.status !== 'frozen' || specDoc.attributes.status !== 'frozen') throw new Error('spec.md and plan.md must both be frozen');
  const requirements = [...listStrings(specDoc.attributes.requirements), ...extractHeadings(specDoc.body, /^###?\s*(REQ-\d+)/gm)];
  const acceptanceCriteria = [...listStrings(specDoc.attributes.acceptance_criteria), ...extractHeadings(specDoc.body, /^###?\s*(AC-\d+)/gm)];
  return { planId, status: 'frozen', requirements, acceptanceCriteria, digest: objectDigest({ spec, plan }), directory };
}

function extractHeadings(body: string, pattern: RegExp): string[] { return [...body.matchAll(pattern)].map((match) => match[1] ?? ''); }

export async function readTasks(directory: string): Promise<TaskDocument[]> {
  const taskDir = join(directory, 'tasks');
  let names: string[]; try { names = await readdir(taskDir); } catch { return []; }
  const tasks: TaskDocument[] = [];
  for (const name of names.filter((item) => /^task-\d{3}-.+\.md$/.test(item)).sort()) {
    const path = join(taskDir, name); const doc = parseMarkdown(await readFile(path, 'utf8')); const a = doc.attributes;
    tasks.push({ id: stringValue(a.id, name.replace(/\.md$/, '')), requirements: listStrings(a.requirements), acceptanceCriteria: listStrings(a.acceptance_criteria), dependsOn: listStrings(a.depends_on), surface: stringValue(a.surface, 'backend'), readScope: listStrings(a.read_scope), writeScope: listStrings(a.write_scope), testCommands: listStrings(a.test_commands), path });
  }
  return tasks;
}
