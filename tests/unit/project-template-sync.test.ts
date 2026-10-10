import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { synchronizeProject } from '../../src/sync/index.js';
import { exists } from '../../src/utils/fs.js';
import { changedPaths, fakeGit, snapshotTree, temporary } from '../helpers.js';

// A mutable hook injects one ordinary filesystem failure for a chosen managed path while
// every other atomic write keeps the real behavior. It affects only this test process.
const fsControl = vi.hoisted(() => ({ failPath: null as string | null }));

vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/fs.js')>();
  return {
    ...actual,
    atomicWrite: async (path: string, contents: string | Buffer): Promise<void> => {
      if (fsControl.failPath !== null && path.endsWith(fsControl.failPath)) {
        throw new Error(`injected write failure: ${path}`);
      }
      await actual.atomicWrite(path, contents);
    },
  };
});

const REPOSITORY = 'hengboy/ai-workflow';
const BRANCH = 'main';
const COMMIT = 'a'.repeat(40);

const GENERATED_TARGETS = [
  '.ai-workflow/AGENTS.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
] as const;

// Independent source snapshot literals: five markerless generated files.
const SOURCE_AGENTS = '# ai-workflow project contract\n\nFresh contract body from the immutable snapshot.\n';
const SOURCE_NOTES_AGENTS = '# Agent Notes instructions\n\nFresh notes instructions.\n';
const SOURCE_README = '# Agent Notes\n\nFresh notes readme.\n';
const SOURCE_IMPLEMENTED = '# Implemented notes instructions\n\nFresh implemented instructions.\n';
const SOURCE_ARCHIVED = '# Archived notes instructions\n\nFresh archived instructions.\n';

const SOURCE: Record<string, string> = {
  'templates/project/AGENTS.md': SOURCE_AGENTS,
  'templates/project/notes/AGENTS.md': SOURCE_NOTES_AGENTS,
  'templates/project/notes/README.md': SOURCE_README,
  'templates/project/notes/implemented/AGENTS.md': SOURCE_IMPLEMENTED,
  'templates/project/notes/archived/AGENTS.md': SOURCE_ARCHIVED,
};

// Stale markerless generated targets that a complete replacement must overwrite.
const STALE_AGENTS = '# ai-workflow project contract\n\nStale local body that must be fully replaced.\n';
const STALE_NOTES_AGENTS = '# Agent Notes instructions\n\nStale notes instructions.\n';
const STALE_README = '# Agent Notes\n\nStale notes readme.\n';

const MEMORY_BYTES = '# Project memory\r\n\r\nIndependent project standard that must survive synchronization.\r\n';
const ROOT_USER_AGENTS = '# User root agents\n\nUser-owned root file.\n';
const ROOT_USER_CLAUDE = '# User root claude\n\nUser-owned root file.\n';
const PROJECT_CONFIG_BYTES = 'version: 1\nmodules: []\nfeatures: []\n';
const NOTE_BYTES = '# Agent Note: custom\n\nIndependent note bytes.\n';
const SEALED_BYTES = '# Agent Note: sealed\n\nStatus: implemented\nArchived: 2026-04-01\n\nSealed history bytes.\n';
const FROZEN_PLAN_BYTES = '---\nplan_id: "20260101-frozen"\nstatus: frozen\n---\n\n# Frozen plan\n\nIndependent frozen plan bytes.\n';
const MANIFEST_BYTES = `${JSON.stringify({ version: 1, files: { 'archived/architecture/2026-04-01-sealed.md': 'sha256:deadbeef' } }, null, 2)}\n`;

const navigationJson = `${JSON.stringify(
  {
    version: 1,
    module_roots: [{ id: 'src', path: 'src', owner_role: 'shared', responsibility: 'adopted module', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [{
      id: 'src', name: 'src', aliases: [], module_root: 'src', entries: ['src/index.ts'], symbols: [], related_files: [],
      tests: [], depends_on: [], relations: [], owner_role: 'shared', responsibility: 'adopted module',
      read_scope: ['src/index.ts'], shared_entry: false,
    }],
  },
  null,
  2,
)}\n`;
const navigationMarkdown = '# Navigation\n\nAdopted navigation bytes that must survive.\n';

