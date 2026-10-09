import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { synchronizeProject, type SyncReport } from '../../src/sync/index.js';
import { changedPaths, fakeGit, snapshotTree, temporary, type TestGitRunner } from '../helpers.js';
import { exists } from '../../src/utils/fs.js';

const REPOSITORY = 'hengboy/ai-workflow';
const BRANCH = 'main';

// The complete notes management structure, listed literally so file-patch tests isolate
// managed files from directory creation and stay independent of the production helper.
const noteLifecycleNames = ['proposed', 'implemented', 'rejected', 'archived'] as const;
const noteClassNameList = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing'] as const;
const notesDirectories = [
  '.ai-workflow/notes',
  ...noteLifecycleNames.flatMap((lifecycle) => [
    `.ai-workflow/notes/${lifecycle}`,
    ...noteClassNameList.map((noteClass) => `.ai-workflow/notes/${lifecycle}/${noteClass}`),
  ]),
];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// The regression guard: while these suites run, any HTTP request is a failure. Source
// acquisition must go through the injected git runner only.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('source acquisition must use the injected git runner, not HTTP');
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A git runner whose clone fails before any commit is known (status/rate-limit/network). */
function headFailureGit(): TestGitRunner {
  return async () => { throw new Error('source unavailable: clone failed'); };
}

/** A fixed-HEAD git runner that materializes the given source set for one immutable commit. */
function fixedHeadGit(commit: string, files: Record<string, string>): TestGitRunner {
  return fakeGit({ commit, files }).runGit;
}

/**
 * A fixed HEAD whose source set still contains every supported member, but one mergeable
 * Markdown member is structurally invalid: retirement (a missing file) is never confused
 * with a failed retrieval (a present member whose bytes cannot be validated).
 */
function memberFailureGit(commit: string, failingPath: string, files: Record<string, string>): TestGitRunner {
  return fakeGit({ commit, files: { ...files, [failingPath]: '# malformed\n<!-- ai-workflow:section broken:begin -->\nnever closed\n' } }).runGit;
}

const navigationJson = `${JSON.stringify(
  {
    version: 1,
    module_roots: [{ id: 'src', path: 'src', owner_role: 'shared', responsibility: 'adopted module', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [
      {
        id: 'src', name: 'src', aliases: [], module_root: 'src', entries: ['src/index.ts'], symbols: [], related_files: [],
        tests: [], depends_on: [], relations: [], owner_role: 'shared', responsibility: 'adopted module',
        read_scope: ['src/index.ts'], shared_entry: false,
      },
    ],
  },
  null,
  2,
)}\n`;

/** A minimal valid ai-workflow adoption whose bytes must never change on a source failure. */
async function adoptedProject(): Promise<string> {
  const root = await temporary('ai-workflow-sync-');
  roots.push(root);
  await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(root, 'MEMORY.md'), '# Project memory\n\nAdopted standard that must survive a failed sync.\n');
  await writeFile(join(root, '.ai-workflow/index/navigation.json'), navigationJson);
  await writeFile(join(root, '.ai-workflow/index/navigation.md'), '# Navigation\n\nAdopted navigation bytes.\n');
  await writeFile(join(root, '.ai-workflow/AGENTS.md'), '# Project contract\n\nAdopted contract bytes.\n');
  return root;
}

