import { mkdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { atomicWrite } from '../utils/fs.js';
import { noteClasses, noteLifecycles } from '../notes/index.js';
import { resolveTemplateSnapshot, type GitRunner } from './source.js';
import { mergeOwnedSections, OwnershipConflictError, validateOwnedSections } from './merge.js';

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

const projectTargets: Record<string, string> = {
  'templates/project/AGENTS.md': '.ai-workflow/AGENTS.md',
  'templates/project/MEMORY.md': 'MEMORY.md',
  'templates/project/navigation.json': '.ai-workflow/index/navigation.json',
  'templates/project/navigation.md': '.ai-workflow/index/navigation.md',
  'templates/project/notes/AGENTS.md': '.ai-workflow/notes/AGENTS.md',
  'templates/project/notes/README.md': '.ai-workflow/notes/README.md',
  'templates/project/notes/implemented/AGENTS.md': '.ai-workflow/notes/implemented/AGENTS.md',
  'templates/project/notes/archived/AGENTS.md': '.ai-workflow/notes/archived/AGENTS.md',
  'templates/project/notes/archived/manifest.json': '.ai-workflow/notes/archived/manifest.json',
};
const archiveManifestRelative = '.ai-workflow/notes/archived/manifest.json';
const preservedTargets = new Set(['.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md', archiveManifestRelative]);

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
      source: { repository: 'hengboy/ai-workflow', branch: 'simplify', commit: null },
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
      source: { repository: 'hengboy/ai-workflow', branch: 'simplify', commit: null },
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

/** Internal shared patch transaction; callers establish adoption and acquire the snapshot. */
export async function applyTemplateSnapshot(
  options: Pick<SynchronizeProjectOptions, 'projectRoot' | 'check'>,
  snapshot: { source: SyncReport['source']; files: Record<string, string> },
): Promise<SyncReport> {
  const changes: Array<{ path: string; contents: string; original: Buffer | undefined }> = [];
  const skipped: string[] = [];
  const warnings: SyncWarning[] = snapshot.source.commit === null
    ? [{ reason: 'Local shipped templates were used; the current upstream snapshot has not been verified' }]
    : [];
  const conflicts: SyncWarning[] = [];
  for (const [sourcePath, targetPath] of Object.entries(projectTargets)) {
    let original: Buffer | undefined;
    try {
      const target = join(options.projectRoot, targetPath);
      if ((await stat(target)).isDirectory()) {
        conflicts.push({ path: targetPath, reason: 'A directory occupies the managed file' });
        continue;
      }
      original = await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        conflicts.push({ path: targetPath, reason: 'A managed file parent is not a directory' });
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      const originalContents = original?.toString('utf8');
      const template = snapshot.files[sourcePath];
      if (template === undefined) {
        if (originalContents !== undefined) {
          if (!preservedTargets.has(targetPath)) validateOwnedSections(originalContents);
          warnings.push({ path: targetPath, reason: 'Supported source artifact is retired; the existing target is preserved' });
        }
        skipped.push(targetPath);
        continue;
      }
      if (targetPath === archiveManifestRelative) {
        if (originalContents !== undefined) {
          if (isArchiveManifest(originalContents)) skipped.push(targetPath);
          else conflicts.push({ path: targetPath, reason: 'Existing archive manifest is invalid; it cannot be replaced' });
        } else if (!isArchiveManifest(template) || Object.keys((JSON.parse(template) as { files: object }).files).length !== 0) {
          conflicts.push({ path: targetPath, reason: 'A missing archive manifest requires an empty valid source manifest' });
        } else {
          changes.push({ path: targetPath, contents: template, original });
        }
        continue;
      }
      if (preservedTargets.has(targetPath)) { skipped.push(targetPath); continue; }
      const merged = mergeOwnedSections(originalContents ?? '', template);
      const contents = original === undefined ? template : merged.contents;
      warnings.push(...merged.warnings.map((warning) => ({ ...warning, path: targetPath })));
      if (contents === originalContents) skipped.push(targetPath);
      else changes.push({ path: targetPath, contents, original });
    } catch (error) {
      if (!(error instanceof OwnershipConflictError)) throw error;
      conflicts.push({ path: targetPath, reason: error.message, ...(error.section ? { section: error.section } : {}) });
    }
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
      conflicts: conflicts.sort((left, right) => {
        const a = left.path;
        const b = right.path;
        if (a === undefined || b === undefined) return 0;
        return a < b ? -1 : a > b ? 1 : 0;
      }),
    };
  }
  const createdDirectories: string[] = [];
  if (!options.check) {
    const attempted: typeof changes = [];
    let publishingPath = '';
    try {
      for (const directory of missingDirectories) {
        publishingPath = directory;
        const target = join(options.projectRoot, directory);
        await mkdir(target);
        createdDirectories.push(target);
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
          createdDirectories.push(parent);
        }
        await atomicWrite(target, change.contents);
      }
    } catch (error) {
      const failure: SyncWarning = { path: publishingPath, reason: `Publication failed: ${error instanceof Error ? error.message : String(error)}` };
      const recoveryWarnings: SyncWarning[] = [];
      for (const change of attempted.reverse()) {
        const target = join(options.projectRoot, change.path);
        try {
          if (change.original === undefined) {
            await rm(target, { force: true });
          } else {
            let current: Buffer | undefined;
            try { current = await readFile(target); } catch (recoveryError) {
              if ((recoveryError as NodeJS.ErrnoException).code !== 'ENOENT') throw recoveryError;
            }
            if (!current?.equals(change.original)) await atomicWrite(target, change.original);
          }
        } catch (recoveryError) {
          recoveryWarnings.push({ path: change.path, reason: `Recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}` });
        }
      }
      for (const directory of createdDirectories.reverse()) {
        try { await rmdir(directory); } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          recoveryWarnings.push({ path: relative(options.projectRoot, directory), reason: `Directory recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}` });
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
    created: [...changes.filter((change) => change.original === undefined).map((change) => change.path),
      ...(options.check ? missingDirectories : createdDirectories.map((directory) => relative(options.projectRoot, directory)))].sort(),
    updated: changes.filter((change) => change.original !== undefined).map((change) => change.path).sort(),
    skipped: skipped.sort(),
    warnings,
    conflicts: [],
  };
}