const PRESERVED_PATHS = [
  'MEMORY.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.ai-workflow/project.yml',
  '.ai-workflow/index/navigation.json',
  '.ai-workflow/index/navigation.md',
  '.ai-workflow/notes/implemented/feature/2026-01-01-custom.md',
  '.ai-workflow/notes/implemented/feature/2026-01-01-custom.zh.md',
  '.ai-workflow/notes/implemented/feature/2026-01-01-custom.i18n.yaml',
  '.ai-workflow/notes/archived/architecture/2026-04-01-sealed.md',
  '.ai-workflow/notes/archived/manifest.json',
  '.ai-workflow/plans/20260101-frozen/spec.md',
] as const;

const NOTE_LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived'] as const;
const NOTE_CLASSES = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing'] as const;

const roots: string[] = [];
afterEach(async () => {
  fsControl.failPath = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// The regression guard: while these suites run, any HTTP request is a failure.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('source acquisition must use the injected git runner, not HTTP');
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function createNotesTree(root: string): Promise<void> {
  await mkdir(join(root, '.ai-workflow/notes'), { recursive: true });
  for (const lifecycle of NOTE_LIFECYCLES) {
    await mkdir(join(root, '.ai-workflow/notes', lifecycle), { recursive: true });
    for (const noteClass of NOTE_CLASSES) {
      await mkdir(join(root, '.ai-workflow/notes', lifecycle, noteClass), { recursive: true });
    }
  }
}

/**
 * A complete adopted project whose five generated targets are stale (implemented/AGENTS.md
 * is absent), with independent local, user and data artifacts that must never change.
 */
async function adoptedProject(overrides: Record<string, string | null> = {}): Promise<string> {
  const root = await temporary('ai-workflow-sync-');
  roots.push(root);
  await createNotesTree(root);
  await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/plans/20260101-frozen'), { recursive: true });
  const files: Record<string, string> = {
    '.ai-workflow/AGENTS.md': STALE_AGENTS,
    '.ai-workflow/notes/AGENTS.md': STALE_NOTES_AGENTS,
    '.ai-workflow/notes/README.md': STALE_README,
    '.ai-workflow/notes/archived/AGENTS.md': SOURCE_ARCHIVED,
    'MEMORY.md': MEMORY_BYTES,
    'AGENTS.md': ROOT_USER_AGENTS,
    'CLAUDE.md': ROOT_USER_CLAUDE,
    '.ai-workflow/project.yml': PROJECT_CONFIG_BYTES,
    '.ai-workflow/index/navigation.json': navigationJson,
    '.ai-workflow/index/navigation.md': navigationMarkdown,
    '.ai-workflow/notes/implemented/feature/2026-01-01-custom.md': NOTE_BYTES,
    '.ai-workflow/notes/implemented/feature/2026-01-01-custom.zh.md': NOTE_BYTES,
    '.ai-workflow/notes/implemented/feature/2026-01-01-custom.i18n.yaml': 'note: pair\n',
    '.ai-workflow/notes/archived/architecture/2026-04-01-sealed.md': SEALED_BYTES,
    '.ai-workflow/notes/archived/manifest.json': MANIFEST_BYTES,
    '.ai-workflow/plans/20260101-frozen/spec.md': FROZEN_PLAN_BYTES,
    '.gitignore': '.ai-workflow/plans/\n.worktrees/\n',
  };
  // `.ai-workflow/notes/implemented/AGENTS.md` is intentionally absent: creation is covered.
  for (const [relative, contents] of Object.entries(overrides)) {
    if (contents === null) delete files[relative];
    else files[relative] = contents;
  }
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), contents);
  }
  return root;
}

function gitFor(files: Record<string, string>): ReturnType<typeof fakeGit> {
  return fakeGit({ commit: COMMIT, files });
}

