import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { parseMarkdown } from '../utils/frontmatter.js';
import { metaPathOf, zhPathOf } from '../notes/pairing.js';
import { frozenDocumentDigest, frozenPlanDigest } from './digest.js';
import { enumeratePlanDocuments, validatePlanPair, type PlanDocumentAnchor } from './pairing.js';
import { normalizeProjectPaths, pathIsWithin } from './read-scope.js';
import { readWorkspaceManifest } from './workspace.js';
import type { PlanDocument, TaskDocument, WorkspaceFinalization, WorkspaceFinalizationReadScope, WorkspaceRepo } from './types.js';

function listStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function stringValue(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
const allowedSurfaces: string[] = ['backend', 'frontend', 'cross-stack', 'test', 'docs', 'research', 'documentation'];
export { fixedTaskContext } from './read-scope.js';

function planAnchor(directory: string, basename: string): PlanDocumentAnchor { const path = join(directory, basename); return { path, zhPath: zhPathOf(path), metaPath: metaPathOf(path) }; }

/** Parse the optional `workspace_repos` frontmatter declaration, validating the reserved root entry, names, paths and dependency graph. */
function parseWorkspaceRepos(value: unknown): WorkspaceRepo[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid workspace_repos entry: expected a list of repositories');
  const repos: WorkspaceRepo[] = value.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid workspace_repos entry: expected an object with name, path and depends_on');
    const record = raw as Record<string, unknown>;
    const name = record.name; const path = record.path; const dependsOn = record.depends_on;
    if (typeof name !== 'string' || typeof path !== 'string' || !Array.isArray(dependsOn) || dependsOn.some((item) => typeof item !== 'string')) {
      throw new Error('Invalid workspace_repos entry: name, path and depends_on are required');
    }
    return { name, path, depends_on: dependsOn as string[] };
  });
  const roots = repos.filter((repo) => repo.name === 'workspace');
  if (roots.length !== 1) throw new Error('workspace_repos must declare exactly one reserved "workspace" root entry');
  const root = roots[0] as WorkspaceRepo;
  if (root.path !== '.') throw new Error('workspace repository "workspace" must use path "."');
  if (root.depends_on.length > 0) throw new Error('workspace repository "workspace" must use empty depends_on');
  const names = new Set<string>();
  for (const repo of repos) {
    if (names.has(repo.name)) throw new Error(`duplicate workspace repository name: ${repo.name}`);
    names.add(repo.name);
  }
  for (const repo of repos) if (repo.name !== 'workspace' && repo.path === '.') throw new Error('workspace repository path "." is reserved for the workspace root entry');
  for (const repo of repos) for (const dependency of repo.depends_on) if (!names.has(dependency)) throw new Error(`unknown workspace repository dependency: ${repo.name} -> ${dependency}`);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new Error(`workspace repository dependency cycle: ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of repos.find((repo) => repo.name === name)?.depends_on ?? []) visit(dependency);
    visiting.delete(name); visited.add(name);
  };
  for (const repo of repos) visit(repo.name);
  return repos;
}

/**
 * Parse the optional `workspace_finalization` frontmatter declaration. It is valid only for a
 * child-participating workspace plan; every read/write scope must be a non-escaping project path.
 */
function parseWorkspaceFinalization(value: unknown, repos: WorkspaceRepo[] | undefined): WorkspaceFinalization | undefined {
  if (value === undefined) return undefined;
  if (repos === undefined || repos.every((repo) => repo.name === 'workspace')) throw new Error('workspace_finalization requires at least one participating non-root repository');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace_finalization: expected an object');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.requirements) || record.requirements.some((item) => typeof item !== 'string')) throw new Error('Invalid workspace_finalization requirements: expected a list of strings');
  if (!Array.isArray(record.acceptance_criteria) || record.acceptance_criteria.some((item) => typeof item !== 'string')) throw new Error('Invalid workspace_finalization acceptance_criteria: expected a list of strings');
  if (!Array.isArray(record.read_scope)) throw new Error('Invalid workspace_finalization read_scope: expected a list of repository-qualified entries');
  const declaredNames = new Set(repos.map((repo) => repo.name));
  const readScope: WorkspaceFinalizationReadScope[] = record.read_scope.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid workspace_finalization read_scope entry: expected { repo, paths }');
    const entry = raw as Record<string, unknown>;
    if (typeof entry.repo !== 'string' || entry.repo.length === 0) throw new Error('Invalid workspace_finalization read_scope entry: missing repo');
    if (!declaredNames.has(entry.repo)) throw new Error(`workspace_finalization read_scope references unknown repository: ${entry.repo}`);
    if (!Array.isArray(entry.paths) || entry.paths.some((path) => typeof path !== 'string')) throw new Error('Invalid workspace_finalization read_scope paths: expected a list of strings');
    const normalized = normalizeProjectPaths(entry.paths as string[]);
    if (normalized.errors.length) throw new Error(`Invalid workspace_finalization read_scope path: ${normalized.errors.join('; ')}`);
    return { repo: entry.repo, paths: normalized.paths };
  });
  if (!Array.isArray(record.write_scope) || record.write_scope.some((path) => typeof path !== 'string')) throw new Error('Invalid workspace_finalization write_scope: expected a list of strings');
  const writeScope = normalizeProjectPaths(record.write_scope as string[]);
  if (writeScope.errors.length) throw new Error(`Invalid workspace_finalization write_scope path: ${writeScope.errors.join('; ')}`);
  for (const path of writeScope.paths) {
    for (const repo of repos) {
      if (repo.name === 'workspace') continue;
      if (pathIsWithin(repo.path, path)) throw new Error(`Invalid workspace_finalization write_scope path "${path}": inside participating repository "${repo.name}"`);
    }
  }
  if (record.test_commands !== undefined && (!Array.isArray(record.test_commands) || record.test_commands.some((command) => typeof command !== 'string'))) throw new Error('Invalid workspace_finalization test_commands: expected a list of strings');
  return {
    requirements: record.requirements as string[],
    acceptanceCriteria: record.acceptance_criteria as string[],
    readScope,
    writeScope: writeScope.paths,
    testCommands: record.test_commands === undefined ? [] : record.test_commands as string[],
  };
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
  const pairErrors: string[] = [];
  await validatePlanPair(planAnchor(directory, 'spec.md'), pairErrors);
  await validatePlanPair(planAnchor(directory, 'plan.md'), pairErrors);
  if (pairErrors.length) throw new Error(pairErrors.join('\n'));
  const workspaceRepos = parseWorkspaceRepos(planDoc.attributes.workspace_repos);
  const workspaceFinalization = parseWorkspaceFinalization(planDoc.attributes.workspace_finalization, workspaceRepos);
  const document: PlanDocument = { planId, status: 'frozen', requirements, acceptanceCriteria, specDigest, planDigest, digest: frozenPlanDigest(spec, plan), directory };
  if (workspaceRepos) document.workspaceRepos = workspaceRepos;
  if (workspaceFinalization) document.workspaceFinalization = workspaceFinalization;
  return document;
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
  for (const name of names.filter((item) => item.endsWith('.md') && !item.endsWith('.zh.md')).sort()) {
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
    const rawRepo = a.repo;
    let repo: string | undefined;
    if (plan.workspaceRepos) {
      if (typeof rawRepo !== 'string' || rawRepo.length === 0) throw new Error(`Task must declare repo: ${id}`);
      if (!plan.workspaceRepos.some((entry) => entry.name === rawRepo)) throw new Error(`Task repo is not declared: ${id} -> ${rawRepo}`);
      repo = rawRepo;
    } else if (rawRepo !== undefined) {
      throw new Error(`Task must not declare repo outside a workspace plan: ${id}`);
    }
    tasks.push({ id, requirements, acceptanceCriteria, dependsOn, surface, readScope: scope.paths, writeScope: writeScope.paths, testCommands: listStrings(a.test_commands), path, ...(repo === undefined ? {} : { repo }) });
  }
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) for (const dependency of task.dependsOn) if (!ids.has(dependency)) throw new Error(`Unknown task dependency: ${task.id} -> ${dependency}`);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.repo === undefined) continue;
    for (const dependency of task.dependsOn) {
      const target = taskById.get(dependency);
      if (target && target.repo !== task.repo) throw new Error(`Cross-repository task dependency: ${task.id} -> ${dependency}`);
    }
  }
  if (tasks.length && (await readWorkspaceManifest(directory)) === undefined) {
    const coveredReqs = new Set(tasks.flatMap((task) => task.requirements)); const coveredAcs = new Set(tasks.flatMap((task) => task.acceptanceCriteria));
    if (plan.requirements.some((item) => !coveredReqs.has(item)) || plan.acceptanceCriteria.some((item) => !coveredAcs.has(item))) throw new Error('Frozen plan REQ/AC coverage is incomplete');
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => { if (visiting.has(id)) throw new Error(`Task dependency cycle: ${id}`); if (visited.has(id)) return; visiting.add(id); for (const dep of tasks.find((task) => task.id === id)?.dependsOn ?? []) visit(dep); visiting.delete(id); visited.add(id); };
  for (const task of tasks) visit(task.id);
  const pairErrors: string[] = [];
  for (const anchor of await enumeratePlanDocuments(directory, pairErrors)) {
    if (!anchor.path.startsWith(`${taskDir}${sep}`)) continue;
    await validatePlanPair(anchor, pairErrors);
  }
  if (pairErrors.length) throw new Error(pairErrors.join('\n'));
  return tasks;
}
