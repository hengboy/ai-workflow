import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runProjectGate, readStoredProjectGate, type ProjectGateInput, type ProjectGateResult } from '../../src/sync/gate.js';
import type { SyncStatus } from '../../src/sync/index.js';
import { TemplateSourceTimeoutError } from '../../src/sync/source.js';
import { changedPaths, fakeGit, snapshotTree, temporary, type TestGitRunner } from '../helpers.js';
import { exists } from '../../src/utils/fs.js';
import { hostname } from 'node:os';
import { workspacePlanFixture } from '../helpers.js';
import { startRun } from '../../src/execution/manager.js';
import { executionPaths } from '../../src/execution/paths.js';

const COMMIT = 'a'.repeat(40);

/** The compact contract reference the gate must expose instead of a full contract body. */
interface AuthorityRef { path: string; digest: string; bytes: number }
type WithAuthorityRef = ProjectGateResult & { authority_ref?: AuthorityRef };

/** The fixed generated source allowlist: exactly the five replaceable documents. */
const SOURCE_PATHS = [
  'templates/project/AGENTS.md',
  'templates/project/notes/AGENTS.md',
  'templates/project/notes/README.md',
  'templates/project/notes/implemented/AGENTS.md',
  'templates/project/notes/archived/AGENTS.md',
] as const;

/** The full generated source-to-target mapping the synchronizer owns. Root MEMORY is init-only. */
const TARGETS: Record<string, string> = {
  'templates/project/AGENTS.md': '.ai-workflow/AGENTS.md',
  'templates/project/notes/AGENTS.md': '.ai-workflow/notes/AGENTS.md',
  'templates/project/notes/README.md': '.ai-workflow/notes/README.md',
  'templates/project/notes/implemented/AGENTS.md': '.ai-workflow/notes/implemented/AGENTS.md',
  'templates/project/notes/archived/AGENTS.md': '.ai-workflow/notes/archived/AGENTS.md',
};

// The complete notes management structure, listed literally so the fixture stays
// independent of the production directory helper.
const NOTE_LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived'] as const;
const NOTE_CLASSES = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing'] as const;
const NOTES_DIRECTORIES = [
  '.ai-workflow/notes',
  ...NOTE_LIFECYCLES.flatMap((lifecycle) => [`.ai-workflow/notes/${lifecycle}`, ...NOTE_CLASSES.map((noteClass) => `.ai-workflow/notes/${lifecycle}/${noteClass}`)]),
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

function docTitle(repoPath: string): string {
  return repoPath.slice(repoPath.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

/**
 * Independent expected upstream content for the fixture's immutable ref: every generated
 * member is a complete markerless document with a level-one title.
 */
function sourceContent(repoPath: string, ref: string): string {
  if (repoPath === 'templates/project/AGENTS.md') return `# Project contract\n\nFresh shared context at ${ref}.\n`;
  return `# ${docTitle(repoPath)}\n\nFresh generated body at ${ref} for ${repoPath}.\n`;
}

/** The full valid markerless source set at one commit. */
function sourceFiles(commit: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of SOURCE_PATHS) files[path] = sourceContent(path, commit);
  return files;
}

/**
 * Adopted target content: a complete markerless document with an older body, so a
 * successful synchronization replaces it as a whole file.
 */
function targetFileContents(commit: string, sourcePath: string): string {
  return `# ${docTitle(sourcePath)}\n\nOld generated body at ${commit} for ${sourcePath}.\n`;
}

function navigationJson(): string {
  return `${JSON.stringify({ version: 1, module_roots: [], features: [] }, null, 2)}\n`;
}

/** A fixed-HEAD git runner that materializes the given source set for one immutable commit. */
function fixedHeadGit(commit: string, files: Record<string, string>): TestGitRunner {
  return fakeGit({ commit, files }).runGit;
}

/** A git runner whose clone fails before any commit is known (status/rate-limit/network). */
function headFailureGit(): TestGitRunner {
  return async () => { throw new Error('source unavailable: clone failed'); };
}

/** A git runner whose clone is killed by the bounded acquisition before any commit is known. */
function timeoutCloneGit(): TestGitRunner {
  return async (arguments_) => {
    if (arguments_[0] === 'clone') {
      throw new TemplateSourceTimeoutError(
        'Template clone timed out: git clone https://github.com/hengboy/ai-workflow.git --branch main did not finish within 60000ms; the process was killed',
      );
    }
    throw new Error(`Unexpected git invocation after a timed-out clone: ${arguments_.join(' ')}`);
  };
}

/** Adoption prerequisites and project-owned data the synchronizer never writes. */
async function writeAdoptionPrerequisites(root: string): Promise<void> {
  for (const directory of NOTES_DIRECTORIES) await mkdir(join(root, directory), { recursive: true });
  await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(root, 'MEMORY.md'), '# Project memory\n\nProject-specific standard body.\n');
  await writeFile(join(root, '.ai-workflow/index/navigation.json'), navigationJson());
  await writeFile(join(root, '.ai-workflow/index/navigation.md'), '# Navigation\n\nAdopted navigation.\n');
  await writeFile(join(root, '.ai-workflow/notes/archived/manifest.json'), '{\n  "version": 1,\n  "files": {}\n}\n');
  // Already-complete ignore entries, so ignore reconciliation is a no-op.
  await writeFile(join(root, '.gitignore'), '.ai-workflow/plans/\n.worktrees/\n');
}

/** A minimal valid adoption: every generated target present with an older markerless body. */
async function writeAdoptedTarget(root: string, commit: string, overrides: Record<string, string> = {}): Promise<void> {
  await writeAdoptionPrerequisites(root);
  for (const [sourcePath, targetPath] of Object.entries(TARGETS)) {
    const contents = overrides[targetPath] ?? targetFileContents(commit, sourcePath);
    const target = join(root, targetPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

/** Every regular file the gate wrote under the opaque runtime directory, recursively sorted. */
async function runtimeFiles(runtimeDirectory: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(absolute);
    }
  }
  await walk(runtimeDirectory);
  return files.sort();
}

/** The one root-keyed cache file the gate is expected to have written; located by enumeration. */
async function singleRuntimeFile(runtimeDirectory: string): Promise<string> {
  const files = await runtimeFiles(runtimeDirectory);
  expect(files, 'exactly one runtime cache entry is expected').toHaveLength(1);
  return files[0]!;
}

/** Parse a cache file to prove the stored entry is complete and structurally valid JSON. */
async function parseRuntimeFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

// A generated target that still carries the retired `ai-workflow:section` comment syntax is
// refused with a manual-replacement instruction; nothing is parsed, adopted or migrated.
const LEGACY_MARKER_AGENTS = '# Contract\n\n<!-- ai-workflow:section shared-context:begin -->\nnever replaced\n<!-- ai-workflow:section shared-context:end -->\n';

interface SeverityCase {
  name: string;
  host: 'claude' | 'codex' | 'opencode';
  /** Write the adopted target and return the injectable git runner. */
  setup: (root: string, commit: string) => Promise<TestGitRunner>;
  expected: {
    decision: 'allow' | 'deny';
    status: SyncStatus;
    verified: boolean;
    proceed: boolean;
    /** The current on-disk contract reference must be exposed when this run safely changed it. */
    authorityRef: boolean;
    /** Only the synchronized case proves an actual patch reached the contract. */
    updatedContains?: string[];
  };
  /** A generated target's parent directory to make read-only so publication fails mid-run. */
  readOnlyDirectory?: string;
}

// Every case now runs through the one automatic trigger, `PhaseEntry`; its report mapping
// is preserved as a regression guard while the trigger cadence changes.
const severityCases: SeverityCase[] = [
  {
    name: 'a phase entry on an adopted project with a safe full-file update allows and exposes the fresh contract reference',
    host: 'claude',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit);
      return fixedHeadGit(commit, sourceFiles(commit));
    },
    expected: { decision: 'allow', status: 'synchronized', verified: true, proceed: true, authorityRef: true, updatedContains: ['.ai-workflow/AGENTS.md'] },
  },
  {
    name: 'a failed source branch allows warning continuation instead of a host denial',
    host: 'codex',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit);
      return headFailureGit();
    },
    expected: { decision: 'allow', status: 'unverified', verified: false, proceed: true, authorityRef: false },
  },
  {
    name: 'a generated target carrying legacy section markers denies with a visible manual-replacement reason',
    host: 'claude',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit, { '.ai-workflow/AGENTS.md': LEGACY_MARKER_AGENTS });
      return fixedHeadGit(commit, sourceFiles(commit));
    },
    expected: { decision: 'deny', status: 'conflict', verified: false, proceed: false, authorityRef: false },
  },
  {
    name: 'an ordinary filesystem failure denies with a visible reason',
    host: 'codex',
    readOnlyDirectory: '.ai-workflow',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit);
      return fixedHeadGit(commit, sourceFiles(commit));
    },
    expected: { decision: 'deny', status: 'failed', verified: false, proceed: false, authorityRef: false },
  },
];

