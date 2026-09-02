import { posix } from 'node:path';

export const fixedTaskContext = ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'];

export interface TaskReadAuthorization {
  task_id: string;
  exact_paths: string[];
  module_directories: string[];
}

function invalidPath(path: string, reason: string): Error {
  return new Error(`Invalid path ${JSON.stringify(path)}: ${reason}`);
}

export function normalizeProjectPath(path: string): string {
  const portable = path.replaceAll('\\', '/');
  if (!portable) throw invalidPath(path, 'path is empty');
  if (/^[A-Za-z]:\//.test(portable) || portable.startsWith('/')) throw invalidPath(path, 'path must be project-relative');
  if (/[?*[\]{}$<>]/.test(portable)) throw invalidPath(path, 'wildcards are not allowed');
  const normalized = posix.normalize(portable).replace(/\/+$/, '');
  if (normalized === '.') throw invalidPath(path, 'project root is not allowed');
  if (normalized === '..' || normalized.startsWith('../')) throw invalidPath(path, 'path escapes the project');
  return normalized;
}

export function normalizeProjectPaths(paths: string[]): { paths: string[]; errors: string[] } {
  const normalized: string[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    try {
      const value = normalizeProjectPath(path);
      if (normalized.includes(value)) errors.push(`duplicate path: ${value}`);
      else normalized.push(value);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { paths: normalized, errors };
}

export function taskReadScope(task: TaskReadAuthorization): string[] {
  return [...new Set([...fixedTaskContext, ...task.exact_paths, ...task.module_directories].map(normalizeProjectPath))];
}

export function taskReadScopeDiagnostics(readScope: string[], authorization: TaskReadAuthorization): string[] {
  const normalized = normalizeProjectPaths(readScope);
  const authorized = new Set(taskReadScope(authorization));
  const diagnostics = [...normalized.errors];
  for (const path of normalized.paths) if (!authorized.has(path)) diagnostics.push(`unauthorized read_scope path: ${path}`);
  for (const path of authorized) if (!normalized.paths.includes(path)) diagnostics.push(`missing authorized read_scope path: ${path}`);
  return diagnostics;
}

export function pathIsWithin(scope: string, path: string): boolean {
  const relative = posix.relative(normalizeProjectPath(scope), normalizeProjectPath(path));
  return relative === '' || (relative !== '..' && !relative.startsWith('../'));
}
