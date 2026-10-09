import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { exists } from '../utils/fs.js';
import { normalizeScope } from '../utils/paths.js';
import { pathIsWithin } from '../workflow/read-scope.js';
import type { SubmoduleDeclaration } from '../context/submodules.js';

const execFileAsync = promisify(execFile);

/** Run a read-only Git command; return its stdout, or undefined when Git fails. */
async function gitOutput(arguments_: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', arguments_);
    return stdout;
  } catch {
    return undefined;
  }
}

/** One changed path of a commit; a rename also carries its old endpoint. */
export interface CommitChange {
  status: string;
  path: string;
  fromPath?: string;
}

/** One `git ls-tree` entry. */
export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

/** `git -C <repository> symbolic-ref -q HEAD`; undefined on a detached HEAD or a Git failure. */
export async function symbolicHead(repository: string): Promise<string | undefined> {
  const ref = (await gitOutput(['-C', repository, 'symbolic-ref', '-q', 'HEAD']))?.trim();
  return ref ? ref : undefined;
}

/** `git -C <repository> status --porcelain`; undefined when Git fails. */
export async function workingTreeStatus(repository: string): Promise<string | undefined> {
  return gitOutput(['-C', repository, 'status', '--porcelain']);
}

/**
 * Verify one participating repository with read-only Git and return every unmet precondition.
 * A repository is declared only when `.gitmodules` has a declaration whose path equals the
 * manifest path and whose section name equals the manifest name.
 */
export async function repositoryPreconditionErrors(root: string, name: string, relativePath: string, declarations: SubmoduleDeclaration[]): Promise<string[]> {
  const errors: string[] = [];
  const declaration = declarations.find((entry) => entry.path === relativePath);
  if (declaration === undefined) {
    errors.push(`Repository "${name}" path "${relativePath}" is not a declared submodule of ${root}; declare it in .gitmodules or correct the plan's workspace_repos entry`);
    return errors;
  }
  if (declaration.name !== name) {
    errors.push(`Repository "${name}" path "${relativePath}" does not match the declared submodule "${declaration.name}" at "${declaration.path}"; correct the plan's workspace_repos entry to the declared submodule name`);
    return errors;
  }

  const repository = join(root, relativePath);
  if (!(await exists(repository))) {
    errors.push(`Repository "${name}" working tree is missing at ${repository}; run git submodule update --init`);
    return errors;
  }
  if (!(await exists(join(repository, '.ai-workflow', 'AGENTS.md')))) {
    errors.push(`Repository "${name}" is not an initialized ai-workflow project at ${repository}; run ai-workflow init ${repository} --upgrade`);
    return errors;
  }
  if ((await symbolicHead(repository)) === undefined) {
    errors.push(`Repository "${name}" is in detached HEAD; check out a branch before distributing`);
    return errors;
  }
  const status = await workingTreeStatus(repository);
  if (status === undefined) {
    errors.push(`Repository "${name}" working tree status could not be read`);
    return errors;
  }
  if (status.trim().length > 0) {
    errors.push(`Repository "${name}" has uncommitted changes; commit or stash them before distributing`);
  }
  return errors;
}

/**
 * The absolute Git common directory of a repository, resolved against that repository.
 * This is the shared identity of a repository and its linked worktrees, so a matching
 * path basename is not sufficient. Undefined when Git cannot resolve it.
 */
export async function gitCommonDirectory(repository: string): Promise<string | undefined> {
  const output = await gitOutput(['-C', repository, 'rev-parse', '--git-common-dir']);
  const common = output?.trim();
  if (common === undefined || common === '') return undefined;
  return resolve(repository, common);
}

/** True when `git cat-file -e <sha>^{commit}` succeeds; false for a missing commit or invalid repository. */
export async function commitExists(repository: string, sha: string): Promise<boolean> {
  const output = await gitOutput(['-C', repository, 'cat-file', '-e', `${sha}^{commit}`]);
  return output !== undefined;
}

/** Parent SHAs of a commit, excluding the commit itself; `[]` for a root commit and undefined on failure. */
export async function commitParents(repository: string, sha: string): Promise<string[] | undefined> {
  const output = await gitOutput(['-C', repository, 'show', '-s', '--format=%P', sha]);
  if (output === undefined) return undefined;
  const parents = output.trim();
  return parents === '' ? [] : parents.split(/\s+/);
}

/**
 * The changed paths of one commit via `git show --name-status -M`. A rename reports a status
 * starting with `R`, its old endpoint as `fromPath` and its new endpoint as `path`.
 */
export async function commitChanges(repository: string, sha: string): Promise<CommitChange[] | undefined> {
  const output = await gitOutput(['-C', repository, 'show', '--name-status', '-M', '--format=', sha]);
  if (output === undefined) return undefined;
  const changes: CommitChange[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const fields = line.split('\t');
    const status = fields[0];
    if (status === undefined || status === '') continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const fromPath = fields[1];
      const path = fields[2];
      if (fromPath === undefined || path === undefined) continue;
      changes.push({ status, path, fromPath });
    } else {
      const path = fields[1];
      if (path === undefined) continue;
      changes.push({ status, path });
    }
  }
  return changes;
}

/**
 * Pure scope check: every renamed endpoint must sit within a normalized allowed scope.
 * Returns one message per offending endpoint naming that path and the allowed scopes.
 */
export function scopeViolations(changes: CommitChange[], allowedScopes: string[]): string[] {
  const scopes = allowedScopes.map((scope) => normalizeScope(scope));
  const violations: string[] = [];
  for (const change of changes) {
    const endpoints = change.fromPath === undefined ? [change.path] : [change.path, change.fromPath];
    for (const endpoint of endpoints) {
      if (scopes.some((scope) => pathIsWithin(scope, endpoint))) continue;
      violations.push(`Changed path "${endpoint}" is outside every allowed scope (${scopes.join(', ')})`);
    }
  }
  return violations;
}

/** Parse `git ls-tree <sha> -- <paths>` into `mode type sha<TAB>path` entries; undefined on failure. */
export async function treeEntries(repository: string, sha: string, paths: string[]): Promise<TreeEntry[] | undefined> {
  const output = await gitOutput(['-C', repository, 'ls-tree', sha, '--', ...paths]);
  if (output === undefined) return undefined;
  const entries: TreeEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;
    const metadata = line.slice(0, tabIndex).split(/\s+/);
    const path = line.slice(tabIndex + 1);
    if (metadata.length < 3 || path === '') continue;
    entries.push({ mode: metadata[0] as string, type: metadata[1] as string, sha: metadata[2] as string, path });
  }
  return entries;
}

/**
 * Verify every delivery entry read-only before returning. An empty array means every commit
 * exists; each returned error names the repository and SHA. Nothing is staged.
 */
export async function verifyDeliveryCommits(entries: { repository: string; sha: string }[]): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of entries) {
    if (!(await commitExists(entry.repository, entry.sha))) {
      errors.push(`Delivery commit ${entry.sha} does not exist in repository ${entry.repository}`);
    }
  }
  return errors;
}