describe('project sync gate phase-entry report mapping (AC-001/AC-003)', () => {
  it.each(severityCases)('AC-001/AC-003: $name', async (testCase) => {
    const root = await temporary('ai-workflow-gate-');
    const runtimeDirectory = await temporary('ai-workflow-gate-runtime-');
    roots.push(root, runtimeDirectory);
    const runGit = await testCase.setup(root, COMMIT);

    let result: WithAuthorityRef | undefined;
    let thrown: unknown;
    const readOnlyTarget = testCase.readOnlyDirectory === undefined ? undefined : join(root, testCase.readOnlyDirectory);
    if (readOnlyTarget) await chmod(readOnlyTarget, 0o555);
    try {
      if (readOnlyTarget) {
        const writable = await access(readOnlyTarget, constants.W_OK).then(() => true, () => false);
        if (writable) throw new Error('This environment cannot enforce a read-only directory (likely running as root); the filesystem-failure gate case requires an unprivileged process.');
      }
      result = await runProjectGate(
        { host: testCase.host, event: 'PhaseEntry', sessionId: 'session-1', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
        { runGit, runtimeDirectory },
      ) as WithAuthorityRef;
    } catch (error) {
      thrown = error;
    } finally {
      if (readOnlyTarget) await chmod(readOnlyTarget, 0o755);
    }
    if (thrown instanceof Error && /cannot enforce a read-only directory/.test(thrown.message)) throw thrown;

    expect(thrown, 'the gate reports a decision, it does not throw').toBeUndefined();
    expect(result).toBeDefined();
    const gate = result!;
    expect(gate.decision).toBe(testCase.expected.decision);
    expect(gate.context.length).toBeGreaterThan(0);
    expect(gate.report, 'the gate exposes the synchronization report').toBeDefined();
    expect(gate.report!.status).toBe(testCase.expected.status);
    expect(gate.report!.verified).toBe(testCase.expected.verified);
    expect(gate.report!.proceed).toBe(testCase.expected.proceed);

    // A CLI warning (exit 2) must translate to an allowed continuation in the shared
    // decision, never a host denial; its reason stays visible to the caller.
    if (testCase.expected.decision === 'allow' && !testCase.expected.verified) {
      const reasons = [...gate.report!.warnings, ...gate.report!.conflicts].map((entry) => entry.reason);
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons.some((reason) => gate.context.includes(reason)), 'the warning reason must be visible in the context').toBe(true);
    }

    // A blocking decision names the affected reason, not an opaque denial.
    if (testCase.expected.decision === 'deny') {
      const reasons = [...gate.report!.conflicts, ...gate.report!.warnings].map((entry) => entry.reason);
      expect(reasons.some((reason) => gate.context.includes(reason)), 'the denial reason must be visible in the context').toBe(true);
    }

    if (testCase.expected.updatedContains) {
      for (const path of testCase.expected.updatedContains) expect(gate.report!.updated).toContain(path);
    }

    // `authority_ref` is the current on-disk contract reference, not an upstream freshness
    // claim. Any invocation that safely published a contract change must expose it.
    // Results with no safe contract update (source unverified with zero writes, conflict,
    // failed) are not required to expose it and are intentionally left unasserted here.
    if (testCase.expected.authorityRef) {
      const contractPath = join(root, '.ai-workflow/AGENTS.md');
      const contractBytes = await readFile(contractPath);
      expect(gate.authority_ref, 'the current contract must be referenced, not embedded').toEqual({
        path: contractPath,
        digest: `sha256:${createHash('sha256').update(contractBytes).digest('hex')}`,
        bytes: contractBytes.byteLength,
      });
      expect(gate.authority_ref!.digest, 'the digest must be a sha256 reference').toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(gate.context, 'the context must carry no contract body').not.toContain('Fresh shared context at');
      expect(gate.context.length, 'the context must stay below 1000 characters').toBeLessThan(1000);
    }

    // AC-001/AC-002: a phase entry stores exactly one complete, parsable root-keyed version 2
    // cache entry that carries the reference and no contract body.
    const cacheFile = await singleRuntimeFile(runtimeDirectory);
    const storedText = await readFile(cacheFile, 'utf8');
    const stored = JSON.parse(storedText) as { version?: unknown; result?: Record<string, unknown> };
    expect(stored.version, 'the stored unit must be version 2').toBe(2);
    if (testCase.expected.authorityRef) {
      expect(stored.result?.authority_ref, 'the stored unit must carry the reference').toEqual(gate.authority_ref);
      expect(stored.result, 'the stored unit must carry no authority key').not.toHaveProperty('authority');
      expect(storedText, 'the stored unit must contain no contract body').not.toContain('Fresh shared context at');
    }
    expect(await parseRuntimeFile(cacheFile), 'the stored cache entry must be a complete JSON object').toBeTruthy();
  });
});

describe('project sync gate native event cache reuse (AC-002/AC-003)', () => {
  it('AC-002/AC-003: replays the stored phase result verbatim across native events with zero source requests', async () => {
    const root = await temporary('ai-workflow-gate-replay-');
    const runtimeDirectory = await temporary('ai-workflow-gate-replay-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const source = { commit: 'a'.repeat(40), files: sourceFiles('a'.repeat(40)) };
    const fake = fakeGit(source);
    const options = { runGit: fake.runGit, runtimeDirectory };
    const invoke = (input: Omit<ProjectGateInput, 'host'>): Promise<WithAuthorityRef> =>
      runProjectGate({ host: 'claude', toolName: 'Bash', toolInput: { command: 'ls' }, ...input }, options) as Promise<WithAuthorityRef>;

    const stored = await invoke({ event: 'PhaseEntry', sessionId: 'session-1', cwd: root });
    expect(stored.decision).toBe('allow');
    expect(stored.report?.source.commit).toBe(source.commit);
    expect(stored.authority_ref, 'a safe contract update must store the contract reference').toBeDefined();
    const cloneAfterPhase = fake.cloneCount();
    const gitAfterPhase = fake.invocationCount();
    const runtimeAfterPhase = await snapshotTree(runtimeDirectory);
    const rootAfterPhase = await snapshotTree(root);

    const natives: Array<Omit<ProjectGateInput, 'host'>> = [
      { event: 'SessionStart', sessionId: 'session-1', cwd: root },
      { event: 'SessionStart', sessionId: 'child', cwd: root },
      { event: 'UserPromptSubmit', sessionId: 'session-1', cwd: root },
      { event: 'PreToolUse', sessionId: 'session-1', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      { event: 'PreToolUse', sessionId: 'child', cwd: root, toolName: 'Bash', toolInput: { command: 'pwd' } },
      { event: 'tool.execute.before', sessionId: 'session-1', cwd: root, toolName: 'Bash', toolInput: { command: 'echo hi' } },
    ];
    for (const native of natives) {
      const replay = await invoke(native);
      expect(replay, `${native.event} must return the stored result verbatim`).toEqual(stored);
      expect(replay.decision, native.event).toBe('allow');
      expect(replay.report?.status, native.event).toBe(stored.report?.status);
      expect(replay.report?.verified, native.event).toBe(stored.report?.verified);
      expect(replay.report?.proceed, native.event).toBe(stored.report?.proceed);
      expect(replay.authority_ref, `${native.event} must replay the same reference`).toEqual(stored.authority_ref);
      expect(replay.report?.source.commit, native.event).toBe(source.commit);
      expect(replay.context.length, `${native.event} must keep a short replay context`).toBeLessThan(1000);
    }

    expect(fake.cloneCount(), 'native events must never clone the source').toBe(cloneAfterPhase);
    expect(fake.invocationCount(), 'native events must issue zero git invocations').toBe(gitAfterPhase);
    expect(changedPaths(runtimeAfterPhase, await snapshotTree(runtimeDirectory)), 'native events must not rewrite the stored entry').toEqual([]);
    expect(changedPaths(rootAfterPhase, await snapshotTree(root)), 'native events must not touch the project tree').toEqual([]);
  });

  it('AC-003: replays a stored deny to native events without clearing it or querying the source', async () => {
    const root = await temporary('ai-workflow-gate-deny-');
    const runtimeDirectory = await temporary('ai-workflow-gate-deny-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT, { '.ai-workflow/AGENTS.md': LEGACY_MARKER_AGENTS });
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };

    const stored = await runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'deny-session', cwd: root }, options);
    expect(stored.decision).toBe('deny');
    expect(stored.report?.status).toBe('conflict');
    const cloneAfterPhase = fake.cloneCount();
    const gitAfterPhase = fake.invocationCount();

    const toolReplay = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'other-session', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      options,
    );
    expect(toolReplay, 'an ordinary tool call must be blocked by the stored deny').toEqual(stored);
    expect(toolReplay.decision).toBe('deny');

    const turnReplay = await runProjectGate({ host: 'claude', event: 'UserPromptSubmit', sessionId: 'other-session', cwd: root }, options);
    expect(turnReplay, 'a user turn must replay the stored deny').toEqual(stored);

    expect(fake.cloneCount(), 'replaying a stored deny must not clone the source').toBe(cloneAfterPhase);
    expect(fake.invocationCount(), 'replaying a stored deny must issue zero git invocations').toBe(gitAfterPhase);
  });
});