async function bytesOf(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  const captured = new Map<string, string>();
  for (const path of paths) captured.set(path, (await readFile(join(root, path))).toString('base64'));
  return captured;
}

async function expectBytesUnchanged(root: string, before: Map<string, string>): Promise<void> {
  for (const [path, contents] of before) {
    expect((await readFile(join(root, path))).toString('base64'), `${path} must keep its original bytes`).toBe(contents);
  }
}

/** Per-path mtimeNs, `null` when the path is absent, to prove no write touched it. */
async function mtimes(root: string, paths: readonly string[]): Promise<Array<string | null>> {
  return Promise.all(
    paths.map(async (path) => {
      try {
        return (await stat(join(root, path), { bigint: true })).mtimeNs.toString();
      } catch {
        return null;
      }
    }),
  );
}

describe('project template full-file synchronization', () => {
  it('replaces every changed generated file with its complete source, creates missing ones and preserves local and data artifacts', async () => {
    const root = await adoptedProject();
    const preservedBefore = await bytesOf(root, PRESERVED_PATHS);
    const archivedBefore = await mtimes(root, ['.ai-workflow/notes/archived/AGENTS.md']);

    const report = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });

    expect(report.status).toBe('synchronized');
    expect(report.verified).toBe(true);
    expect(report.proceed).toBe(true);
    expect(report.check).toBe(false);
    expect(report.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit: COMMIT });
    expect(report.conflicts).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect([...report.updated].sort()).toEqual([
      '.ai-workflow/AGENTS.md',
      '.ai-workflow/notes/AGENTS.md',
      '.ai-workflow/notes/README.md',
    ]);
    expect(report.created).toEqual(['.ai-workflow/notes/implemented/AGENTS.md']);
    expect(report.skipped).toContain('.ai-workflow/notes/archived/AGENTS.md');

    // Public readback: every generated target now equals its entire source, markerless.
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(SOURCE_AGENTS);
    expect(await readFile(join(root, '.ai-workflow/notes/AGENTS.md'), 'utf8')).toBe(SOURCE_NOTES_AGENTS);
    expect(await readFile(join(root, '.ai-workflow/notes/README.md'), 'utf8')).toBe(SOURCE_README);
    expect(await readFile(join(root, '.ai-workflow/notes/implemented/AGENTS.md'), 'utf8')).toBe(SOURCE_IMPLEMENTED);
    expect(await readFile(join(root, '.ai-workflow/notes/archived/AGENTS.md'), 'utf8')).toBe(SOURCE_ARCHIVED);
    for (const path of GENERATED_TARGETS) expect(await readFile(join(root, path), 'utf8')).not.toMatch(/ai-workflow:section/);

    // MEMORY, root user files, project data, navigation, note triplets, sealed artifacts
    // and frozen plans keep their exact bytes.
    await expectBytesUnchanged(root, preservedBefore);
    expect(await mtimes(root, ['.ai-workflow/notes/archived/AGENTS.md']), 'an identical generated file must not be rewritten').toEqual(archivedBefore);
  });

  it('check mode proposes without writing and an identical repeat is an idempotent no-op', async () => {
    const root = await adoptedProject();
    const before = await snapshotTree(root);
    const beforeMtimes = await mtimes(root, GENERATED_TARGETS);

    const pending = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit, check: true });
    expect(pending.status).toBe('pending');
    expect(pending.verified).toBe(false);
    expect(pending.proceed).toBe(false);
    expect(pending.check).toBe(true);
    expect(pending.created).toEqual(['.ai-workflow/notes/implemented/AGENTS.md']);
    expect([...pending.updated].sort()).toEqual([
      '.ai-workflow/AGENTS.md',
      '.ai-workflow/notes/AGENTS.md',
      '.ai-workflow/notes/README.md',
    ]);
    expect(changedPaths(before, await snapshotTree(root)), 'check mode must write nothing').toEqual([]);
    expect(await mtimes(root, GENERATED_TARGETS), 'check mode must not touch mtimes').toEqual(beforeMtimes);

    const applied = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });
    expect(applied.status).toBe('synchronized');
    expect(applied.created).toEqual(['.ai-workflow/notes/implemented/AGENTS.md']);
    const appliedTree = await snapshotTree(root);
    const appliedMtimes = await mtimes(root, GENERATED_TARGETS);

    const repeated = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });
    expect(repeated.status).toBe('synchronized');
    expect(repeated.verified).toBe(true);
    expect(repeated.proceed).toBe(true);
    expect(repeated.created).toEqual([]);
    expect(repeated.updated).toEqual([]);
    expect(changedPaths(appliedTree, await snapshotTree(root)), 'a repeat must write nothing').toEqual([]);
    expect(await mtimes(root, GENERATED_TARGETS), 'a repeat must not touch mtimes').toEqual(appliedMtimes);
  });

  it('does not write a target for an unsupported source destination and never synchronizes navigation', async () => {
    const root = await adoptedProject();
    const navigationBefore = await readFile(join(root, '.ai-workflow/index/navigation.json'), 'utf8');

    const report = await synchronizeProject({
      projectRoot: root,
      runGit: gitFor({ ...SOURCE, 'templates/project/EXTRA.md': '# Extra\n\nUnsupported destination.\n' }).runGit,
    });

    expect(report.status).toBe('synchronized');
    expect(await exists(join(root, '.ai-workflow/EXTRA.md'))).toBe(false);
    expect(await exists(join(root, 'EXTRA.md'))).toBe(false);
    expect(report.updated).not.toContain('.ai-workflow/EXTRA.md');
    expect(await readFile(join(root, '.ai-workflow/index/navigation.json'), 'utf8')).toBe(navigationBefore);
  });
});