describe('project template synchronization source failures', () => {
  it('AC-002 retains every target byte and reports unverified when HEAD or a supported member cannot be retrieved', async () => {
    const root = await adoptedProject();

    // (a) The branch HEAD query fails: no commit is known, so no source can be trusted.
    const beforeHead = await snapshotTree(root);
    const headReport = await synchronizeProject({ projectRoot: root, runGit: headFailureGit() });

    expect(headReport.project).toBe(root);
    expect(headReport.status).toBe('unverified');
    expect(headReport.verified).toBe(false);
    expect(headReport.proceed).toBe(true);
    expect(headReport.check).toBe(false);
    expect(headReport.source).toMatchObject({ repository: REPOSITORY, branch: BRANCH, commit: null });
    expect(headReport.created).toEqual([]);
    expect(headReport.updated).toEqual([]);
    expect(headReport.warnings.length).toBeGreaterThan(0);
    for (const warning of headReport.warnings) expect(warning.reason.length).toBeGreaterThan(0);
    expect(changedPaths(beforeHead, await snapshotTree(root)), 'a failed HEAD must write nothing').toEqual([]);

    // (b) HEAD resolves, but one supported member cannot be retrieved: the incomplete
    // snapshot is unverified, no commit is claimed and no target byte changes.
    const failingPath = 'templates/project/notes/README.md';
    const beforeMember = await snapshotTree(root);
    const memberReport = await synchronizeProject({ projectRoot: root, runGit: memberFailureGit('c'.repeat(40), failingPath, sourceFiles) });

    expect(memberReport.project).toBe(root);
    expect(memberReport.status).toBe('unverified');
    expect(memberReport.verified).toBe(false);
    expect(memberReport.proceed).toBe(true);
    expect(memberReport.check).toBe(false);
    expect(memberReport.source).toMatchObject({ repository: REPOSITORY, branch: BRANCH, commit: null });
    expect(memberReport.created).toEqual([]);
    expect(memberReport.updated).toEqual([]);
    expect(memberReport.warnings.some((warning) => warning.path === failingPath)).toBe(true);
    for (const warning of memberReport.warnings) expect(warning.reason.length).toBeGreaterThan(0);
    expect(changedPaths(beforeMember, await snapshotTree(root)), 'an incomplete source must write nothing').toEqual([]);
  });
});

// --- AC-003 owned-section patches -------------------------------------------------

const mergeCommit = 'd'.repeat(40);

/** A stable, unique, non-nested ownership section exactly as the plan specifies. */
function marked(id: string, body: string): string {
  return `<!-- ai-workflow:section ${id}:begin -->\n${body}\n<!-- ai-workflow:section ${id}:end -->\n`;
}

/**
 * Upstream source served by the injected fixed-HEAD fixture. AGENTS.md and MEMORY.md
 * carry owned sections whose bodies differ from the target's; the other supported
 * templates are byte-identical to the target so synchronization is a clean patch.
 */
const sourceFiles: Record<string, string> = {
  'templates/project/AGENTS.md': [
    '# Contract template preface\n',
    '\n',
    '<!-- ai-workflow:section shared-context:begin -->\n',
    'fresh shared body\n',
    '<!-- ai-workflow:section shared-context:end -->\n',
    '\n',
    '<!-- ai-workflow:section maintainers:begin -->\n',
    'old maintainers body\n',
    '<!-- ai-workflow:section maintainers:end -->\n',
  ].join(''),
  'templates/project/MEMORY.md': [
    '# Memory template preface\n',
    '\n',
    '<!-- ai-workflow:section standards:begin -->\n',
    'fresh standards body\n',
    '<!-- ai-workflow:section standards:end -->\n',
  ].join(''),
  'templates/project/navigation.json': navigationJson,
  'templates/project/navigation.md': '# Navigation\n\nAdopted navigation bytes.\n',
  'templates/project/notes/AGENTS.md': marked('notes-governance', 'Shared notes governance body.'),
  'templates/project/notes/README.md': marked('notes-readme', 'Shared notes readme body.'),
  'templates/project/notes/implemented/AGENTS.md': marked('implemented-governance', 'Shared implemented governance body.'),
  'templates/project/notes/archived/AGENTS.md': marked('archived-governance', 'Shared archived governance body.'),
  'templates/project/notes/archived/manifest.json': '{\n  "version": 1,\n  "files": {}\n}\n',
};

// Target bytes: valid owned sections with project-owned custom bytes before, between
// and after them. Custom bytes deliberately use CRLF, owned bodies use LF.
const targetAgentsMd = [
  'custom preface line\r\n',
  '\r\n',
  '<!-- ai-workflow:section shared-context:begin -->\n',
  'old shared body\n',
  '<!-- ai-workflow:section shared-context:end -->\n',
  'custom between line\n',
  '<!-- ai-workflow:section maintainers:begin -->\n',
  'old maintainers body\n',
  '<!-- ai-workflow:section maintainers:end -->\n',
  'custom trailing line\r\n',
].join('');

