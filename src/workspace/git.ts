import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exists } from '../utils/fs.js';
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
