import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { notesRoot } from './pairing.js';

const execFileAsync = promisify(execFile);

/** Project-relative archive manifest shared by sealing and validation. */
export const archiveManifestPath = `${notesRoot}/archived/manifest.json`;

/** The archive manifest payload; later releases change `version` rather than add a second store. */
export interface ArchiveManifest {
  version: 1;
  files: Record<string, string>;
}

/** The manifest resolved at one immutable baseline commit. */
export interface BaselineArchive {
  commit: string;
  files: Record<string, string>;
}

function failureMessage(error: unknown): string {
  const failure = error as { stderr?: string; message?: string };
  const output = (failure.stderr ?? failure.message ?? String(error)).trim();
  return output.split(/\r?\n/)[0] || 'git failed without output';
}

/** Run one read-only Git command inside the project working tree. */
async function git(project: string, arguments_: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', project, ...arguments_]);
    return stdout;
  } catch (error) {
    throw new Error(failureMessage(error));
  }
}

function parseManifest(commit: string, contents: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`baseline ${commit}: ${archiveManifestPath}: archive manifest must be readable JSON (${failureMessage(error)})`);
  }
  const manifest = parsed as Partial<ArchiveManifest> | null;
  if (manifest === null || typeof manifest !== 'object' || manifest.version !== 1
    || manifest.files === undefined || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error(`baseline ${commit}: ${archiveManifestPath}: archive manifest must be { version: 1, files: { <path>: sha256:<hex> } }`);
  }
  const files: Record<string, string> = {};
  for (const [key, digest] of Object.entries(manifest.files as Record<string, unknown>)) {
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`baseline ${commit}: ${archiveManifestPath}: entry ${key} must map to sha256:<hex>`);
    }
    files[key] = digest;
  }
  return files;
}

/**
 * Resolve `base` to one immutable commit and read the project archive manifest from that
 * Git tree. A commit without the manifest is a legitimate empty baseline. The project may be
 * the repository root, a subdirectory of it, or a linked worktree; the manifest path is always
 * resolved from the project directory through the repository prefix rather than the repository
 * root manifest. Unreadable Git state and malformed manifests fail instead of reading as empty.
 */
export async function readArchiveBaseline(project: string, base: string): Promise<BaselineArchive> {
  const ref = base.trim();
  if (ref === '') throw new Error('baseline ref is empty');
  let commit: string;
  try {
    commit = (await git(project, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  } catch (error) {
    throw new Error(`baseline ref "${ref}": not a readable Git commit (${failureMessage(error)})`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error(`baseline ref "${ref}": not an immutable Git commit`);
  }
  let prefix: string;
  let topLevel: string;
  try {
    prefix = (await git(project, ['rev-parse', '--show-prefix'])).trim();
    topLevel = (await git(project, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    throw new Error(`baseline ref "${ref}": ${project} is not a readable Git worktree (${failureMessage(error)})`);
  }
  if (topLevel === '') throw new Error(`baseline ref "${ref}": ${project} is not inside a Git worktree`);
  // `ls-tree` interprets paths relative to its working directory, so read the tree from
  // the repository/worktree root and keep the project prefix in the pathspec.
  const path = `${prefix}${archiveManifestPath}`;
  let listing: string;
  try {
    listing = await git(topLevel, ['ls-tree', '-z', commit, '--', path]);
  } catch (error) {
    throw new Error(`baseline ${commit}: ${archiveManifestPath}: cannot read the Git tree (${failureMessage(error)})`);
  }
  const entries = listing.split('\0').filter((entry) => entry !== '');
  if (entries.length === 0) return { commit, files: {} };
  if (entries.length > 1) throw new Error(`baseline ${commit}: ${archiveManifestPath}: expected one Git tree entry`);
  const [metadata, entryPath] = (entries[0] ?? '').split('\t');
  const [mode, type, object] = (metadata ?? '').split(' ');
  if (mode === undefined || entryPath !== path || type !== 'blob' || !object) {
    throw new Error(`baseline ${commit}: ${archiveManifestPath}: not a readable regular file`);
  }
  let contents: string;
  try {
    contents = await git(topLevel, ['cat-file', 'blob', object]);
  } catch (error) {
    throw new Error(`baseline ${commit}: ${archiveManifestPath}: unreadable archive manifest (${failureMessage(error)})`);
  }
  return { commit, files: parseManifest(commit, contents) };
}

/** Report every baseline entry that the current manifest dropped or rewrote. */
export function compareArchiveBaseline(
  manifestPath: string,
  baseline: BaselineArchive,
  current: Record<string, string>,
): string[] {
  const errors: string[] = [];
  for (const [key, digest] of Object.entries(baseline.files)) {
    const currentDigest = current[key];
    if (currentDigest === undefined) {
      errors.push(`${manifestPath}: ${key}: missing from the current archive manifest; baseline ${baseline.commit} sealed ${digest}`);
    } else if (currentDigest !== digest) {
      errors.push(`${manifestPath}: ${key}: sealed archive digest changed from baseline ${baseline.commit}: ${digest} -> ${currentDigest}`);
    }
  }
  return errors;
}