const targetMemoryMd = [
  '# Project memory\r\n',
  '\r\n',
  'Independent standard: do not overwrite.\r\n',
  '\r\n',
  '<!-- ai-workflow:section standards:begin -->\n',
  'old standards body\n',
  '<!-- ai-workflow:section standards:end -->\n',
  'Independent trailing note\r\n',
].join('');

// Independent expected literal: only the two owned bodies above change into the source
// bodies; every custom byte, marker and line ending stays exactly as written.
const expectedAgentsMd = [
  'custom preface line\r\n',
  '\r\n',
  '<!-- ai-workflow:section shared-context:begin -->\n',
  'fresh shared body\n',
  '<!-- ai-workflow:section shared-context:end -->\n',
  'custom between line\n',
  '<!-- ai-workflow:section maintainers:begin -->\n',
  'old maintainers body\n',
  '<!-- ai-workflow:section maintainers:end -->\n',
  'custom trailing line\r\n',
].join('');

const expectedMemoryMd = [
  '# Project memory\r\n',
  '\r\n',
  'Independent standard: do not overwrite.\r\n',
  '\r\n',
  '<!-- ai-workflow:section standards:begin -->\n',
  'fresh standards body\n',
  '<!-- ai-workflow:section standards:end -->\n',
  'Independent trailing note\r\n',
].join('');

const targetFiles: Record<string, string> = {
  '.ai-workflow/AGENTS.md': targetAgentsMd,
  'MEMORY.md': targetMemoryMd,
  '.ai-workflow/index/navigation.json': sourceFiles['templates/project/navigation.json']!,
  '.ai-workflow/index/navigation.md': sourceFiles['templates/project/navigation.md']!,
  '.ai-workflow/notes/AGENTS.md': sourceFiles['templates/project/notes/AGENTS.md']!,
  '.ai-workflow/notes/README.md': sourceFiles['templates/project/notes/README.md']!,
  '.ai-workflow/notes/implemented/AGENTS.md': sourceFiles['templates/project/notes/implemented/AGENTS.md']!,
  '.ai-workflow/notes/archived/AGENTS.md': sourceFiles['templates/project/notes/archived/AGENTS.md']!,
  '.ai-workflow/notes/archived/manifest.json': sourceFiles['templates/project/notes/archived/manifest.json']!,
};

async function writeAdoptedTarget(root: string): Promise<void> {
  for (const directory of notesDirectories) await mkdir(join(root, directory), { recursive: true });
  for (const [relative, contents] of Object.entries(targetFiles)) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), contents);
  }
  // Already-complete ignore entries, so ignore reconciliation is a no-op.
  await writeFile(join(root, '.gitignore'), '.ai-workflow/plans/\n.worktrees/\n');
}

describe('project template owned-section patches', () => {
  it('AC-003 patches only owned section bodies from the latest source and preserves every outside byte', async () => {
    const root = await temporary('ai-workflow-sync-merge-');
    roots.push(root);
    await writeAdoptedTarget(root);
    const before = await snapshotTree(root);

    const report = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(mergeCommit, sourceFiles) });

    expect(report.status).toBe('synchronized');
    expect(report.verified).toBe(true);
    expect(report.proceed).toBe(true);
    expect(report.check).toBe(false);
    expect(report.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit: mergeCommit });
    expect(report.conflicts).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect([...report.updated].sort()).toEqual(['.ai-workflow/AGENTS.md', 'MEMORY.md']);

    // Public readback against the independent literal: only the owned bodies changed.
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(expectedAgentsMd);
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(expectedMemoryMd);

    // Exactly the two marked files changed; no other project byte or entry moved.
    expect(changedPaths(before, await snapshotTree(root)).sort()).toEqual(['.ai-workflow/AGENTS.md', 'MEMORY.md']);
  });
});

// --- AC-004 legacy adoption and AC-005 missing/retired artifacts ------------------

const legacyCommit = 'e'.repeat(40);

