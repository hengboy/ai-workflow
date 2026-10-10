import { mkdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { atomicWrite } from '../utils/fs.js';
import { noteClasses, noteLifecycles } from '../notes/index.js';
import { resolveTemplateSnapshot, type GitRunner } from './source.js';
import {
  archiveManifestTarget,
  emptyArchiveManifest,
  generatedArtifacts,
  hasLegacySectionMarker,
  validateGeneratedSnapshot,
} from './artifacts.js';

export type SyncStatus = 'synchronized' | 'unverified' | 'needs_attention' | 'pending' | 'conflict' | 'failed';

export interface SyncWarning {
  reason: string;
  path?: string;
  section?: string;
}

export interface SyncReport {
  project: string;
  source: { repository: string; branch: string; commit: string | null };
  status: SyncStatus;
  verified: boolean;
  proceed: boolean;
  check: boolean;
  created: string[];
  updated: string[];
  skipped: string[];
  warnings: SyncWarning[];
  conflicts: SyncWarning[];
}

export interface SynchronizeProjectOptions {
  projectRoot: string;
  check?: boolean;
  runGit?: GitRunner;
}

export function notesStructureDirectories(): string[] {
  const directories = ['.ai-workflow/notes'];
  for (const lifecycle of noteLifecycles) {
    directories.push(`.ai-workflow/notes/${lifecycle}`);
    for (const noteClass of noteClasses) directories.push(`.ai-workflow/notes/${lifecycle}/${noteClass}`);
  }
  return directories;
}

const legacyIgnoreLines = new Set(['.ai-workflow', '.ai-workflow/', 'MEMORY.md']);
function missingIgnoreLines(original: string): string[] {
  const lines = original.split(/\r?\n/).map((line) => line.trim());
  const has = (candidates: string[]): boolean => lines.some((line) => candidates.includes(line));
  const additions: string[] = [];
  if (!has(['.ai-workflow/plans', '.ai-workflow/plans/'])) additions.push('.ai-workflow/plans/');
  if (!has(['.worktrees', '.worktrees/'])) additions.push('.worktrees/');
  return additions;
}

// Legacy versions ignored the whole `.ai-workflow/` tree and `MEMORY.md`. Migrate those entries
// in place so only `.ai-workflow/plans/` stays ignored and the rest travels with Git.
export function reconcileIgnoreFile(original: string): string | undefined {
  const lines = original.split('\n');
  const retained = lines.filter((line) => !legacyIgnoreLines.has(line.trim()));
  const additions = missingIgnoreLines(retained.join('\n'));
  if (retained.length === lines.length && additions.length === 0) return undefined;
  const body = retained.join('\n').trimEnd();
  return `${body}${body ? '\n' : ''}${additions.join('\n')}${additions.length ? '\n' : ''}`;
}

function isArchiveManifest(contents: string): boolean {
  try {
    const parsed = JSON.parse(contents) as { version?: unknown; files?: unknown };
    return Boolean(parsed) && parsed.version === 1 && typeof parsed.files === 'object' && parsed.files !== null && !Array.isArray(parsed.files);
  } catch { return false; }
}

function byPath(left: SyncWarning, right: SyncWarning): number {
  const a = left.path;
  const b = right.path;
  if (a === undefined || b === undefined) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function synchronizeProject(options: SynchronizeProjectOptions): Promise<SyncReport> {
  const requestedRoot = resolve(options.projectRoot);
  let projectRoot = requestedRoot;
  while (true) {
    try { await stat(join(projectRoot, '.ai-workflow')); break; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(projectRoot);
    if (parent === projectRoot) { projectRoot = requestedRoot; break; }
    projectRoot = parent;
  }
  options = { ...options, projectRoot };
  const prerequisiteConflicts: SyncWarning[] = [];
  for (const path of ['.ai-workflow', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md', 'MEMORY.md']) {
    try {
      const entry = await stat(join(projectRoot, path));
      if (path === '.ai-workflow' ? !entry.isDirectory() : !entry.isFile()) {
        prerequisiteConflicts.push({ path, reason: path === '.ai-workflow' ? 'Adoption prerequisite must be a directory' : 'Adoption prerequisite must be a file' });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      prerequisiteConflicts.push({ path, reason: 'Required adoption prerequisite is missing; synchronization does not initialize a project' });
    }
  }
  if (prerequisiteConflicts.length) {
    return {
      project: projectRoot,
      source: { repository: 'hengboy/ai-workflow', branch: 'main', commit: null },
      status: 'conflict',
      verified: false,
      proceed: false,
      check: options.check ?? false,
      created: [],
      updated: [],
      skipped: [],
      warnings: [],
      conflicts: prerequisiteConflicts,
    };
  }
  let snapshot: Awaited<ReturnType<typeof resolveTemplateSnapshot>>;
  try {
    snapshot = await resolveTemplateSnapshot({
      ...(options.runGit === undefined ? {} : { runGit: options.runGit }),
    });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)) || 'Template source acquisition failed';
    const path = reason.match(/templates\/project\/[^\s?]+/)?.[0];
    return {
      project: options.projectRoot,
      source: { repository: 'hengboy/ai-workflow', branch: 'main', commit: null },
      status: 'unverified',
      verified: false,
      proceed: true,
      check: options.check ?? false,
      created: [],
      updated: [],
      skipped: [],
      warnings: [{ reason, ...(path ? { path } : {}) }],
      conflicts: [],
    };
  }
  return applyTemplateSnapshot(options, snapshot);
}

interface PendingChange {
  path: string;
  contents: string;
  original: Buffer | undefined;
}

/**
 * Shared publication core used by remote synchronization and shipped-template upgrade.
 * It validates the complete five-member snapshot, preflights every writable target and
 * required path, then replaces generated files as complete bytes with invocation-local recovery.
 */
export async function applyTemplateSnapshot(
  options: Pick<SynchronizeProjectOptions, 'projectRoot' | 'check'>,
  snapshot: { source: SyncReport['source']; files: Record<string, string> },
): Promise<SyncReport> {
  const warnings: SyncWarning[] = snapshot.source.commit === null
    ? [{ reason: 'Local shipped templates were used; the current upstream snapshot has not been verified' }]
    : [];
  const conflicts: SyncWarning[] = [];
  const snapshotError = validateGeneratedSnapshot(snapshot.files);
  if (snapshotError !== undefined) {
    return {
      project: options.projectRoot,
      source: snapshot.source,
      status: 'unverified',
      verified: false,
      proceed: true,
      check: options.check ?? false,
      created: [],
      updated: [],
      skipped: [],
      warnings: [...warnings, { path: snapshotError.path, reason: `Generated source snapshot is invalid: ${snapshotError.reason}` }],
      conflicts: [],
    };
  }

  const changes: PendingChange[] = [];
  const skipped: string[] = [];
  for (const artifact of generatedArtifacts) {
    const targetPath = artifact.target;
    const template = snapshot.files[artifact.source];
    if (template === undefined) continue;
    let original: Buffer | undefined;
    try {
      const target = join(options.projectRoot, targetPath);
      if ((await stat(target)).isDirectory()) {
        conflicts.push({ path: targetPath, reason: 'A directory occupies the generated file' });
        continue;
      }
      original = await readFile(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR') {
        conflicts.push({ path: targetPath, reason: 'A generated file parent is not a directory' });
        continue;
      }
      if (code !== 'ENOENT') throw error;
    }
    if (original !== undefined && hasLegacySectionMarker(original.toString('utf8'))) {
      conflicts.push({ path: targetPath, reason: 'Legacy section markers are not supported; replace this generated file manually instead of merging it' });
      continue;
    }
    if (original === undefined) changes.push({ path: targetPath, contents: template, original: undefined });
    else if (!original.equals(Buffer.from(template, 'utf8'))) changes.push({ path: targetPath, contents: template, original });
    else skipped.push(targetPath);
  }

  const archivePath = join(options.projectRoot, archiveManifestTarget);
  let archiveOriginal: Buffer | undefined;
  let archiveOccupied = false;
  try {
    if ((await stat(archivePath)).isDirectory()) {
      conflicts.push({ path: archiveManifestTarget, reason: 'A directory occupies the archive manifest' });
      archiveOccupied = true;
    } else {
      archiveOriginal = await readFile(archivePath);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') {
      conflicts.push({ path: archiveManifestTarget, reason: 'The archive manifest parent is not a directory' });
      archiveOccupied = true;
    } else if (code !== 'ENOENT') throw error;
  }
  if (!archiveOccupied) {
    if (archiveOriginal === undefined) changes.push({ path: archiveManifestTarget, contents: emptyArchiveManifest, original: undefined });
    else if (isArchiveManifest(archiveOriginal.toString('utf8'))) skipped.push(archiveManifestTarget);
    else conflicts.push({ path: archiveManifestTarget, reason: 'Existing archive manifest is invalid; it cannot be replaced' });
  }

  const missingDirectories: string[] = [];
  for (const directory of notesStructureDirectories()) {
    try {
      if ((await stat(join(options.projectRoot, directory))).isDirectory()) skipped.push(directory);
      else conflicts.push({ path: directory, reason: 'A required notes directory is occupied by a non-directory' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') missingDirectories.push(directory);
      else if (code === 'ENOTDIR') conflicts.push({ path: directory, reason: 'A required notes directory parent is not a directory' });
      else throw error;
    }
  }

  let ignoreOriginal: Buffer | undefined;
  try { ignoreOriginal = await readFile(join(options.projectRoot, '.gitignore')); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'ENOTDIR') conflicts.push({ path: '.gitignore', reason: 'The ignore file or its parent has an invalid filesystem structure' });
    else if (code !== 'ENOENT') throw error;
  }
  const ignoreContents = reconcileIgnoreFile(ignoreOriginal?.toString('utf8') ?? '');
  if (ignoreContents === undefined) skipped.push('.gitignore');
  else changes.push({ path: '.gitignore', contents: ignoreContents, original: ignoreOriginal });

  if (conflicts.length) {
    return {
      project: options.projectRoot,
      source: snapshot.source,
      status: 'conflict',
      verified: false,
      proceed: false,
      check: options.check ?? false,
      created: [],
      updated: [],
      skipped: skipped.sort(),
      warnings,
      conflicts: conflicts.sort(byPath),
    };
  }

  const createdDirectories: string[] = [];
  if (!options.check) {
    const attempted: PendingChange[] = [];
    let publishingPath = '';
    try {
      for (const directory of missingDirectories) {
        publishingPath = directory;
        await mkdir(join(options.projectRoot, directory));
        createdDirectories.push(directory);
      }
      for (const change of changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
        publishingPath = change.path;
        attempted.push(change);
        const target = join(options.projectRoot, change.path);
        const missingParents: string[] = [];
        let directory = dirname(target);
        while (true) {
          try { await stat(directory); break; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            missingParents.push(directory);
            directory = dirname(directory);
          }
        }
        for (const parent of missingParents.reverse()) {
          await mkdir(parent);
          createdDirectories.push(relative(options.projectRoot, parent));
        }
        await atomicWrite(target, change.contents);
      }
    } catch (error) {
      const failure: SyncWarning = { path: publishingPath, reason: `Publication failed: ${error instanceof Error ? error.message : String(error)}` };
      const recoveryWarnings: SyncWarning[] = [];
      for (const change of attempted.reverse()) {
        const target = join(options.projectRoot, change.path);
        try {
          if (change.original === undefined) await rm(target, { force: true });
          else await atomicWrite(target, change.original);
        } catch (recoveryError) {
          recoveryWarnings.push({ path: change.path, reason: `Recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}` });
        }
      }
      for (const directory of createdDirectories.slice().reverse()) {
        try { await rmdir(join(options.projectRoot, directory)); } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          recoveryWarnings.push({ path: directory, reason: `Directory recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}` });
        }
      }
      return {
        project: options.projectRoot,
        source: snapshot.source,
        status: 'failed',
        verified: false,
        proceed: false,
        check: false,
        created: [],
        updated: [],
        skipped: skipped.sort(),
        warnings: [failure, ...recoveryWarnings, ...warnings],
        conflicts: [],
      };
    }
  }

  const pending = Boolean(options.check && (changes.length || missingDirectories.length));
  return {
    project: options.projectRoot,
    source: snapshot.source,
    status: pending ? 'pending' : warnings.length ? 'needs_attention' : 'synchronized',
    verified: !pending && warnings.length === 0,
    proceed: !pending,
    check: options.check ?? false,
    created: changes.filter((change) => change.original === undefined).map((change) => change.path).sort(),
    updated: changes.filter((change) => change.original !== undefined).map((change) => change.path).sort(),
    skipped: skipped.sort(),
    warnings,
    conflicts: [],
  };
}