describe('project template legacy refusal and local MEMORY', () => {
  it('refuses a generated target that still carries legacy section-marker syntax before any write', async () => {
    const legacy = '# Project contract\n\n<!-- ai-workflow:section shared-context:begin -->\nold shared body\n<!-- ai-workflow:section shared-context:end -->\n';
    const root = await adoptedProject({ '.ai-workflow/AGENTS.md': legacy });
    const before = await snapshotTree(root);

    const report = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });

    expect(report.status).toBe('conflict');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(false);
    const conflict = report.conflicts.find((entry) => entry.path === '.ai-workflow/AGENTS.md');
    expect(conflict, 'the conflict names the marked generated target').toBeDefined();
    expect(conflict!.reason).toMatch(/manual|replace/i);
    expect(changedPaths(before, await snapshotTree(root)), 'a legacy conflict must write nothing').toEqual([]);
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(legacy);
  });

  it('preserves root MEMORY that merely mentions legacy marker text and does not treat it as a target', async () => {
    const memory = '# Project memory\n\nHistorical prose mentioning <!-- ai-workflow:section standards:begin --> syntax.\n';
    const root = await adoptedProject({ 'MEMORY.md': memory });
    const before = await mtimes(root, ['MEMORY.md']);

    const report = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });

    expect(report.status).toBe('synchronized');
    expect(report.updated).not.toContain('MEMORY.md');
    expect(report.created).not.toContain('MEMORY.md');
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(memory);
    expect(await mtimes(root, ['MEMORY.md'])).toEqual(before);
  });
});