// Source set for the legacy/retired boundary. `templates/project/notes/README.md` is
// intentionally absent from both the file set and the directory listing: it is retired
// upstream, not a failed retrieval. `EXTRA.md` is an unsupported upstream destination.
const legacySourceFiles: Record<string, string> = {
  'templates/project/AGENTS.md': [
    '# Contract template preface\n',
    '\n',
    '<!-- ai-workflow:section legacy-match:begin -->\n',
    '## Legacy match\n',
    '\n',
    'Adopted body.\n',
    '<!-- ai-workflow:section legacy-match:end -->\n',
  ].join(''),
  'templates/project/MEMORY.md': [
    '# Memory template preface\n',
    '\n',
    '<!-- ai-workflow:section legacy-diff:begin -->\n',
    '## Legacy difference\n',
    '\n',
    'Upstream body.\n',
    '<!-- ai-workflow:section legacy-diff:end -->\n',
  ].join(''),
  'templates/project/navigation.json': navigationJson,
  'templates/project/navigation.md': '# Navigation\n\nAdopted navigation bytes.\n',
  'templates/project/notes/AGENTS.md': marked('notes-governance', 'Fresh notes governance body.'),
  'templates/project/notes/implemented/AGENTS.md': marked('implemented-governance', 'Implemented governance body.'),
  'templates/project/notes/archived/AGENTS.md': marked('archived-governance', 'Archived governance body.'),
  'templates/project/notes/archived/manifest.json': '{\n  "version": 1,\n  "files": {}\n}\n',
  'templates/project/EXTRA.md': 'unsupported extra template\n',
};

// Legacy target: unmarked same-heading sections plus project-owned bytes and headings.
const targetLegacyAgents = [
  'custom preface\n',
  '\n',
  '## Legacy match\n',
  '\n',
  'Adopted body.\n',
  '## Custom suffix\n',
  '\n',
  'Project-owned suffix body.\n',
].join('');

const expectedLegacyAgents = [
  'custom preface\n',
  '\n',
  '<!-- ai-workflow:section legacy-match:begin -->\n',
  '## Legacy match\n',
  '\n',
  'Adopted body.\n',
  '<!-- ai-workflow:section legacy-match:end -->\n',
  '## Custom suffix\n',
  '\n',
  'Project-owned suffix body.\n',
].join('');

const targetLegacyMemory = [
  '# Project memory\n',
  '\n',
  '## Legacy difference\n',
  '\n',
  'Project-custom body that must survive.\n',
  '## Custom footer\n',
  '\n',
  'Independent trailing note.\n',
].join('');

const targetNotesGovernance = marked('notes-governance', 'Old notes governance body.');
const expectedNotesGovernance = marked('notes-governance', 'Fresh notes governance body.');
const targetNotesReadme = marked('notes-readme', 'Local notes readme body.');
const targetArchivedGovernance = marked('archived-governance', 'Archived governance body.');

const legacyTargetFiles: Record<string, string> = {
  '.ai-workflow/AGENTS.md': targetLegacyAgents,
  'MEMORY.md': targetLegacyMemory,
  '.ai-workflow/index/navigation.json': navigationJson,
  '.ai-workflow/index/navigation.md': '# Navigation\n\nAdopted navigation bytes.\n',
  '.ai-workflow/notes/AGENTS.md': targetNotesGovernance,
  '.ai-workflow/notes/README.md': targetNotesReadme,
  '.ai-workflow/notes/archived/AGENTS.md': targetArchivedGovernance,
  '.ai-workflow/notes/archived/manifest.json': '{\n  "version": 1,\n  "files": {}\n}\n',
  // '.ai-workflow/notes/implemented/AGENTS.md' is intentionally absent: created from source.
};

async function writeLegacyTarget(root: string): Promise<void> {
  for (const directory of notesDirectories) await mkdir(join(root, directory), { recursive: true });
  for (const [relative, contents] of Object.entries(legacyTargetFiles)) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), contents);
  }
  await writeFile(join(root, '.gitignore'), '.ai-workflow/plans/\n.worktrees/\n');
}