describe('project sync gate no stored result (AC-004)', () => {
  function expectNoCheck(result: ProjectGateResult): void {
    expect(result.decision).toBe('allow');
    expect(result.report, 'a missing check must not fabricate a report').toBeUndefined();
    expect((result as WithAuthorityRef).authority_ref, 'a missing check must not fabricate a reference').toBeUndefined();
    expect(result.context.length).toBeGreaterThan(0);
    expect(result.context, 'the no-check context must state that no check has run').toMatch(/no[\s\S]{0,80}(check|synchroni)/i);
  }

  it('AC-004: allows an adopted native event without a report, any source request or any write', async () => {
    const root = await temporary('ai-workflow-gate-nocheck-');
    const runtimeDirectory = await temporary('ai-workflow-gate-nocheck-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const runtimeBefore = await snapshotTree(runtimeDirectory);
    const rootBefore = await snapshotTree(root);

    const result = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'no-check', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      { runGit: fake.runGit, runtimeDirectory },
    );

    expectNoCheck(result);
    expect(fake.cloneCount(), 'a no-check native event must not clone the source').toBe(0);
    expect(fake.invocationCount(), 'a no-check native event must issue zero git invocations').toBe(0);
    expect(changedPaths(runtimeBefore, await snapshotTree(runtimeDirectory)), 'a no-check native event must write no runtime entry').toEqual([]);
    expect(changedPaths(rootBefore, await snapshotTree(root)), 'a no-check native event must not touch the project').toEqual([]);
  });

  it('AC-004: treats a corrupt or truncated cache entry as no check without any source request', async () => {
    for (const mode of ['invalid-json', 'truncated'] as const) {
      const root = await temporary('ai-workflow-gate-corrupt-');
      const runtimeDirectory = await temporary('ai-workflow-gate-corrupt-runtime-');
      roots.push(root, runtimeDirectory);
      await writeAdoptedTarget(root, COMMIT);
      const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
      const options = { runGit: fake.runGit, runtimeDirectory };

      const primed = await runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'prime', cwd: root }, options);
      expect(primed.report?.status).toBe('synchronized');
      const cacheFile = await singleRuntimeFile(runtimeDirectory);
      if (mode === 'invalid-json') {
        await writeFile(cacheFile, '{ this is not valid json');
      } else {
        const valid = await readFile(cacheFile, 'utf8');
        await writeFile(cacheFile, valid.slice(0, Math.max(1, Math.floor(valid.length / 2))));
      }
      const cloneAfterPrime = fake.cloneCount();
      const gitAfterPrime = fake.invocationCount();
      const runtimeBefore = await snapshotTree(runtimeDirectory);

      const result = await runProjectGate(
        { host: 'claude', event: 'PreToolUse', sessionId: 'after-corrupt', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
        options,
      );
      expectNoCheck(result);
      expect(fake.cloneCount(), `${mode}: a corrupt cache must not clone the source`).toBe(cloneAfterPrime);
      expect(fake.invocationCount(), `${mode}: a corrupt cache must not issue a git invocation`).toBe(gitAfterPrime);
      expect(changedPaths(runtimeBefore, await snapshotTree(runtimeDirectory)), `${mode}: a corrupt cache must not be rewritten`).toEqual([]);
    }
  });

  it('AC-004: treats an unreadable cache entry as no check without any source request', async () => {
    const root = await temporary('ai-workflow-gate-unreadable-');
    const runtimeDirectory = await temporary('ai-workflow-gate-unreadable-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };

    const primed = await runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'prime', cwd: root }, options);
    expect(primed.report?.status).toBe('synchronized');

    // Force a read error at the exact cache path the gate wrote, by occupying it with a directory.
    const cacheFile = await singleRuntimeFile(runtimeDirectory);
    await rm(cacheFile, { force: true });
    await mkdir(cacheFile);
    const cloneAfterPrime = fake.cloneCount();
    const gitAfterPrime = fake.invocationCount();
    const runtimeBefore = await snapshotTree(runtimeDirectory);

    const result = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'after-unreadable', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      options,
    );
    expectNoCheck(result);
    expect(fake.cloneCount(), 'an unreadable cache must not clone the source').toBe(cloneAfterPrime);
    expect(fake.invocationCount(), 'an unreadable cache must not issue a git invocation').toBe(gitAfterPrime);
    expect(changedPaths(runtimeBefore, await snapshotTree(runtimeDirectory)), 'an unreadable cache must not be rewritten').toEqual([]);
  });
});

describe('project sync gate unadopted project (AC-005)', () => {
  it('AC-005: skips every event form in a directory without an adoption and writes nothing', async () => {
    const root = await temporary('ai-workflow-gate-unadopted-');
    const runtimeDirectory = await temporary('ai-workflow-gate-unadopted-runtime-');
    roots.push(root, runtimeDirectory);

    const events: Array<Omit<ProjectGateInput, 'host' | 'cwd'>> = [
      { event: 'PhaseEntry', sessionId: 's' },
      { event: 'SessionStart', sessionId: 's' },
      { event: 'UserPromptSubmit', sessionId: 's' },
      { event: 'PreToolUse', sessionId: 's', toolName: 'Bash', toolInput: { command: 'ls' } },
      { event: 'tool.execute.before', sessionId: 's', toolName: 'Bash', toolInput: { command: 'ls' } },
    ];
    for (const event of events) {
      const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
      const runtimeBefore = await snapshotTree(runtimeDirectory);
      const rootBefore = await snapshotTree(root);

      const gate = await runProjectGate({ host: 'codex', cwd: root, ...event }, { runGit: fake.runGit, runtimeDirectory }) as WithAuthorityRef;

      expect(gate.decision, event.event).toBe('skip');
      expect(gate.authority_ref, event.event).toBeUndefined();
      expect(gate.report, `${event.event}: a skip must not fabricate a report`).toBeUndefined();
      expect(fake.cloneCount(), `${event.event}: an unadopted project must not clone the source`).toBe(0);
      expect(fake.invocationCount(), `${event.event}: an unadopted project must issue zero git invocations`).toBe(0);
      expect(changedPaths(runtimeBefore, await snapshotTree(runtimeDirectory)), `${event.event}: an unadopted project must write no runtime entry`).toEqual([]);
      expect(changedPaths(rootBefore, await snapshotTree(root)), `${event.event}: an unadopted project must stay unchanged`).toEqual([]);
    }
    expect(await exists(join(root, '.ai-workflow')), 'an unadopted project must not be initialized by the gate').toBe(false);
    expect(await runtimeFiles(runtimeDirectory), 'an unadopted project must leave the runtime tree empty').toEqual([]);
  });
});