describe('project template target and prerequisite conflicts', () => {
  it('conflicts without writing when a generated path is occupied by a directory', async () => {
    const root = await adoptedProject({ '.ai-workflow/AGENTS.md': null });
    await mkdir(join(root, '.ai-workflow/AGENTS.md'), { recursive: true });
    await writeFile(join(root, '.ai-workflow/AGENTS.md/placeholder'), 'occupied\n');
    const before = await snapshotTree(root);

    const report = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });

    expect(report.status).toBe('conflict');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(false);
    expect(report.conflicts.some((entry) => entry.path === '.ai-workflow/AGENTS.md')).toBe(true);
    expect(report.created).toEqual([]);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  });

  it('conflicts without writing when a managed target parent is not a directory', async () => {
    const root = await temporary('ai-workflow-sync-parent-');
    roots.push(root);
    await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
    await writeFile(join(root, '.ai-workflow/notes'), 'not a directory\n');
    await writeFile(join(root, 'MEMORY.md'), MEMORY_BYTES);
    await writeFile(join(root, '.ai-workflow/index/navigation.json'), navigationJson);
    await writeFile(join(root, '.ai-workflow/index/navigation.md'), navigationMarkdown);
    await writeFile(join(root, '.gitignore'), '.ai-workflow/plans/\n.worktrees/\n');
    const before = await snapshotTree(root);

    const report = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });

    expect(report.status).toBe('conflict');
    expect(report.conflicts.some((entry) => entry.path !== undefined && entry.path.startsWith('.ai-workflow/notes'))).toBe(true);
    expect(report.created).toEqual([]);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  });

  it('conflicts without initializing when a required adoption prerequisite is missing', async () => {
    const root = await adoptedProject({ 'MEMORY.md': null });
    const before = await snapshotTree(root);

    const report = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });

    expect(report.status).toBe('conflict');
    expect(report.conflicts.some((entry) => entry.path === 'MEMORY.md')).toBe(true);
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(changedPaths(before, await snapshotTree(root)), 'a missing prerequisite must publish nothing').toEqual([]);
    expect(await exists(join(root, 'MEMORY.md'))).toBe(false);
  });

  it('conflicts and preserves a valid archive manifest but blocks an invalid one', async () => {
    const valid = await adoptedProject();
    const validBefore = await readFile(join(valid, '.ai-workflow/notes/archived/manifest.json'), 'utf8');
    const validReport = await synchronizeProject({ projectRoot: valid, runGit: gitFor(SOURCE).runGit });
    expect(validReport.status).toBe('synchronized');
    expect(await readFile(join(valid, '.ai-workflow/notes/archived/manifest.json'), 'utf8')).toBe(validBefore);

    const invalid = await adoptedProject({ '.ai-workflow/notes/archived/manifest.json': '{ not valid json\n' });
    const invalidBefore = await snapshotTree(invalid);
    const invalidReport = await synchronizeProject({ projectRoot: invalid, runGit: gitFor(SOURCE).runGit });
    expect(invalidReport.status).toBe('conflict');
    expect(invalidReport.conflicts.some((entry) => entry.path === '.ai-workflow/notes/archived/manifest.json')).toBe(true);
    expect(changedPaths(invalidBefore, await snapshotTree(invalid)), 'an invalid manifest must block publication').toEqual([]);
  });

  it('boots a missing archive manifest from the shipped empty bootstrap', async () => {
    const root = await adoptedProject({ '.ai-workflow/notes/archived/manifest.json': null });

    const report = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });

    expect(report.status).toBe('synchronized');
    expect(JSON.parse(await readFile(join(root, '.ai-workflow/notes/archived/manifest.json'), 'utf8'))).toEqual({ version: 1, files: {} });
  });
});

describe('project template publication recovery', () => {
  it('restores original bytes and removes only invocation-created artifacts when a late publication fails', async () => {
    const root = await adoptedProject();
    const before = await snapshotTree(root);
    fsControl.failPath = '.ai-workflow/notes/AGENTS.md';

    const report = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });

    expect(report.status).toBe('failed');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(false);
    expect(report.warnings.some((entry) => entry.path === '.ai-workflow/notes/AGENTS.md')).toBe(true);
    expect(changedPaths(before, await snapshotTree(root)), 'the original tree must be restored').toEqual([]);
  });

  it('names the exact path when recovery itself fails instead of claiming full restoration', async () => {
    const root = await adoptedProject();
    fsControl.failPath = '.ai-workflow/AGENTS.md';

    const report = await synchronizeProject({ projectRoot: root, runGit: gitFor(SOURCE).runGit });

    expect(report.status).toBe('failed');
    expect(report.warnings.some((entry) => entry.path === '.ai-workflow/AGENTS.md' && /recover/i.test(entry.reason))).toBe(true);
  });
});