describe('project template legacy adoption and retired artifacts', () => {
  it('AC-004/AC-005 adopts exact legacy sections, preserves differing and retired bytes, creates missing artifacts and warns without a baseline', async () => {
    const root = await temporary('ai-workflow-sync-legacy-');
    roots.push(root);
    await writeLegacyTarget(root);
    const before = await snapshotTree(root);

    const report = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(legacyCommit, legacySourceFiles) });

    expect(report.status).toBe('needs_attention');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(true);
    expect(report.check).toBe(false);
    expect(report.source).toMatchObject({ repository: REPOSITORY, branch: BRANCH, commit: legacyCommit });
    expect(report.conflicts).toEqual([]);

    // Safe patches land even though attention remains: exact legacy adoption plus a marked patch.
    expect([...report.updated].sort()).toEqual(['.ai-workflow/AGENTS.md', '.ai-workflow/notes/AGENTS.md']);
    expect(report.created).toContain('.ai-workflow/notes/implemented/AGENTS.md');

    // Warnings name the applicable target path and section where known.
    expect(report.warnings.some((warning) => warning.path === 'MEMORY.md' && warning.section === 'legacy-diff' && warning.reason.length > 0)).toBe(true);
    expect(report.warnings.some((warning) => warning.path === '.ai-workflow/notes/README.md' && warning.reason.length > 0)).toBe(true);

    // Public readback against independent literals.
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(expectedLegacyAgents);
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(targetLegacyMemory);
    expect(await readFile(join(root, '.ai-workflow/notes/AGENTS.md'), 'utf8')).toBe(expectedNotesGovernance);
    expect(await readFile(join(root, '.ai-workflow/notes/README.md'), 'utf8')).toBe(targetNotesReadme);
    expect(await readFile(join(root, '.ai-workflow/notes/archived/AGENTS.md'), 'utf8')).toBe(targetArchivedGovernance);
    expect(await readFile(join(root, '.ai-workflow/notes/implemented/AGENTS.md'), 'utf8')).toBe(legacySourceFiles['templates/project/notes/implemented/AGENTS.md']!);

    // Only the adopted, patched and created files changed; nothing was deleted.
    expect(changedPaths(before, await snapshotTree(root)).sort()).toEqual([
      '.ai-workflow/AGENTS.md',
      '.ai-workflow/notes/AGENTS.md',
      '.ai-workflow/notes/implemented/AGENTS.md',
    ]);

    // No baseline, project manifest, version stamp or sync record; an unsupported
    // upstream destination authorizes no extra target write.
    expect(await exists(join(root, '.ai-workflow/project.yml'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/sync.json'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/.sync'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/EXTRA.md'))).toBe(false);
    expect(await exists(join(root, 'EXTRA.md'))).toBe(false);
  });
});

// --- AC-010 structural conflict preflight -----------------------------------------

const malformedMemoryCases: Array<{ name: string; contents: string }> = [
  {
    name: 'a duplicate section id',
    contents: [
      '<!-- ai-workflow:section standards:begin -->\n',
      'first body\n',
      '<!-- ai-workflow:section standards:end -->\n',
      '<!-- ai-workflow:section standards:begin -->\n',
      'second body\n',
      '<!-- ai-workflow:section standards:end -->\n',
    ].join(''),
  },
  {
    name: 'an unclosed section marker',
    contents: [
      '# Project memory\n',
      '\n',
      '<!-- ai-workflow:section standards:begin -->\n',
      'never closed\n',
    ].join(''),
  },
];

describe('project template structural conflicts', () => {
  it.each(malformedMemoryCases)('AC-010 blocks every write when $name makes a managed target structurally invalid', async ({ contents }) => {
    const root = await temporary('ai-workflow-sync-conflict-');
    roots.push(root);
    await writeAdoptedTarget(root);
    await writeFile(join(root, 'MEMORY.md'), contents);
    const before = await snapshotTree(root);

    const report = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(mergeCommit, sourceFiles) });

    expect(report.status).toBe('conflict');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(false);
    expect(report.check).toBe(false);
    expect(report.conflicts.length).toBeGreaterThan(0);
    const conflict = report.conflicts.find((entry) => entry.path === 'MEMORY.md');
    expect(conflict, 'the conflict names the affected target path').toBeDefined();
    expect(conflict!.reason.length).toBeGreaterThan(0);
    expect(conflict!.section === 'standards' || conflict!.reason.includes('standards')).toBe(true);

    // No target is published: the otherwise-safe AGENTS.md update is blocked too.
    expect(changedPaths(before, await snapshotTree(root)), 'a structural conflict must write nothing').toEqual([]);
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(contents);
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(targetAgentsMd);
  });
});

// --- AC-010 ordinary publication failure recovery ---------------------------------