describe('project sync gate single-start lifecycle (AC-001/AC-002)', () => {
  it('AC-001/AC-002: synchronizes once per phase entry, never at a later native event, and keeps each actual root separate', async () => {
    const parentRoot = await temporary('ai-workflow-gate-parent-');
    const worktreeRoot = await temporary('ai-workflow-gate-worktree-');
    const runtimeDirectory = await temporary('ai-workflow-gate-lifecycle-runtime-');
    roots.push(parentRoot, worktreeRoot, runtimeDirectory);
    await writeAdoptedTarget(parentRoot, COMMIT);
    await writeAdoptedTarget(worktreeRoot, COMMIT);

    const source = { commit: 'a'.repeat(40), files: sourceFiles('a'.repeat(40)) };
    const fake = fakeGit(source);
    const options = { runGit: fake.runGit, runtimeDirectory };
    const invoke = (input: Omit<ProjectGateInput, 'host'>): Promise<WithAuthorityRef> =>
      runProjectGate({ host: 'claude', toolName: 'Bash', toolInput: { command: 'ls' }, ...input }, options) as Promise<WithAuthorityRef>;

    // One phase entry resolves the source for the actual root.
    const A = source.commit;
    const first = await invoke({ event: 'PhaseEntry', sessionId: 'parent', cwd: parentRoot });
    expect(first.decision).toBe('allow');
    expect(first.project).toBe(parentRoot);
    expect(first.report?.source.commit).toBe(A);
    expect(fake.cloneCount()).toBe(1);
    const gitAfterFirst = fake.invocationCount();
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`Fresh shared context at ${A}`);
    expect(await runtimeFiles(runtimeDirectory)).toHaveLength(1);

    // Upstream advances, but no native event may observe it or re-synchronize. This is the
    // key cadence difference from today's per-boundary invalidation.
    source.commit = 'b'.repeat(40);
    source.files = sourceFiles('b'.repeat(40));
    const runtimeAfterFirst = await snapshotTree(runtimeDirectory);
    const parentAfterFirst = await snapshotTree(parentRoot);
    const natives: Array<Omit<ProjectGateInput, 'host'>> = [
      { event: 'PreToolUse', sessionId: 'parent', cwd: parentRoot, toolName: 'Bash', toolInput: { command: 'ls' } },
      { event: 'PreToolUse', sessionId: 'child', cwd: parentRoot, toolName: 'Bash', toolInput: { command: 'pwd' } },
      { event: 'SessionStart', sessionId: 'child', cwd: parentRoot },
      { event: 'SessionStart', sessionId: 'parent', cwd: parentRoot },
      { event: 'UserPromptSubmit', sessionId: 'parent', cwd: parentRoot },
      { event: 'tool.execute.before', sessionId: 'parent', cwd: parentRoot, toolName: 'Bash', toolInput: { command: 'echo hi' } },
    ];
    for (const native of natives) {
      const replay = await invoke(native);
      expect(replay.decision, native.event).toBe('allow');
      expect(replay.report?.source.commit, `${native.event} must replay the stored commit`).toBe(A);
    }
    expect(fake.cloneCount(), 'no native event may re-synchronize the parent root').toBe(1);
    expect(fake.invocationCount(), 'no native event may issue a git invocation').toBe(gitAfterFirst);
    expect(changedPaths(runtimeAfterFirst, await snapshotTree(runtimeDirectory)), 'native events must not rewrite the cache').toEqual([]);
    expect(changedPaths(parentAfterFirst, await snapshotTree(parentRoot)), 'native events must not edit the contract').toEqual([]);
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`Fresh shared context at ${A}`);

    // A second phase entry replaces the stored entry rather than adding one, and picks up B.
    const B = source.commit;
    const second = await invoke({ event: 'PhaseEntry', sessionId: 'parent', cwd: parentRoot });
    expect(second.report?.source.commit).toBe(B);
    expect(fake.cloneCount()).toBe(2);
    expect(await runtimeFiles(runtimeDirectory), 'a second phase entry must replace the stored entry').toHaveLength(1);
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`Fresh shared context at ${B}`);
    const gitAfterSecond = fake.invocationCount();
    const replayB = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: parentRoot });
    expect(replayB.report?.source.commit).toBe(B);
    expect(fake.invocationCount(), 'the replaced entry must be served with zero git invocations').toBe(gitAfterSecond);

    // A distinct actual root with its own `.ai-workflow/` has no stored check: no-check allow,
    // zero requests, and it never replays the parent root's decision or authority.
    source.commit = 'c'.repeat(40);
    source.files = sourceFiles('c'.repeat(40));
    const C = source.commit;
    const worktreeBefore = await snapshotTree(worktreeRoot);
    const worktreeNative = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: worktreeRoot });
    expect(worktreeNative.decision).toBe('allow');
    expect(worktreeNative.project).toBe(worktreeRoot);
    expect(worktreeNative.report, 'an unprimed worktree must not replay the parent report').toBeUndefined();
    expect(worktreeNative.authority_ref, 'an unprimed worktree must not replay the parent reference').toBeUndefined();
    expect(fake.cloneCount(), 'an unprimed worktree native event must not clone the source').toBe(2);
    expect(changedPaths(worktreeBefore, await snapshotTree(worktreeRoot)), 'an unprimed worktree must not be edited').toEqual([]);
    expect(await runtimeFiles(runtimeDirectory)).toHaveLength(1);

    // Only a phase entry in the second root synchronizes it into its own entry.
    const worktreePhase = await invoke({ event: 'PhaseEntry', sessionId: 'parent', cwd: worktreeRoot });
    expect(worktreePhase.project).toBe(worktreeRoot);
    expect(worktreePhase.report?.source.commit).toBe(C);
    expect(fake.cloneCount()).toBe(3);
    expect(await runtimeFiles(runtimeDirectory), 'each actual root keeps its own cache entry').toHaveLength(2);
    expect(await readFile(join(worktreeRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`Fresh shared context at ${C}`);
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8'), 'syncing the worktree must not edit the parent').toContain(`Fresh shared context at ${B}`);

    const gitAfterWorktree = fake.invocationCount();
    const worktreeReplay = await invoke({ event: 'UserPromptSubmit', sessionId: 'child', cwd: worktreeRoot });
    expect(worktreeReplay.report?.source.commit).toBe(C);
    expect(fake.invocationCount(), 'the worktree entry must be served with zero git invocations').toBe(gitAfterWorktree);

    // No project-local synchronization metadata is created in either root.
    for (const metadata of ['.ai-workflow/sync.json', '.ai-workflow/project.yml', '.ai-workflow/.sync']) {
      expect(await exists(join(parentRoot, metadata)), `${metadata} must not be created in the parent`).toBe(false);
      expect(await exists(join(worktreeRoot, metadata)), `${metadata} must not be created in the worktree`).toBe(false);
    }
  });
});

function expectNoFreshness(result: ProjectGateResult): void {
  expect(result.report?.verified ?? false).toBe(false);
  if (result.report !== undefined) expect(result.report.status).not.toBe('synchronized');
}

describe('project sync gate actor and authority exemptions (AC-003)', () => {
  it('AC-003/REQ-002: permits the exact sync actor and contract read through a stored conflict without clearing it and without a request', async () => {
    const root = await temporary('ai-workflow-gate-exempt-');
    const runtimeDirectory = await temporary('ai-workflow-gate-exempt-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT, { '.ai-workflow/AGENTS.md': LEGACY_MARKER_AGENTS });
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };
    const invoke = (toolName: string, toolInput: unknown): Promise<WithAuthorityRef> =>
      runProjectGate({ host: 'opencode', event: 'PreToolUse', sessionId: 'exempt-session', cwd: root, toolName, toolInput }, options) as Promise<WithAuthorityRef>;

    const contractPath = join(root, '.ai-workflow/AGENTS.md');
    const contract = await readFile(contractPath, 'utf8');
    const before = await snapshotTree(root);

    // A phase entry stores the true conflict (not a source-failure warning) and denies ordinary tools.
    const primed = await runProjectGate({ host: 'opencode', event: 'PhaseEntry', sessionId: 'exempt-session', cwd: root }, options);
    expect(primed.decision).toBe('deny');
    expect(primed.report?.status).toBe('conflict');
    expect(primed.report?.verified).toBe(false);
    const gitAfterPrime = fake.invocationCount();
    const cloneAfterPrime = fake.cloneCount();
    const runtimeAfterPrime = await snapshotTree(runtimeDirectory);
    expect(await runtimeFiles(runtimeDirectory)).toHaveLength(1);

    const ordinary = await invoke('Bash', { command: 'ls -la' });
    expect(ordinary.decision).toBe('deny');
    expect(ordinary.report?.status).toBe('conflict');

    // The exact sync actor is permitted so preflight cannot recurse or deadlock; the cached
    // ordinary deny is neither cleared nor bypassed, and no freshness is claimed.
    for (const [toolName, command] of [
      ['Bash', `ai-workflow sync-hook --host opencode --phase --project ${root}`],
      ['bash', `ai-workflow sync ${root}`],
      ['shell', `ai-workflow sync-hook --host opencode --phase --project ${root}`],
      ['shell', `ai-workflow sync ${root}`],
    ] as const) {
      const actor = await invoke(toolName, { command });
      expect(actor.decision, `actor: ${command}`).toBe('allow');
      expectNoFreshness(actor);
      const stillDenied = await invoke('Bash', { command: 'ls -la' });
      expect(stillDenied.decision).toBe('deny');
      expect(stillDenied.report?.status).toBe('conflict');
    }

    // The required authority read of the exact project contract is permitted for every native
    // casings/key, including the OpenCode 2.x `path` shape, even while the cached conflict
    // keeps ordinary tools denied.
    for (const [toolName, key] of [['read', 'filePath'], ['Read', 'file_path'], ['read', 'path']] as const) {
      const authorityRead = await invoke(toolName, { [key]: contractPath });
      expect(authorityRead.decision, `authority read: ${toolName}`).toBe('allow');
      expectNoFreshness(authorityRead);
      if (authorityRead.authority_ref !== undefined) expect(authorityRead.authority_ref.path).toBe(contractPath);
      const stillDenied = await invoke('Bash', { command: 'ls -la' });
      expect(stillDenied.decision).toBe('deny');
    }

    // Only the exact actor and the exact contract read are exempted, not every token-bearing
    // command or nearby file.
    const lookalikeCommand = await invoke('Bash', { command: `echo ai-workflow sync-hook --host opencode --phase --project ${root}` });
    expect(lookalikeCommand.decision).toBe('deny');
    const nearMissFile = await invoke('read', { filePath: `${contractPath}.bak` });
    expect(nearMissFile.decision).toBe('deny');
    const nearMissV2Path = await invoke('read', { path: `${contractPath}.bak` });
    expect(nearMissV2Path.decision, 'a V2 near-miss path is not the exact contract').toBe('deny');
    const unrelatedV2Path = await invoke('read', { path: join(root, 'MEMORY.md') });
    expect(unrelatedV2Path.decision, 'a V2 read of another file is not the exact contract').toBe('deny');
    const unrelatedFile = await invoke('read', { filePath: join(root, 'MEMORY.md') });
    expect(unrelatedFile.decision).toBe('deny');

    expect(fake.cloneCount(), 'exemptions and native replays must not clone the source').toBe(cloneAfterPrime);
    expect(fake.invocationCount(), 'exemptions and native replays must issue zero git invocations').toBe(gitAfterPrime);
    expect(changedPaths(runtimeAfterPrime, await snapshotTree(runtimeDirectory)), 'native events must not rewrite the stored deny').toEqual([]);
    expect(changedPaths(before, await snapshotTree(root)), 'permitting a tool must not write the project').toEqual([]);
    expect(await readFile(contractPath, 'utf8')).toBe(contract);
  });
});

