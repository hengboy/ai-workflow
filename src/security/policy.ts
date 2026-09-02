import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { sha256 } from '../utils/hash.js';
import { assertInside, normalizeScope } from '../utils/paths.js';
import type { Node, Role } from '../workflow/types.js';

const gitMutation = /(?:^|\s)git\s+(?:add|commit|checkout|switch|branch|merge|rebase|reset|clean|worktree|tag|push|pull|fetch)\b/;
const repositorySearch = /(?:^|\s)(?:rg|grep|find|fd|locate)\b/;
const fileMutation = /(?:^|\s)(?:touch|mkdir|cp|mv|install|tee|dd|truncate)\b|(?:^|\s)(?:sed|perl)\s+[^\n]*\s-i(?:\s|$)|(?:^|\s)[^\n]+(?:>>|>)[^\n]*/;
const dangerous = /(?:^|\s)(?:sudo|rm\s+-rf|chmod\s+777|curl[^|]*\||wget[^|]*\|)/;

export function validateRoleCommand(role: Role, command: string): string | undefined {
  if (dangerous.test(command)) return 'Dangerous command is denied';
  if (role === 'researcher') return 'Researcher may only use web-link analysis';
  if (role === 'documentation-maintainer' && (gitMutation.test(command) || repositorySearch.test(command))) return 'Documentation Maintainer may only maintain documentation';
  if (role === 'file-explorer' && fileMutation.test(command)) return 'File Explorer is read-only';
  if (role !== 'git-operator' && gitMutation.test(command)) return 'Only Git Operator may mutate Git';
  if (role !== 'file-explorer' && repositorySearch.test(command)) return 'Only File Explorer may search the repository';
  return undefined;
}

export function validateChangedPaths(node: Node, changedPaths: string[], screenshotDir: string): string[] {
  const errors: string[] = []; const scopes = node.write_scope.map(normalizeScope); const screenshotScope = normalizeScope(screenshotDir);
  if (node.role === 'researcher' && changedPaths.length > 0) return ['Researcher cannot modify files'];
  if (node.role === 'file-explorer' && changedPaths.length > 0) return ['File Explorer cannot modify files'];
  for (const path of changedPaths.map(normalizeScope)) {
    if (!scopes.some((scope) => path === scope || path.startsWith(`${scope}/`))) errors.push(`Write outside scope: ${path}`);
    if (/\.(?:png|jpe?g|webp)$/i.test(path) && !(path === screenshotScope || path.startsWith(`${screenshotScope}/`))) errors.push(`Screenshot outside plan directory: ${path}`);
  }
  return errors;
}

export async function snapshot(root: string, scopes: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string): Promise<void> {
    const stat = await lstat(path); if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const name of await readdir(path)) await walk(join(path, name)); }
    else result[relative(root, path).replaceAll('\\', '/')] = sha256(await readFile(path));
  }
  for (const scope of scopes) { const path = assertInside(root, scope); try { await walk(resolve(path)); } catch { /* missing scope is valid before writes */ } }
  return result;
}

export function snapshotChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).sort();
}

export function redact(value: string): string {
  return value.replace(/(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED]').replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, '$1[REDACTED]');
}