describe('project template publication recovery', () => {
  it('AC-010 restores every original byte and reports failed when a later atomic publication fails', async () => {
    const root = await temporary('ai-workflow-sync-publish-');
    roots.push(root);
    await writeAdoptedTarget(root);
    const before = await snapshotTree(root);
    const beforeAgents = await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8');
    const beforeMemory = await readFile(join(root, 'MEMORY.md'), 'utf8');

    let report: SyncReport | undefined;
    let thrown: unknown;
    try {
      // A read-only project root lets the first change publish inside the still-writable
      // `.ai-workflow/` but makes the later root-level MEMORY.md atomic write fail.
      await chmod(root, 0o555);
      const writable = await access(root, constants.W_OK).then(() => true, () => false);
      if (writable) {
        throw new Error('This environment cannot enforce a read-only project root (likely running as root); AC-010 publication-failure recovery requires an unprivileged process.');
      }
      report = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(mergeCommit, sourceFiles) });
    } catch (error) {
      thrown = error;
    } finally {
      await chmod(root, 0o755);
    }

    // Surface an unenforceable environment as a bounded support request, never a skip.
    if (thrown instanceof Error && /cannot enforce a read-only project root/.test(thrown.message)) throw thrown;

    expect(thrown, 'synchronization must report failure, not throw').toBeUndefined();
    expect(report).toBeDefined();
    expect(report!.status).toBe('failed');
    expect(report!.verified).toBe(false);
    expect(report!.proceed).toBe(false);
    expect(report!.check).toBe(false);

    const failure = [...report!.warnings, ...report!.conflicts].find((entry) => entry.reason.length > 0 && entry.path !== undefined);
    expect(failure, 'the failed publication is reported with a reason and path').toBeDefined();
    expect(failure!.reason.length).toBeGreaterThan(0);
    expect(failure!.path).toBe('MEMORY.md');

    // Original bytes and entries are restored with no invocation-created artifacts.
    expect(changedPaths(before, await snapshotTree(root)), 'the original tree must be restored').toEqual([]);
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(beforeAgents);
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(beforeMemory);
  });
});

// --- AC-011 check mode and repeat idempotency -------------------------------------

const managedTargets = [
  '.ai-workflow/AGENTS.md',
  'MEMORY.md',
  '.ai-workflow/index/navigation.json',
  '.ai-workflow/index/navigation.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
  '.ai-workflow/notes/archived/manifest.json',
] as const;

const createdArtifact = '.ai-workflow/notes/implemented/AGENTS.md';

function markerCount(contents: string): number {
  return contents.split('<!-- ai-workflow:section ').length - 1;
}

/** Per-managed-target mtimeNs, `null` when the path is absent, to prove no write touched it. */
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