describe('project sync gate concurrent phase entries (AC-001/AC-002)', () => {
  it('AC-001/AC-002: concurrent phase entries leave one complete cache entry that a native event replays with zero requests', async () => {
    const root = await temporary('ai-workflow-gate-concurrent-');
    const runtimeDirectory = await temporary('ai-workflow-gate-concurrent-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };

    const [first, second] = await Promise.all([
      runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'concurrent-1', cwd: root }, options),
      runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'concurrent-2', cwd: root }, options),
    ]);
    expect(first.decision).toBe('allow');
    expect(second.decision).toBe('allow');

    const files = await runtimeFiles(runtimeDirectory);
    expect(files, 'concurrent phase entries must leave exactly one cache entry').toHaveLength(1);
    expect(await parseRuntimeFile(files[0]!), 'the surviving entry must be complete and parsable').toBeTruthy();

    const gitAfterPhases = fake.invocationCount();
    const replay = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'after', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      options,
    );
    expect(replay.decision).toBe('allow');
    expect(replay.report, 'the following native event must replay a complete stored result').toBeDefined();
    expect(fake.invocationCount(), 'the replay must issue zero git invocations').toBe(gitAfterPhases);
  });
});

describe('project sync gate supported project path routing (AC-002/AC-003)', () => {
  it('AC-002/AC-003: routes a native event to its own adopted root cache and primes that root only through a phase entry', async () => {
    const sessionRoot = await temporary('ai-workflow-gate-session-');
    const operationRoot = await temporary('ai-workflow-gate-operation-');
    const runtimeDirectory = await temporary('ai-workflow-gate-route-runtime-');
    roots.push(sessionRoot, operationRoot, runtimeDirectory);
    await writeAdoptedTarget(sessionRoot, COMMIT);
    await writeAdoptedTarget(operationRoot, COMMIT);
    await mkdir(join(operationRoot, 'src'), { recursive: true });
    await writeFile(join(operationRoot, 'src/file.ts'), 'export const routed = true;\n');
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };
    const invoke = (input: Omit<ProjectGateInput, 'host'>): Promise<WithAuthorityRef> =>
      runProjectGate({ host: 'claude', toolName: 'Bash', toolInput: { command: 'ls' }, ...input }, options) as Promise<WithAuthorityRef>;

    const operationAgents = join(operationRoot, '.ai-workflow/AGENTS.md');
    expect(await readFile(operationAgents, 'utf8')).not.toContain(`Fresh shared context at ${COMMIT}`);

    // Prime only the session root with a phase entry.
    const primed = await invoke({ event: 'PhaseEntry', sessionId: 'route-session', cwd: sessionRoot });
    expect(primed.project).toBe(sessionRoot);
    expect(primed.report?.status).toBe('synchronized');
    const cloneAfterPrime = fake.cloneCount();
    const gitAfterPrime = fake.invocationCount();
    const sessionRootAfterPrime = await snapshotTree(sessionRoot);

    // A native event at the session root answers from that root's cache with no request.
    const sessionNative = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot });
    expect(sessionNative.project).toBe(sessionRoot);
    expect(sessionNative.report?.project).toBe(sessionRoot);
    expect(fake.invocationCount(), 'a primed native event must issue no git invocation').toBe(gitAfterPrime);

    // A Bash `workdir` targeting another adopted root has no stored check: no-check allow, no
    // request and no write, and it must not reuse the session root's cached result.
    const operationBefore = await snapshotTree(operationRoot);
    const routedBash = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot, toolName: 'Bash', toolInput: { command: 'ls', workdir: operationRoot } });
    expect(routedBash.project).toBe(operationRoot);
    expect(routedBash.decision).toBe('allow');
    expect(routedBash.report, 'an unprimed routed root must not synchronize').toBeUndefined();
    expect(fake.cloneCount(), 'routing to an unprimed root must not clone the source').toBe(cloneAfterPrime);
    expect(changedPaths(operationBefore, await snapshotTree(operationRoot)), 'the routed no-check must not edit that root').toEqual([]);
    expect(await readFile(operationAgents, 'utf8')).not.toContain(`Fresh shared context at ${COMMIT}`);

    // Only a phase entry in the routed root synchronizes it.
    const operationPhase = await invoke({ event: 'PhaseEntry', sessionId: 'route-operation', cwd: operationRoot });
    expect(operationPhase.project).toBe(operationRoot);
    expect(operationPhase.report?.project).toBe(operationRoot);
    expect(operationPhase.report?.status).toBe('synchronized');
    expect(operationPhase.report?.source.commit).toBe(COMMIT);
    expect(fake.cloneCount()).toBe(cloneAfterPrime + 1);
    expect(await readFile(operationAgents, 'utf8'), 'the phase entry must sync the routed root').toContain(`Fresh shared context at ${COMMIT}`);
    expect(changedPaths(sessionRootAfterPrime, await snapshotTree(sessionRoot)), 'the session root must not be touched by a routed operation').toEqual([]);

    // Now native routed operations replay the routed root's cached result with no request.
    const gitAfterOperation = fake.invocationCount();
    const routedRead = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot, toolName: 'read', toolInput: { filePath: join(operationRoot, 'src/file.ts') } });
    expect(routedRead.project).toBe(operationRoot);
    expect(routedRead.report?.project).toBe(operationRoot);
    expect(fake.invocationCount(), 'a routed read must answer from the routed root cache').toBe(gitAfterOperation);

    const routedBashReplay = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot, toolName: 'Bash', toolInput: { command: 'ls', workdir: operationRoot } });
    expect(routedBashReplay.project).toBe(operationRoot);
    expect(routedBashReplay.report?.project).toBe(operationRoot);
    expect(fake.invocationCount()).toBe(gitAfterOperation);

    // A relative tool path resolves against the session cwd, never by guessing a parent root.
    const relativeRead = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot, toolName: 'read', toolInput: { filePath: 'src/file.ts' } });
    expect(relativeRead.project).toBe(sessionRoot);
    expect(relativeRead.report?.project).toBe(sessionRoot);
    expect(changedPaths(sessionRootAfterPrime, await snapshotTree(sessionRoot)), 'a relative path must not reroute the operation').toEqual([]);
    expect(fake.invocationCount()).toBe(gitAfterOperation);
  });
});

describe('project sync gate project-owned memory (REQ-002 / AC-011)', () => {
  it('never writes project MEMORY and never exposes it as generated authority', async () => {
    const root = await temporary('ai-workflow-gate-memory-');
    const runtimeDirectory = await temporary('ai-workflow-gate-memory-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);

    // Bring every generated target to the source bytes so the only remaining divergence is the
    // project-owned MEMORY file, which synchronization no longer manages.
    for (const [sourcePath, targetPath] of Object.entries(TARGETS)) {
      await writeFile(join(root, targetPath), sourceContent(sourcePath, COMMIT));
    }
    const memoryPath = join(root, 'MEMORY.md');
    const memoryBefore = await readFile(memoryPath);
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });

    const result = await runProjectGate(
      { host: 'claude', event: 'PhaseEntry', sessionId: 'memory-session', cwd: root },
      { runGit: fake.runGit, runtimeDirectory },
    ) as WithAuthorityRef;

    expect(result.decision).toBe('allow');
    expect(result.report?.status).toBe('synchronized');
    expect(result.report?.created).not.toContain('MEMORY.md');
    expect(result.report?.updated).not.toContain('MEMORY.md');
    expect(result.authority_ref, 'project MEMORY is not a generated authority path').toBeUndefined();
    expect(await readFile(memoryPath), 'project MEMORY bytes are preserved').toEqual(memoryBefore);
  });
});

