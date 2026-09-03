import { mkdir, lstat, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { objectDigest, sha256 } from '../utils/hash.js';
import { assertInside, normalizeScope } from '../utils/paths.js';

export type WorktreeEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface WorktreeEntry {
  path: string;
  type: WorktreeEntryType;
  mode: number;
  digest: string;
  target?: string;
}

export interface WorktreeAudit {
  root: string;
  entries: Readonly<Record<string, WorktreeEntry>>;
  digest: string;
  followed_symlinks: false;
  errors: string[];
}

export interface WorktreeAuditComparison {
  status: 'clean' | 'audit_failed';
  before_digest: string;
  after_digest: string;
  digest: string;
  changed_paths: string[];
  out_of_scope_paths: string[];
  errors: string[];
  followed_symlinks: false;
  quarantined: boolean;
}

export interface QuarantineEvidence {
  marker: '.ai-workflow/quarantine.json';
  reason: string;
  created_at: string;
}

const quarantineMarker = '.ai-workflow/quarantine.json' as const;

function entryType(stat: Awaited<ReturnType<typeof lstat>>): WorktreeEntryType {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

function entryDigest(entry: Omit<WorktreeEntry, 'digest'>): string {
  return objectDigest(entry);
}

function inScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

function normalizedScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map(normalizeScope))];
}

export async function captureWorktreeAudit(root: string): Promise<WorktreeAudit> {
  const absoluteRoot = resolve(root);
  const entries: Record<string, WorktreeEntry> = {};
  const errors: string[] = [];

  async function walk(absolutePath: string): Promise<void> {
    const path = relative(absoluteRoot, absolutePath).replaceAll('\\', '/');
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(absolutePath);
    } catch (error) {
      errors.push(`${path || '.'}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const type = entryType(stat);
    let target: string | undefined;
    let contentDigest = objectDigest({ type, mode: stat.mode & 0o7777 });
    if (type === 'symlink') {
      try {
        target = await readlink(absolutePath);
        contentDigest = sha256(target);
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (type === 'file') {
      try {
        contentDigest = sha256(await readFile(absolutePath));
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (path) {
      const base = { path, type, mode: stat.mode & 0o7777, digest: contentDigest, ...(target === undefined ? {} : { target }) };
      entries[path] = { ...base, digest: entryDigest(base) };
    }
    if (type === 'directory') {
      let names: string[];
      try { names = await readdir(absolutePath); } catch (error) { errors.push(`${path || '.'}: ${error instanceof Error ? error.message : String(error)}`); return; }
      for (const name of names.sort()) await walk(join(absolutePath, name));
    }
  }

  await walk(absoluteRoot);
  return {
    root: absoluteRoot,
    entries,
    digest: objectDigest(Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)))),
    followed_symlinks: false,
    errors,
  };
}

export function compareWorktreeAudits(
  before: WorktreeAudit,
  after: WorktreeAudit,
  writeScopes: readonly string[],
  screenshotScopes: readonly string[] = [],
): WorktreeAuditComparison {
  const paths = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort();
  const changedPaths = paths.filter((path) => before.entries[path]?.digest !== after.entries[path]?.digest);
  const allowed = normalizedScopes([...writeScopes, ...screenshotScopes]);
  const outOfScope = changedPaths.filter((path) => path === '.git' || path.startsWith('.git/') || !inScope(path, allowed));
  const errors = [...before.errors, ...after.errors];
  const status = errors.length || outOfScope.length ? 'audit_failed' : 'clean';
  return {
    status,
    before_digest: before.digest,
    after_digest: after.digest,
    digest: objectDigest({ before: before.digest, after: after.digest, changed_paths: changedPaths, out_of_scope_paths: outOfScope, errors }),
    changed_paths: changedPaths,
    out_of_scope_paths: outOfScope,
    errors,
    followed_symlinks: false,
    quarantined: false,
  };
}

export async function quarantineWorktree(root: string, reason: string): Promise<QuarantineEvidence> {
  if (!reason) throw new Error('quarantine reason must be non-empty');
  const absoluteRoot = resolve(root);
  const createdAt = new Date().toISOString();
  const evidence: QuarantineEvidence = { marker: quarantineMarker, reason, created_at: createdAt };
  const marker = assertInside(absoluteRoot, quarantineMarker);
  await mkdir(join(absoluteRoot, '.ai-workflow'), { recursive: true });
  await writeFile(marker, `${JSON.stringify({ quarantined: true, ...evidence })}\n`, { encoding: 'utf8' });
  return evidence;
}

export async function isWorktreeQuarantined(root: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(join(resolve(root), quarantineMarker), 'utf8')) as { quarantined?: unknown };
    return value.quarantined === true;
  } catch {
    return false;
  }
}