describe('project template check mode and repeat synchronization', () => {
  it('AC-011 check mode proposes without writing, then apply and repeat are idempotent with no duplicate markers or baseline', async () => {
    const root = await temporary('ai-workflow-sync-idempotent-');
    roots.push(root);
    await writeAdoptedTarget(root);
    // One supported artifact is absent so check mode proposes both created and updated paths.
    await rm(join(root, createdArtifact), { force: true });

    const targetPaths = [...managedTargets];
    const before = await snapshotTree(root);
    const beforeMtimes = await mtimes(root, targetPaths);

    // Check mode: propose the safe changes without touching any byte or mtime.
    const pending = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(mergeCommit, sourceFiles), check: true });
    expect(pending.status).toBe('pending');
    expect(pending.verified).toBe(false);
    expect(pending.proceed).toBe(false);
    expect(pending.check).toBe(true);
    expect(pending.created).toEqual([createdArtifact]);
    expect([...pending.updated].sort()).toEqual(['.ai-workflow/AGENTS.md', 'MEMORY.md']);
    expect(pending.conflicts).toEqual([]);
    expect(changedPaths(before, await snapshotTree(root)), 'check mode must write nothing').toEqual([]);
    expect(await mtimes(root, targetPaths), 'check mode must not touch file mtimes').toEqual(beforeMtimes);

    // Apply the same immutable source: the safe changes land.
    const applied = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(mergeCommit, sourceFiles) });
    expect(applied.status).toBe('synchronized');
    expect(applied.verified).toBe(true);
    expect(applied.proceed).toBe(true);
    expect(applied.check).toBe(false);
    expect(applied.created).toEqual([createdArtifact]);
    expect([...applied.updated].sort()).toEqual(['.ai-workflow/AGENTS.md', 'MEMORY.md']);
    expect(applied.conflicts).toEqual([]);
    expect(applied.warnings).toEqual([]);
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(expectedAgentsMd);
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(expectedMemoryMd);
    expect(await readFile(join(root, createdArtifact), 'utf8')).toBe(sourceFiles['templates/project/notes/implemented/AGENTS.md']!);

    const appliedTree = await snapshotTree(root);
    const appliedMtimes = await mtimes(root, targetPaths);
    expect(changedPaths(before, appliedTree).sort(), 'only the proposed artifacts change; no baseline/metadata').toEqual(
      [createdArtifact, '.ai-workflow/AGENTS.md', 'MEMORY.md'].sort(),
    );
    expect(await exists(join(root, '.ai-workflow/project.yml'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/sync.json'))).toBe(false);

    // Repeat with the same immutable source: nothing changes, nothing duplicates.
    const repeated = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(mergeCommit, sourceFiles) });
    expect(repeated.status).toBe('synchronized');
    expect(repeated.verified).toBe(true);
    expect(repeated.proceed).toBe(true);
    expect(repeated.check).toBe(false);
    expect(repeated.created).toEqual([]);
    expect(repeated.updated).toEqual([]);
    expect([...repeated.skipped].sort()).toEqual([...managedTargets, ...notesDirectories, '.gitignore'].sort());

    expect(changedPaths(appliedTree, await snapshotTree(root)), 'a repeat must write nothing').toEqual([]);
    expect(await mtimes(root, targetPaths), 'a repeat must not touch file mtimes').toEqual(appliedMtimes);

    // Literal section-marker counts: no duplication after apply and repeat.
    expect(markerCount(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8'))).toBe(4);
    expect(markerCount(await readFile(join(root, 'MEMORY.md'), 'utf8'))).toBe(2);
    expect(markerCount(await readFile(join(root, createdArtifact), 'utf8'))).toBe(2);
  });
});

// --- Source validity before any target patch (REQ-001 / AC-002 counterexample) -----

describe('project template source validity', () => {
  it('treats malformed upstream ownership as unverified and patches no target even when other source changes are safe', async () => {
    const root = await temporary('ai-workflow-sync-sourcevalid-');
    roots.push(root);
    await writeAdoptedTarget(root);
    const before = await snapshotTree(root);

    // The full native listing still advertises every member, but one Markdown template
    // is returned without ownership structure: upstream acquisition must be unverified.
    const malformedSourceFiles = {
      ...sourceFiles,
      'templates/project/MEMORY.md': '# Memory template\n\nUnmarked upstream body.\n',
    };
    const report = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(mergeCommit, malformedSourceFiles) });

    expect(report.status).toBe('unverified');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(true);
    expect(report.check).toBe(false);
    expect(report.source.commit).toBeNull();
    expect(report.warnings.some((warning) => warning.path === 'templates/project/MEMORY.md' && warning.reason.length > 0)).toBe(true);
    expect(changedPaths(before, await snapshotTree(root)), 'an invalid upstream snapshot must patch nothing').toEqual([]);
  });
});

// --- Unknown unmarked legacy rule prose (AC-004 counterexample) --------------------

const unknownLegacyAgents = '# Custom legacy rules\n\nCollaborator-specific rule.\n';
const legacySharedContextSection = marked('shared-context', '## Shared context\nFresh shared context body.');
const unknownLegacySourceFiles: Record<string, string> = {
  ...sourceFiles,
  'templates/project/AGENTS.md': `# Project contract template\n${legacySharedContextSection}`,
};
// Independent expected literal: the unknown rule prose is retained verbatim and the one
// safe missing owned section is appended once; no whole-file copy and no baseline.
const expectedUnknownLegacyAgents = `${unknownLegacyAgents}${legacySharedContextSection}`;