describe('project sync gate no-update phase entry (AC-003)', () => {
  it('AC-003: an already-current adoption stores a reference-free version 2 result that replays with zero requests', async () => {
    const root = await temporary('ai-workflow-gate-current-');
    const runtimeDirectory = await temporary('ai-workflow-gate-current-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptionPrerequisites(root);
    for (const [sourcePath, targetPath] of Object.entries(TARGETS)) {
      await writeFile(join(root, targetPath), sourceContent(sourcePath, COMMIT));
    }
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };

    const result = await runProjectGate(
      { host: 'claude', event: 'PhaseEntry', sessionId: 'current-session', cwd: root },
      options,
    ) as WithAuthorityRef;

    expect(result.decision).toBe('allow');
    expect(result.report?.status).toBe('synchronized');
    expect(result.authority_ref, 'a phase entry that updates no managed authority file must not expose a reference').toBeUndefined();
    expect(result.context, 'the context must carry no contract body').not.toContain('Fresh shared context at');
    expect(result.context.length, 'the context must stay below 1000 characters').toBeLessThan(1000);

    const storedText = await readFile(await singleRuntimeFile(runtimeDirectory), 'utf8');
    const stored = JSON.parse(storedText) as { version?: unknown; result?: Record<string, unknown> };
    expect(stored.version, 'the stored unit must be version 2').toBe(2);
    expect(stored.result, 'the stored unit must carry no reference').not.toHaveProperty('authority_ref');
    expect(storedText, 'the stored unit must contain no contract body').not.toContain('Fresh shared context at');

    const gitAfterPhase = fake.invocationCount();
    const cloneAfterPhase = fake.cloneCount();
    const replay = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'current-session', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      options,
    ) as WithAuthorityRef;
    expect(replay.decision).toBe('allow');
    expect(replay.report?.status).toBe('synchronized');
    expect(replay.report?.verified).toBe(true);
    expect(replay.report?.proceed).toBe(true);
    expect(replay.authority_ref, 'the replay must carry no reference').toBeUndefined();
    expect(replay.context.length, 'the replay context must stay below 1000 characters').toBeLessThan(1000);
    expect(fake.cloneCount(), 'the replay must not clone the source').toBe(cloneAfterPhase);
    expect(fake.invocationCount(), 'the replay must issue zero git invocations').toBe(gitAfterPhase);
  });
});

describe('project sync gate legacy version 1 unit invalidation (AC-009)', () => {
  it('AC-009: a version 1 unit with a full contract body is treated as no check and the next phase entry rewrites it as version 2', async () => {
    const root = await temporary('ai-workflow-gate-legacy-');
    const runtimeDirectory = await temporary('ai-workflow-gate-legacy-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };

    const primed = await runProjectGate(
      { host: 'claude', event: 'PhaseEntry', sessionId: 'prime', cwd: root },
      options,
    );
    expect(primed.report?.status).toBe('synchronized');

    // Hand-write a version 1 unit embedding the full contract body at the exact cache path.
    const cacheFile = await singleRuntimeFile(runtimeDirectory);
    const primedUnit = JSON.parse(await readFile(cacheFile, 'utf8')) as { result?: { report?: unknown } };
    const contract = await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8');
    const legacy = {
      version: 1,
      unit: 'hand-written-legacy',
      phase: true,
      result: {
        decision: 'allow',
        project: root,
        report: primedUnit.result?.report,
        context: `ai-workflow sync: synchronized\nProject: ${root}\n${contract}`,
        authority: contract,
      },
    };
    await writeFile(cacheFile, `${JSON.stringify(legacy)}\n`);
    const cloneAfterPrime = fake.cloneCount();
    const gitAfterPrime = fake.invocationCount();
    const runtimeBefore = await snapshotTree(runtimeDirectory);
    const rootBefore = await snapshotTree(root);

    const replay = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'after-legacy', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      options,
    ) as WithAuthorityRef;
    expect(replay.decision, 'a version 1 unit must not block or be trusted as a current check').toBe('allow');
    expect(replay.report, 'a version 1 unit must not be replayed as a check').toBeUndefined();
    expect(replay.authority_ref, 'a version 1 unit must not fabricate a reference').toBeUndefined();
    expect(replay.context, 'the no-check context must state that no check has run').toMatch(/no[\s\S]{0,80}(check|synchroni)/i);
    expect(fake.cloneCount(), 'a version 1 unit must not trigger a source clone').toBe(cloneAfterPrime);
    expect(fake.invocationCount(), 'a version 1 unit must not trigger a git invocation').toBe(gitAfterPrime);
    expect(changedPaths(runtimeBefore, await snapshotTree(runtimeDirectory)), 'a version 1 unit must not be rewritten').toEqual([]);
    expect(changedPaths(rootBefore, await snapshotTree(root)), 'a version 1 unit must not touch the project').toEqual([]);

    // A following phase entry rewrites the unit as version 2 with no contract body.
    const rewritten = await runProjectGate(
      { host: 'claude', event: 'PhaseEntry', sessionId: 'after-legacy-phase', cwd: root },
      options,
    ) as WithAuthorityRef;
    expect(rewritten.report?.status).toBe('synchronized');
    const rewrittenText = await readFile(cacheFile, 'utf8');
    const rewrittenUnit = JSON.parse(rewrittenText) as { version?: unknown };
    expect(rewrittenUnit.version, 'a following phase entry must rewrite the unit as version 2').toBe(2);
    expect(rewrittenText, 'the rewritten unit must contain no contract body').not.toContain('Fresh shared context at');
  });
});

