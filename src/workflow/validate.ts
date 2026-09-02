import type { Workflow } from './types.js';
import { scopesOverlap } from '../utils/paths.js';
import { formatSchemaErrors } from '../utils/schema.js';
import { schemaValidator } from '../utils/schema.js';
import { normalizeProjectPaths, pathIsWithin, taskReadScopeDiagnostics, type TaskReadAuthorization } from './read-scope.js';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ValidationResult { valid: boolean; errors: string[]; topologicalOrder: string[] }

const codeExtension = /\.(?:c|cjs|cpp|css|go|h|html|java|js|jsx|mjs|py|rs|scss|sh|sql|swift|ts|tsx|vue)$/i;
function validDocumentationPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return !normalized.startsWith('src/') && !normalized.startsWith('tests/') && !normalized.startsWith('schemas/') && !normalized.startsWith('.ai-workflow/plans/') && !codeExtension.test(normalized);
}

export async function validateWorkflow(workflow: unknown, project?: string): Promise<ValidationResult> {
  const errors: string[] = []; const validator = await schemaValidator('workflow.schema.json');
  if (!validator(workflow)) errors.push(formatSchemaErrors(validator.errors));
  const value = workflow as Partial<Workflow>; const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  const ids = new Set<string>();
  const authorizations = Array.isArray(value.task_read_authorizations) ? value.task_read_authorizations as TaskReadAuthorization[] : [];
  const authorizationByTask = new Map<string, TaskReadAuthorization>();
  for (const authorization of authorizations) {
    if (authorizationByTask.has(authorization.task_id)) errors.push(`Duplicate task read authorization: ${authorization.task_id}`);
    const exactPaths = normalizeProjectPaths(authorization.exact_paths ?? []);
    const moduleDirectories = normalizeProjectPaths(authorization.module_directories ?? []);
    for (const diagnostic of [...exactPaths.errors, ...moduleDirectories.errors]) errors.push(`${authorization.task_id}: ${diagnostic}`);
    const normalizedAuthorization: TaskReadAuthorization = { task_id: authorization.task_id, exact_paths: exactPaths.paths, module_directories: moduleDirectories.paths };
    authorizationByTask.set(authorization.task_id, normalizedAuthorization);
    for (const directory of moduleDirectories.paths) {
      if (!project) { errors.push(`${authorization.task_id}: cannot verify new module directory without project root: ${directory}`); continue; }
      try { await lstat(resolve(project, directory)); errors.push(`${authorization.task_id}: new module directory already exists: ${directory}`); } catch { /* The authorized directory must be created by this task. */ }
    }
  }
  for (const node of nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`); ids.add(node.id);
    for (const dependency of node.depends_on ?? []) if (!nodes.some((candidate) => candidate.id === dependency)) errors.push(`${node.id} depends on unknown node ${dependency}`);
    if ((node.role === 'file-explorer' || node.role === 'researcher') && (node.write_scope?.length ?? 0) > 0) errors.push(`${node.role === 'researcher' ? 'Researcher' : 'File Explorer'} cannot write: ${node.id}`);
    if (node.role === 'documentation-maintainer' && (node.write_scope?.some((path) => !validDocumentationPath(path)) ?? false)) errors.push(`Documentation Maintainer scope must contain only non-code documentation: ${node.id}`);
    if (node.role === 'git-operator' && (node.write_scope?.some((path) => !path.startsWith('.ai-workflow/')) ?? false)) errors.push(`Git Operator scope must be explicit: ${node.id}`);
    if (node.task_id) {
      const authorization = authorizationByTask.get(node.task_id);
      if (!authorization) errors.push(`Missing task read authorization: ${node.task_id}`);
      else {
        for (const directory of authorization.module_directories) {
          const taskNodes = nodes.filter((candidate) => candidate.task_id === node.task_id);
          const writeScope = taskNodes.flatMap((candidate) => candidate.write_scope ?? []);
          if (!writeScope.some((scope) => pathIsWithin(directory, scope))) errors.push(`${node.task_id}: new module directory has no constrained write_scope: ${directory}`);
        }
        for (const diagnostic of taskReadScopeDiagnostics(node.read_scope ?? [], authorization)) errors.push(`${node.task_id}: ${diagnostic}`);
      }
    }
  }
  const dependsTransitively = (from: string, target: string, seen = new Set<string>()): boolean => { if (seen.has(from)) return false; seen.add(from); const current = nodes.find((item) => item.id === from); return (current?.depends_on ?? []).some((dependency) => dependency === target || dependsTransitively(dependency, target, seen)); };
  for (let left = 0; left < nodes.length; left++) for (let right = left + 1; right < nodes.length; right++) {
    const a = nodes[left]; const b = nodes[right]; if (a && b && scopesOverlap(a.write_scope ?? [], b.write_scope ?? []) && !(dependsTransitively(a.id, b.id) || dependsTransitively(b.id, a.id))) errors.push(`Overlapping write scopes require dependency: ${a.id}, ${b.id}`);
  }
  const order: string[] = []; const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => { if (visiting.has(id)) { errors.push(`Cycle detected at ${id}`); return; } if (visited.has(id)) return; visiting.add(id); const node = nodes.find((item) => item.id === id); for (const dep of node?.depends_on ?? []) visit(dep); visiting.delete(id); visited.add(id); order.push(id); };
  for (const node of nodes) visit(node.id);
  return { valid: errors.length === 0, errors, topologicalOrder: order };
}