describe('project template unknown legacy prose', () => {
  it('retains unknown unmarked rule prose, appends the missing owned section once, and reports needs_attention', async () => {
    const root = await temporary('ai-workflow-sync-unknown-legacy-');
    roots.push(root);
    await writeAdoptedTarget(root);
    await writeFile(join(root, '.ai-workflow/AGENTS.md'), unknownLegacyAgents);

    const report = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(mergeCommit, unknownLegacySourceFiles) });

    // Unknown unmarked rule prose prevents a full managed-artifact claim.
    expect(report.status).toBe('needs_attention');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(true);
    expect(report.source.commit).toBe(mergeCommit);
    expect(report.warnings.some((warning) => warning.path === '.ai-workflow/AGENTS.md' && /unmarked|unknown/i.test(warning.reason))).toBe(true);

    // The unknown rule prose is retained as a prefix; the missing section is appended once; no whole-file copy.
    const upgraded = await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8');
    expect(upgraded).toBe(expectedUnknownLegacyAgents);
    expect(upgraded.startsWith(unknownLegacyAgents)).toBe(true);
    expect(upgraded.split('Collaborator-specific rule.').length - 1).toBe(1);
    expect(upgraded.split('## Shared context').length - 1).toBe(1);
    expect(upgraded).not.toBe(unknownLegacySourceFiles['templates/project/AGENTS.md']);

    // No baseline, project manifest, version stamp or sync record is created.
    expect(await exists(join(root, '.ai-workflow/project.yml'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/sync.json'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/.sync'))).toBe(false);
  });
});

// --- Owned section evolution: retire + keep + add in source order (AC-003) ---------

const evolutionTargetAgents = [
  'custom intro\n',
  marked('retired-rule', '## Retired rule\nretired body.'),
  'custom middle segment\n',
  marked('kept-rule', '## Kept rule\nold kept body.'),
  'custom outro\n',
].join('');
const evolutionSourceAgents = [
  '# Project contract template\n',
  marked('kept-rule', '## Kept rule\nfresh kept body.'),
  marked('added-first', '## Added first\nadded first body.'),
  marked('added-second', '## Added second\nadded second body.'),
].join('');
// Independent expected literal: only the retired owned span is removed; custom bytes are
// preserved; new owned sections follow source order with no duplicate.
const expectedEvolutionAgents = [
  'custom intro\n',
  'custom middle segment\n',
  marked('kept-rule', '## Kept rule\nfresh kept body.'),
  'custom outro\n',
  marked('added-first', '## Added first\nadded first body.'),
  marked('added-second', '## Added second\nadded second body.'),
].join('');
const evolutionSourceFiles: Record<string, string> = {
  ...sourceFiles,
  'templates/project/AGENTS.md': evolutionSourceAgents,
};

describe('project template owned section evolution', () => {
  it('retires a removed owned span, keeps the shared section, adds new sections in source order and reports updated', async () => {
    const root = await temporary('ai-workflow-sync-evolution-');
    roots.push(root);
    await writeAdoptedTarget(root);
    await writeFile(join(root, '.ai-workflow/AGENTS.md'), evolutionTargetAgents);

    const report = await synchronizeProject({ projectRoot: root, runGit: fixedHeadGit(mergeCommit, evolutionSourceFiles) });

    expect(report.updated).toContain('.ai-workflow/AGENTS.md');
    expect(report.conflicts).toEqual([]);

    const evolved = await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8');
    expect(evolved).toBe(expectedEvolutionAgents);
    // Retired owned span fully removed (markers and body), never retained as a duplicate.
    expect(evolved).not.toContain('retired-rule');
    expect(evolved).not.toContain('retired body');
    // Project-owned custom bytes between and around the owned spans are preserved verbatim.
    expect(evolved.split('custom intro').length - 1).toBe(1);
    expect(evolved.split('custom middle segment').length - 1).toBe(1);
    expect(evolved.split('custom outro').length - 1).toBe(1);
    // Kept section patched in place once; added sections appear once each in source order.
    expect(evolved.split('kept-rule').length - 1).toBe(2);
    expect(evolved.split('added-first').length - 1).toBe(2);
    expect(evolved.split('added-second').length - 1).toBe(2);
    expect(evolved.indexOf('added-first')).toBeLessThan(evolved.indexOf('added-second'));
  });
});