describe('project sync gate clone timeout classification (AC-004/AC-005)', () => {
  it('AC-004: denies with a failed report naming the clone, fixed source, branch and kill, and stores one complete entry', async () => {
    const root = await temporary('ai-workflow-gate-timeout-');
    const runtimeDirectory = await temporary('ai-workflow-gate-timeout-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);

    const result = await runProjectGate(
      { host: 'opencode', event: 'PhaseEntry', sessionId: 'timeout-session', cwd: root },
      { runGit: timeoutCloneGit(), runtimeDirectory },
    );

    expect(result.decision, 'a killed clone must not continue the phase').toBe('deny');
    expect(result.report, 'the gate exposes the synchronization report').toBeDefined();
    expect(result.report!.status).toBe('failed');
    expect(result.report!.verified).toBe(false);
    expect(result.report!.proceed).toBe(false);

    // The denial stays actionable: it names the clone operation, the fixed source address,
    // the branch, and the timeout or killed process.
    expect(result.context).toMatch(/clone/i);
    expect(result.context).toContain('https://github.com/hengboy/ai-workflow.git');
    expect(result.context).toMatch(/branch\s+main/);
    expect(result.context).toMatch(/timed?\s*out/i);
    expect(result.context).toMatch(/killed|SIGTERM|SIGKILL/i);

    const reasons = [...result.report!.warnings, ...result.report!.conflicts].map((entry) => entry.reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((reason) => result.context.includes(reason)), 'the failure reason must be visible in the context').toBe(true);

    // The timeout decision is stored as exactly one complete, replayable cache entry.
    const stored = await parseRuntimeFile(await singleRuntimeFile(runtimeDirectory)) as {
      version?: unknown;
      phase?: unknown;
      result?: { decision?: unknown; report?: { status?: unknown } };
    };
    expect(stored.version, 'the stored unit must be version 2').toBe(2);
    expect(stored.phase).toBe(true);
    expect(stored.result?.decision).toBe('deny');
    expect(stored.result?.report?.status).toBe('failed');
  });

  it('AC-005: keeps a generic non-timeout clone failure as the warning continuation', async () => {
    const root = await temporary('ai-workflow-gate-generic-');
    const runtimeDirectory = await temporary('ai-workflow-gate-generic-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);

    const result = await runProjectGate(
      { host: 'codex', event: 'PhaseEntry', sessionId: 'generic-failure', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      { runGit: headFailureGit(), runtimeDirectory },
    );

    expect(result.decision, 'an ordinary source failure must still allow continuation').toBe('allow');
    expect(result.report, 'the gate exposes the synchronization report').toBeDefined();
    expect(result.report!.status).toBe('unverified');
    expect(result.report!.verified).toBe(false);
    expect(result.report!.proceed).toBe(true);

    const reasons = result.report!.warnings.map((entry) => entry.reason);
    expect(reasons).toContain('source unavailable: clone failed');
    expect(reasons.some((reason) => result.context.includes(reason)), 'the warning reason must stay visible').toBe(true);

    const stored = await parseRuntimeFile(await singleRuntimeFile(runtimeDirectory)) as { result?: { decision?: unknown; report?: { status?: unknown } } };
    expect(stored.result?.decision).toBe('allow');
    expect(stored.result?.report?.status).toBe('unverified');
  });
});

// Additive phase-entry execution notice. Every existing test above is left untouched. The
// fixture root is a valid adoption that also owns an unfinished execution run, and the fake
// sync source pattern keeps source acquisition fully injected and offline.
type GateWithExecution = ProjectGateResult & {
  execution?: {
    unfinished: Array<{ plan_id: string; plan_directory: string; run_id: string; status: string; lock: string; updated_at?: string }>;
    warnings: string[];
  };
};

const RECOVERY_PLAN_ID = '20261117-gate-unfinished';

/** A valid adopted root carrying one real unfinished run, created through the lifecycle manager. */
async function adoptedRootWithUnfinishedRun(root: string): Promise<string> {
  await writeAdoptedTarget(root, COMMIT);
  const planDirectory = await workspacePlanFixture(root, {
    planId: RECOVERY_PLAN_ID,
    requirements: ['REQ-001'],
    acceptanceCriteria: ['AC-001'],
    tasks: [],
    phases: [],
  });
  await startRun({ planDirectory });
  return planDirectory;
}

/** Turn the started run's lock into a same-host stale lock so staleness is nameable. */
async function makeRunLockStale(planDirectory: string): Promise<void> {
  const lockPath = executionPaths(planDirectory).lock;
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
  await writeFile(lockPath, `${JSON.stringify({ ...lock, pid: 2_000_000_000, host: hostname() }, null, 2)}\n`);
}

function syncOptions(runGit: TestGitRunner, runtimeDirectory: string): { runGit: TestGitRunner; runtimeDirectory: string } {
  return { runGit, runtimeDirectory };
}

describe('project sync gate phase-entry execution notice (REQ-010 / AC-017)', () => {
  it('AC-017: adds one read-only context line naming plan, run, status, lock staleness and the resume command, and stores it', async () => {
    const root = await temporary('ai-workflow-gate-exec-notice-');
    const runtimeDirectory = await temporary('ai-workflow-gate-exec-notice-runtime-');
    roots.push(root, runtimeDirectory);
    const planDirectory = await adoptedRootWithUnfinishedRun(root);
    await makeRunLockStale(planDirectory);
    const executionBefore = await snapshotTree(join(planDirectory, 'execution'));
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });

    const result = await runProjectGate(
      { host: 'claude', event: 'PhaseEntry', sessionId: 'notice-session', cwd: root },
      syncOptions(fake.runGit, runtimeDirectory),
    ) as GateWithExecution;

    expect(result.decision).toBe('allow');
    expect(result.report?.status).toBe('synchronized');
    expect(result.report?.verified).toBe(true);
    expect(result.execution, 'PhaseEntry adds the execution notice').toBeDefined();
    expect(result.execution!.unfinished).toHaveLength(1);
    expect(result.execution!.warnings).toEqual([]);
    const entry = result.execution!.unfinished[0]!;
    expect(entry.plan_id).toBe(RECOVERY_PLAN_ID);
    expect(entry.plan_directory).toBe(planDirectory);
    expect(typeof entry.run_id).toBe('string');
    expect(entry.run_id.length).toBeGreaterThan(0);
    expect(entry.status).toBe('RUNNING');
    expect(entry.lock).toBe('stale');

    const lines = result.context.split('\n').filter((line) => line.includes(RECOVERY_PLAN_ID));
    expect(lines, 'exactly one context line per unfinished run').toHaveLength(1);
    expect(lines[0]).toContain(entry.run_id);
    expect(lines[0]).toContain('RUNNING');
    expect(lines[0]).toMatch(/stale/i);
    expect(lines[0]).toContain(`ai-workflow execution resume --plan ${planDirectory}`);

    expect(changedPaths(executionBefore, await snapshotTree(join(planDirectory, 'execution'))), 'the gate writes no execution file').toEqual([]);
    const stored = await readStoredProjectGate({ host: 'claude', project: root, runtimeDirectory }) as GateWithExecution | undefined;
    expect(stored, 'the notice is part of the stored result').toEqual(result);
  });

  it('AC-017: later native events reuse the stored notice after run state changes or is deleted', async () => {
    const root = await temporary('ai-workflow-gate-exec-reuse-');
    const runtimeDirectory = await temporary('ai-workflow-gate-exec-reuse-runtime-');
    roots.push(root, runtimeDirectory);
    const planDirectory = await adoptedRootWithUnfinishedRun(root);
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = syncOptions(fake.runGit, runtimeDirectory);

    const stored = await runProjectGate(
      { host: 'claude', event: 'PhaseEntry', sessionId: 'reuse-session', cwd: root },
      options,
    ) as GateWithExecution;
    expect(stored.execution?.unfinished).toHaveLength(1);
    const cloneAfterPhase = fake.cloneCount();
    const gitAfterPhase = fake.invocationCount();

    // Change the authoritative-looking run status, then remove the run entirely. Neither may
    // alter a later native event's cached notice or trigger a rescan.
    const runPath = executionPaths(planDirectory).run;
    const run = JSON.parse(await readFile(runPath, 'utf8')) as Record<string, unknown>;
    await writeFile(runPath, `${JSON.stringify({ ...run, status: 'COMPLETED' }, null, 2)}\n`);
    const changed = await runProjectGate(
      { host: 'claude', event: 'SessionStart', sessionId: 'reuse-session', cwd: root },
      options,
    ) as GateWithExecution;
    expect(changed.execution).toEqual(stored.execution);
    expect(changed.context).toBe(stored.context);

    await rm(runPath);
    for (const event of ['UserPromptSubmit', 'PreToolUse'] as const) {
      const replay = await runProjectGate(
        { host: 'claude', event, sessionId: 'other-session', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
        options,
      ) as GateWithExecution;
      expect(replay, `${event} must replay the stored result verbatim`).toEqual(stored);
      expect(replay.execution).toEqual(stored.execution);
    }
    expect(fake.cloneCount(), 'native events never rescan the source').toBe(cloneAfterPhase);
    expect(fake.invocationCount(), 'native events issue no git invocations').toBe(gitAfterPhase);
  });

  it('AC-017: a native event without a phase entry has no execution field', async () => {
    const root = await temporary('ai-workflow-gate-exec-nophase-');
    const runtimeDirectory = await temporary('ai-workflow-gate-exec-nophase-runtime-');
    roots.push(root, runtimeDirectory);
    await adoptedRootWithUnfinishedRun(root);
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });

    const result = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'no-phase', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      syncOptions(fake.runGit, runtimeDirectory),
    ) as GateWithExecution;

    expect(result.decision).toBe('allow');
    expect(result.report).toBeUndefined();
    expect(result.execution, 'no PhaseEntry means no execution notice').toBeUndefined();
  });

  it('AC-017: a corrupt run file yields a warning without failing the gate or changing the sync report', async () => {
    const root = await temporary('ai-workflow-gate-exec-corrupt-');
    const runtimeDirectory = await temporary('ai-workflow-gate-exec-corrupt-runtime-');
    roots.push(root, runtimeDirectory);
    const planDirectory = await adoptedRootWithUnfinishedRun(root);
    await writeFile(executionPaths(planDirectory).run, '{ not valid json\n');
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });

    const result = await runProjectGate(
      { host: 'codex', event: 'PhaseEntry', sessionId: 'corrupt-run', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      syncOptions(fake.runGit, runtimeDirectory),
    ) as GateWithExecution;

    expect(result.decision, 'a corrupt run never fails the gate').toBe('allow');
    expect(result.report?.status).toBe('synchronized');
    expect(result.report?.verified).toBe(true);
    expect(result.report?.proceed).toBe(true);
    expect(result.execution).toBeDefined();
    expect(result.execution!.unfinished).toEqual([]);
    expect(result.execution!.warnings.length).toBeGreaterThan(0);
    expect(result.execution!.warnings.some((warning) => warning.includes(RECOVERY_PLAN_ID)), 'the warning names the corrupt plan').toBe(true);
  });
});

// Antigravity names the read tool `read_file` with a `Path` argument and the shell tool
// `run_command` with a `CommandLine` argument. Its stored conflict deny must stay in force
// while only the exact contract read and sync actor commands are exempted.
describe('project sync gate Antigravity workspace containment', () => {
  it('denies a pending managed-file maintenance commit outside every mounted workspace and names the /add-dir recovery', async () => {
    const root = await temporary('ai-workflow-gate-antigravity-workspace-');
    const runtimeDirectory = await temporary('ai-workflow-gate-antigravity-workspace-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };

    const primed = await runProjectGate(
      { host: 'antigravity', event: 'PhaseEntry', sessionId: 'antigravity-workspace-session', cwd: root },
      options,
    );
    expect(primed.decision).toBe('allow');
    expect(primed.report?.updated).toContain('.ai-workflow/AGENTS.md');
    const invocationsAfterPrime = fake.invocationCount();

    const preInvocation = await runProjectGate(
      { host: 'antigravity', event: 'PreInvocation', sessionId: 'antigravity-workspace-session', cwd: workspace, workspacePaths: [workspace] },
      options,
    );
    expect(preInvocation.decision, 'a pending maintenance commit outside the workspace must deny').toBe('deny');
    expect(preInvocation.context).toContain('outside the Antigravity workspace');
    expect(preInvocation.context).toContain(`/add-dir ${root}`);
    expect(preInvocation.report, 'the workspace denial is not a synchronization report').toBeUndefined();

    // The synchronization actor itself must still be allowed so the next phase entry can
    // refresh the stored result instead of deadlocking behind the workspace guard.
    const syncActor = await runProjectGate(
      {
        host: 'antigravity',
        event: 'PreToolUse',
        sessionId: 'antigravity-workspace-session',
        cwd: workspace,
        workspacePaths: [workspace],
        toolName: 'run_command',
        toolInput: { CommandLine: `ai-workflow sync-hook --host antigravity --phase --project ${root}` },
      },
      options,
    );
    expect(syncActor.decision, 'the exact sync actor must remain allowed').toBe('allow');
    expect(syncActor.exemption).toBe('sync_actor');

    // The exact contract read is normally an authority_read exemption; the workspace mismatch
    // must deny it instead of letting the host wait for an approval that times out.
    const contractRead = await runProjectGate(
      {
        host: 'antigravity',
        event: 'PreToolUse',
        sessionId: 'antigravity-workspace-session',
        cwd: workspace,
        workspacePaths: [workspace],
        toolName: 'read_file',
        toolInput: { Path: join(root, '.ai-workflow/AGENTS.md') },
      },
      options,
    );
    expect(contractRead.decision).toBe('deny');
    expect(contractRead.exemption).toBeUndefined();
    expect(contractRead.context).toContain(`/add-dir ${root}`);

    // Mounting the actual root is the documented recovery; the stored result replays unchanged.
    const mountedRoot = await runProjectGate(
      { host: 'antigravity', event: 'PreInvocation', sessionId: 'antigravity-workspace-session', cwd: workspace, workspacePaths: [root] },
      options,
    );
    expect(mountedRoot.decision).toBe('allow');
    expect(mountedRoot.report?.updated).toContain('.ai-workflow/AGENTS.md');

    expect(fake.invocationCount(), 'the workspace guard issues no source request').toBe(invocationsAfterPrime);
  });

  it('denies any Antigravity operation outside mounted workspaces even without pending managed-file commits', async () => {
    const root = await temporary('ai-workflow-gate-antigravity-any-workspace-');
    const runtimeDirectory = await temporary('ai-workflow-gate-antigravity-any-workspace-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const otherWorkspace = await temporary('ai-workflow-gate-antigravity-other-workspace-');
    roots.push(otherWorkspace);
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };

    const deniedRead = await runProjectGate(
      {
        host: 'antigravity',
        event: 'PreToolUse',
        sessionId: 'antigravity-cross-workspace',
        cwd: otherWorkspace,
        workspacePaths: [otherWorkspace],
        toolName: 'read_file',
        toolInput: { Path: join(root, '.ai-workflow/AGENTS.md') },
      },
      options,
    );
    expect(deniedRead.decision).toBe('deny');
    expect(deniedRead.exemption).toBeUndefined();
    expect(deniedRead.context).toContain('outside the Antigravity workspace');
    expect(deniedRead.context).toContain(`/add-dir ${root}`);

    const rootSubdir = join(root, 'workspace');
    await mkdir(rootSubdir, { recursive: true });
    const syncActor = await runProjectGate(
      {
        host: 'antigravity',
        event: 'PreToolUse',
        sessionId: 'antigravity-cross-workspace',
        cwd: rootSubdir,
        workspacePaths: [rootSubdir],
        toolName: 'run_command',
        toolInput: { CommandLine: `ai-workflow sync-hook --host antigravity --phase --project ${root}` },
      },
      options,
    );
    expect(syncActor.decision).toBe('allow');
    expect(syncActor.exemption).toBe('sync_actor');

    const allowedOnceMounted = await runProjectGate(
      {
        host: 'antigravity',
        event: 'PreToolUse',
        sessionId: 'antigravity-cross-workspace',
        cwd: otherWorkspace,
        workspacePaths: [otherWorkspace, root],
        toolName: 'read_file',
        toolInput: { Path: join(root, '.ai-workflow/AGENTS.md') },
      },
      options,
    );
    expect(allowedOnceMounted.decision).toBe('allow');
  });
});

describe('project sync gate Antigravity tool exemptions (AC-008)', () => {
  it('AC-008: grants authority_read and sync_actor exemptions under a stored antigravity conflict without clearing the deny', async () => {
    const root = await temporary('ai-workflow-gate-antigravity-exempt-');
    const runtimeDirectory = await temporary('ai-workflow-gate-antigravity-exempt-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT, { '.ai-workflow/AGENTS.md': LEGACY_MARKER_AGENTS });
    const fake = fakeGit({ commit: COMMIT, files: sourceFiles(COMMIT) });
    const options = { runGit: fake.runGit, runtimeDirectory };
    const invoke = (toolName: string, toolInput: unknown): Promise<ProjectGateResult> =>
      runProjectGate(
        { host: 'antigravity', event: 'PreToolUse', sessionId: 'antigravity-exempt-session', cwd: root, toolName, toolInput },
        options,
      );

    const contractPath = join(root, '.ai-workflow/AGENTS.md');
    const before = await snapshotTree(root);

    // A phase entry stores the true conflict and denies ordinary tools for the antigravity host.
    const primed = await runProjectGate(
      { host: 'antigravity', event: 'PhaseEntry', sessionId: 'antigravity-exempt-session', cwd: root },
      options,
    );
    expect(primed.decision).toBe('deny');
    expect(primed.report?.status).toBe('conflict');
    const gitAfterPrime = fake.invocationCount();
    const cloneAfterPrime = fake.cloneCount();
    const runtimeAfterPrime = await snapshotTree(runtimeDirectory);

    // The exact contract read is an authority_read exemption.
    const authorityRead = await invoke('read_file', { Path: contractPath });
    expect(authorityRead.decision, 'the exact contract read must be exempted').toBe('allow');
    expect(authorityRead.exemption, 'the contract read carries the authority_read exemption').toBe('authority_read');

    // Both exact sync actor commands are sync_actor exemptions.
    for (const command of [
      `ai-workflow sync ${root}`,
      `ai-workflow sync-hook --host antigravity --phase --project ${root}`,
    ]) {
      const actor = await invoke('run_command', { CommandLine: command });
      expect(actor.decision, `actor: ${command}`).toBe('allow');
      expect(actor.exemption, `actor exemption: ${command}`).toBe('sync_actor');
    }

    // Exemptions never clear the cached conflict: an ordinary command and an unrelated read stay denied.
    const ordinaryCommand = await invoke('run_command', { CommandLine: `ls ${root}` });
    expect(ordinaryCommand.decision, 'an ordinary run_command must stay denied').toBe('deny');
    expect(ordinaryCommand.exemption, 'an ordinary run_command has no exemption').toBeUndefined();
    const unrelatedRead = await invoke('read_file', { Path: join(root, 'MEMORY.md') });
    expect(unrelatedRead.decision, 'an unrelated read_file must stay denied').toBe('deny');

    // Lookalikes stay denied under the stored conflict.
    const echoLookalike = await invoke('run_command', { CommandLine: `echo ai-workflow sync ${root}` });
    expect(echoLookalike.decision, 'an echo lookalike is not the sync actor').toBe('deny');
    const backupLookalike = await invoke('read_file', { Path: `${contractPath}.bak` });
    expect(backupLookalike.decision, 'an AGENTS.md.bak read is not the exact contract').toBe('deny');

    // Exemptions and replays issue no source request, do not rewrite the stored deny and do not touch the project.
    expect(fake.cloneCount(), 'exemptions must not clone the source').toBe(cloneAfterPrime);
    expect(fake.invocationCount(), 'exemptions must issue zero git invocations').toBe(gitAfterPrime);
    expect(changedPaths(runtimeAfterPrime, await snapshotTree(runtimeDirectory)), 'the stored deny must stay unchanged').toEqual([]);
    expect(changedPaths(before, await snapshotTree(root)), 'permitting a tool must not write the project').toEqual([]);
  });
});
