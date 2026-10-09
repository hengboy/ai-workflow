import { afterEach, describe, expect, it } from 'vitest';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runProjectGate, type ProjectGateInput, type ProjectGateResult } from '../../src/sync/gate.js';
import type { SyncStatus } from '../../src/sync/index.js';
import { changedPaths, snapshotTree, temporary } from '../helpers.js';
import { exists } from '../../src/utils/fs.js';

const REPOSITORY = 'hengboy/ai-workflow';
const BRANCH = 'simplify';
const COMMIT = 'a'.repeat(40);
const HEAD_PATH = `/repos/${REPOSITORY}/branches/${BRANCH}`;
const CONTENTS_PREFIX = `/repos/${REPOSITORY}/contents/`;

/** The complete supported project-template source set fixed by the specification table. */
const SOURCE_PATHS = [
  'templates/project/AGENTS.md',
  'templates/project/MEMORY.md',
  'templates/project/navigation.json',
  'templates/project/navigation.md',
  'templates/project/notes/AGENTS.md',
  'templates/project/notes/README.md',
  'templates/project/notes/implemented/AGENTS.md',
  'templates/project/notes/archived/AGENTS.md',
  'templates/project/notes/archived/manifest.json',
] as const;

const FILE_PATHS = new Set<string>(SOURCE_PATHS);

/** The six mergeable Markdown templates that carry ownership markers in this fixture. */
const MERGEABLE_MARKDOWN = new Set<string>([
  'templates/project/AGENTS.md',
  'templates/project/MEMORY.md',
  'templates/project/notes/AGENTS.md',
  'templates/project/notes/README.md',
  'templates/project/notes/implemented/AGENTS.md',
  'templates/project/notes/archived/AGENTS.md',
]);

/** The full source-to-target mapping the synchronizer owns. */
const TARGETS: Record<string, string> = {
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

// The complete notes management structure, listed literally so the fixture stays
// independent of the production directory helper.
const NOTE_LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived'] as const;
const NOTE_CLASSES = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing'] as const;
const NOTES_DIRECTORIES = [
  '.ai-workflow/notes',
  ...NOTE_LIFECYCLES.flatMap((lifecycle) => [`.ai-workflow/notes/${lifecycle}`, ...NOTE_CLASSES.map((noteClass) => `.ai-workflow/notes/${lifecycle}/${noteClass}`)]),
];

const SUPPORTED_DIRECTORIES: Record<string, readonly string[]> = {
  'templates/project': ['AGENTS.md', 'MEMORY.md', 'navigation.json', 'navigation.md', 'notes'],
  'templates/project/notes': ['AGENTS.md', 'README.md', 'implemented', 'archived'],
  'templates/project/notes/implemented': ['AGENTS.md'],
  'templates/project/notes/archived': ['AGENTS.md', 'manifest.json'],
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function upstreamSectionId(repoPath: string): string {
  return repoPath.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function marked(id: string, body: string): string {
  return `<!-- ai-workflow:section ${id}:begin -->\n${body}\n<!-- ai-workflow:section ${id}:end -->\n`;
}

function blobSha(ref: string, repoPath: string): string {
  return Buffer.from(`${ref}:${repoPath}`).toString('hex').slice(0, 40);
}

/** One native contents-API directory entry, pinned to the requested immutable `ref`. */
function contentsEntry(ref: string, repoPath: string, name: string): Record<string, unknown> {
  const childPath = `${repoPath}/${name}`;
  const sha = blobSha(ref, childPath);
  const isDirectory = childPath in SUPPORTED_DIRECTORIES;
  return {
    type: isDirectory ? 'dir' : 'file',
    name,
    path: childPath,
    sha,
    ...(isDirectory ? {} : { size: 128 }),
    url: `https://api.github.com/repos/${REPOSITORY}/contents/${childPath}?ref=${ref}`,
    git_url: `https://api.github.com/repos/${REPOSITORY}/git/blobs/${sha}`,
    html_url: `https://github.com/${REPOSITORY}/blob/${ref}/${childPath}`,
    download_url: isDirectory ? null : `https://raw.githubusercontent.com/${REPOSITORY}/${ref}/${childPath}`,
  };
}

/** One native contents-API file response with base64 content pinned to `ref`. */
function contentsFile(ref: string, repoPath: string, content: string): Response {
  const sha = blobSha(ref, repoPath);
  return jsonResponse({
    type: 'file',
    name: repoPath.split('/').pop(),
    path: repoPath,
    sha,
    size: Buffer.byteLength(content),
    url: `https://api.github.com/repos/${REPOSITORY}/contents/${repoPath}?ref=${ref}`,
    git_url: `https://api.github.com/repos/${REPOSITORY}/git/blobs/${sha}`,
    html_url: `https://github.com/${REPOSITORY}/blob/${ref}/${repoPath}`,
    download_url: `https://raw.githubusercontent.com/${REPOSITORY}/${ref}/${repoPath}`,
    encoding: 'base64',
    content: Buffer.from(content).toString('base64'),
  });
}

/**
 * Independent expected upstream content for the fixture's immutable ref: the six
 * mergeable Markdown templates carry a valid owned section, navigation is unmarked
 * but valid, and the JSON data stays structurally valid.
 */
function upstreamFileContents(ref: string, repoPath: string): string {
  if (repoPath.endsWith('manifest.json')) return '{\n  "version": 1,\n  "files": {}\n}\n';
  if (repoPath.endsWith('json')) return `${JSON.stringify({ version: 1, ref }, null, 2)}\n`;
  const id = upstreamSectionId(repoPath);
  return `# ${repoPath}\n<!-- ai-workflow:section ${id}:begin -->\nimmutable ${ref}\n<!-- ai-workflow:section ${id}:end -->\n`;
}

/** The full valid source set at one commit. */
function sourceFiles(commit: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of SOURCE_PATHS) files[path] = upstreamFileContents(commit, path);
  return files;
}

/**
 * Adopted target content: the six mergeable Markdown templates keep the same valid
 * ownership markers but an older body, so a successful synchronization is a safe
 * patch; navigation and the archive manifest already match the source.
 */
function targetFileContents(commit: string, sourcePath: string): string {
  if (!MERGEABLE_MARKDOWN.has(sourcePath)) return upstreamFileContents(commit, sourcePath);
  return `# ${sourcePath}\n<!-- ai-workflow:section ${upstreamSectionId(sourcePath)}:begin -->\nold ${upstreamSectionId(sourcePath)} body\n<!-- ai-workflow:section ${upstreamSectionId(sourcePath)}:end -->\n`;
}

/** A native fixture listing the mandatory set and serving each member at one HEAD. */
function fixedHeadFetch(commit: string, files: Record<string, string>): typeof fetch {
  return async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const parsed = new URL(requestUrl(input));
    if (parsed.pathname === HEAD_PATH) return jsonResponse({ name: BRANCH, commit: { sha: commit } });
    if (parsed.pathname.startsWith(CONTENTS_PREFIX)) {
      const repoPath = decodeURIComponent(parsed.pathname.slice(CONTENTS_PREFIX.length));
      const ref = parsed.searchParams.get('ref') ?? commit;
      const listing = SUPPORTED_DIRECTORIES[repoPath];
      if (listing) return jsonResponse(listing.map((name) => contentsEntry(ref, repoPath, name)));
      const content = files[repoPath];
      if (content !== undefined) return contentsFile(ref, repoPath, content);
    }
    return jsonResponse({ message: 'Not Found' }, 404);
  };
}

/** A branch endpoint that fails before any commit is known (status/rate-limit/network). */
function headFailureFetch(status: number): typeof fetch {
  return async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    if (new URL(requestUrl(input)).pathname === HEAD_PATH) return jsonResponse({ message: 'source unavailable' }, status);
    return jsonResponse({ message: 'unexpected request' }, 500);
  };
}

interface ScriptedSourceState {
  /** The HEAD the branch endpoint currently advertises; the test advances it between triggers. */
  head: string;
  /** How many branch/HEAD requests the gate actually issued externally. */
  branchCalls: number;
  /** Every external HTTP request, to prove a cache hit performs no retrieval at all. */
  httpCalls: number;
}

/**
 * A native fixture whose HEAD the test advances between triggers. Every contents request
 * is served at the requested immutable ref with stable headings plus that ref's SHA, so a
 * unit that reuses an earlier snapshot is distinguishable from one that re-queries HEAD.
 */
function scriptedHeadFetch(state: ScriptedSourceState): typeof fetch {
  return async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    state.httpCalls += 1;
    const parsed = new URL(requestUrl(input));
    if (parsed.pathname === HEAD_PATH) {
      state.branchCalls += 1;
      return jsonResponse({ name: BRANCH, commit: { sha: state.head } });
    }
    if (parsed.pathname.startsWith(CONTENTS_PREFIX)) {
      const repoPath = decodeURIComponent(parsed.pathname.slice(CONTENTS_PREFIX.length));
      const ref = parsed.searchParams.get('ref') ?? state.head;
      const listing = SUPPORTED_DIRECTORIES[repoPath];
      if (listing) return jsonResponse(listing.map((name) => contentsEntry(ref, repoPath, name)));
      if (FILE_PATHS.has(repoPath)) return contentsFile(ref, repoPath, upstreamFileContents(ref, repoPath));
    }
    return jsonResponse({ message: 'Not Found' }, 404);
  };
}

/** A minimal valid adoption: every managed target present with an older marked body. */
async function writeAdoptedTarget(root: string, commit: string, overrides: Record<string, string> = {}): Promise<void> {
  for (const directory of NOTES_DIRECTORIES) await mkdir(join(root, directory), { recursive: true });
  for (const [sourcePath, targetPath] of Object.entries(TARGETS)) {
    const contents = overrides[targetPath] ?? targetFileContents(commit, sourcePath);
    const target = join(root, targetPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  // Already-complete ignore entries, so ignore reconciliation is a no-op.
  await writeFile(join(root, '.gitignore'), '.ai-workflow/plans/\n.worktrees/\n');
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

// A differing unmarked same-heading legacy rule: the source MEMORY.md owns a
// `## Standards` section, while the target keeps an unmarked `## Standards` body that
// differs. The merge preserves the target bytes and records a needs_attention warning,
// so a safe contract update can coexist with unresolved attention.
const DIFFERING_LEGACY_MEMORY = '# Project memory\n\n## Standards\nProject-specific standard body.\n';
const DIFFERING_LEGACY_SOURCE_MEMORY = `# Memory template\n${marked('standards', '## Standards\nFresh standard body.')}`;
const MALFORMED_AGENTS = '# Contract\n\n<!-- ai-workflow:section broken:begin -->\nnever closed\n';

interface SeverityCase {
  name: string;
  host: 'claude' | 'codex' | 'opencode';
  /** Write the adopted target and return the injectable source fixture. */
  setup: (root: string, commit: string) => Promise<typeof fetch>;
  expected: {
    decision: 'allow' | 'deny';
    status: SyncStatus;
    verified: boolean;
    proceed: boolean;
    /** The current on-disk contract must be exposed for re-read when this run safely changed it. */
    authority: boolean;
    /** Only the synchronized case proves an actual patch reached the contract. */
    updatedContains?: string[];
  };
  readOnlyProjectRoot?: boolean;
}

// Every case now runs through the one automatic trigger, `PhaseEntry`; its report mapping
// is preserved as a regression guard while the trigger cadence changes.
const severityCases: SeverityCase[] = [
  {
    name: 'a phase entry on a marked project with a safe update allows and exposes the fresh contract authority',
    host: 'claude',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit);
      return fixedHeadFetch(commit, sourceFiles(commit));
    },
    expected: { decision: 'allow', status: 'synchronized', verified: true, proceed: true, authority: true, updatedContains: ['.ai-workflow/AGENTS.md'] },
  },
  {
    name: 'a failed source branch allows warning continuation instead of a host denial',
    host: 'codex',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit);
      return headFailureFetch(403);
    },
    expected: { decision: 'allow', status: 'unverified', verified: false, proceed: true, authority: false },
  },
  {
    name: 'a safe contract update with unresolved differing legacy content still exposes the fresh contract authority',
    host: 'opencode',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit, { 'MEMORY.md': DIFFERING_LEGACY_MEMORY });
      return fixedHeadFetch(commit, { ...sourceFiles(commit), 'templates/project/MEMORY.md': DIFFERING_LEGACY_SOURCE_MEMORY });
    },
    expected: { decision: 'allow', status: 'needs_attention', verified: false, proceed: true, authority: true, updatedContains: ['.ai-workflow/AGENTS.md'] },
  },
  {
    name: 'a malformed target marker denies with a visible reason',
    host: 'claude',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit, { '.ai-workflow/AGENTS.md': MALFORMED_AGENTS });
      return fixedHeadFetch(commit, sourceFiles(commit));
    },
    expected: { decision: 'deny', status: 'conflict', verified: false, proceed: false, authority: false },
  },
  {
    name: 'an ordinary filesystem failure denies with a visible reason',
    host: 'codex',
    readOnlyProjectRoot: true,
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit);
      return fixedHeadFetch(commit, sourceFiles(commit));
    },
    expected: { decision: 'deny', status: 'failed', verified: false, proceed: false, authority: false },
  },
];

describe('project sync gate phase-entry report mapping (AC-001/AC-003)', () => {
  it.each(severityCases)('AC-001/AC-003: $name', async (testCase) => {
    const root = await temporary('ai-workflow-gate-');
    const runtimeDirectory = await temporary('ai-workflow-gate-runtime-');
    roots.push(root, runtimeDirectory);
    const http = await testCase.setup(root, COMMIT);

    let result: ProjectGateResult | undefined;
    let thrown: unknown;
    if (testCase.readOnlyProjectRoot) await chmod(root, 0o555);
    try {
      if (testCase.readOnlyProjectRoot) {
        const writable = await access(root, constants.W_OK).then(() => true, () => false);
        if (writable) throw new Error('This environment cannot enforce a read-only project root (likely running as root); the filesystem-failure gate case requires an unprivileged process.');
      }
      result = await runProjectGate(
        { host: testCase.host, event: 'PhaseEntry', sessionId: 'session-1', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
        { fetch: http, env: {}, runtimeDirectory },
      );
    } catch (error) {
      thrown = error;
    } finally {
      if (testCase.readOnlyProjectRoot) await chmod(root, 0o755);
    }
    if (thrown instanceof Error && /cannot enforce a read-only project root/.test(thrown.message)) throw thrown;

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

    // `authority` is the current on-disk contract to reload, not an upstream freshness
    // claim. Any invocation that safely published a contract change must expose it,
    // including a needs_attention result where a safe patch landed. Results with no safe
    // contract update (source unverified with zero writes, conflict, failed) are not
    // required to expose it and are intentionally left unasserted here.
    if (testCase.expected.authority) {
      const contract = await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8');
      expect(gate.authority, 'the current contract must be exposed for re-read').toBe(contract);
      expect(gate.authority).toContain(`immutable ${COMMIT}`);
    }

    // AC-001: a phase entry stores exactly one complete, parsable root-keyed cache entry.
    const cacheFile = await singleRuntimeFile(runtimeDirectory);
    expect(await parseRuntimeFile(cacheFile), 'the stored cache entry must be a complete JSON object').toBeTruthy();
  });
});

describe('project sync gate native event cache reuse (AC-002/AC-003)', () => {
  it('AC-002/AC-003: replays the stored phase result verbatim across native events with zero source requests', async () => {
    const root = await temporary('ai-workflow-gate-replay-');
    const runtimeDirectory = await temporary('ai-workflow-gate-replay-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const state: ScriptedSourceState = { head: 'a'.repeat(40), branchCalls: 0, httpCalls: 0 };
    const http = scriptedHeadFetch(state);
    const options = { fetch: http, env: {}, runtimeDirectory };
    const invoke = (input: Omit<ProjectGateInput, 'host'>): Promise<ProjectGateResult> =>
      runProjectGate({ host: 'claude', toolName: 'Bash', toolInput: { command: 'ls' }, ...input }, options);

    const stored = await invoke({ event: 'PhaseEntry', sessionId: 'session-1', cwd: root });
    expect(stored.decision).toBe('allow');
    expect(stored.report?.source.commit).toBe(state.head);
    expect(stored.authority, 'a safe contract update must store the authority payload').toBeDefined();
    const branchAfterPhase = state.branchCalls;
    const httpAfterPhase = state.httpCalls;
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
      expect(replay.report?.source.commit, native.event).toBe(state.head);
    }

    expect(state.branchCalls, 'native events must never query HEAD').toBe(branchAfterPhase);
    expect(state.httpCalls, 'native events must issue zero source requests').toBe(httpAfterPhase);
    expect(changedPaths(runtimeAfterPhase, await snapshotTree(runtimeDirectory)), 'native events must not rewrite the stored entry').toEqual([]);
    expect(changedPaths(rootAfterPhase, await snapshotTree(root)), 'native events must not touch the project tree').toEqual([]);
  });

  it('AC-003: replays a stored deny to native events without clearing it or querying the source', async () => {
    const root = await temporary('ai-workflow-gate-deny-');
    const runtimeDirectory = await temporary('ai-workflow-gate-deny-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT, { '.ai-workflow/AGENTS.md': MALFORMED_AGENTS });
    const state: ScriptedSourceState = { head: COMMIT, branchCalls: 0, httpCalls: 0 };
    const http = scriptedHeadFetch(state);
    const options = { fetch: http, env: {}, runtimeDirectory };

    const stored = await runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'deny-session', cwd: root }, options);
    expect(stored.decision).toBe('deny');
    expect(stored.report?.status).toBe('conflict');
    const branchAfterPhase = state.branchCalls;
    const httpAfterPhase = state.httpCalls;

    const toolReplay = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'other-session', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      options,
    );
    expect(toolReplay, 'an ordinary tool call must be blocked by the stored deny').toEqual(stored);
    expect(toolReplay.decision).toBe('deny');

    const turnReplay = await runProjectGate({ host: 'claude', event: 'UserPromptSubmit', sessionId: 'other-session', cwd: root }, options);
    expect(turnReplay, 'a user turn must replay the stored deny').toEqual(stored);

    expect(state.branchCalls, 'replaying a stored deny must not query HEAD').toBe(branchAfterPhase);
    expect(state.httpCalls, 'replaying a stored deny must issue zero source requests').toBe(httpAfterPhase);
  });
});

describe('project sync gate no stored result (AC-004)', () => {
  function expectNoCheck(result: ProjectGateResult): void {
    expect(result.decision).toBe('allow');
    expect(result.report, 'a missing check must not fabricate a report').toBeUndefined();
    expect(result.authority, 'a missing check must not fabricate authority').toBeUndefined();
    expect(result.context.length).toBeGreaterThan(0);
    expect(result.context, 'the no-check context must state that no check has run').toMatch(/no[\s\S]{0,80}(check|synchroni)/i);
  }

  it('AC-004: allows an adopted native event without a report, any source request or any write', async () => {
    const root = await temporary('ai-workflow-gate-nocheck-');
    const runtimeDirectory = await temporary('ai-workflow-gate-nocheck-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const state: ScriptedSourceState = { head: COMMIT, branchCalls: 0, httpCalls: 0 };
    const http = scriptedHeadFetch(state);
    const runtimeBefore = await snapshotTree(runtimeDirectory);
    const rootBefore = await snapshotTree(root);

    const result = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'no-check', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      { fetch: http, env: {}, runtimeDirectory },
    );

    expectNoCheck(result);
    expect(state.branchCalls, 'a no-check native event must not query HEAD').toBe(0);
    expect(state.httpCalls, 'a no-check native event must issue zero source requests').toBe(0);
    expect(changedPaths(runtimeBefore, await snapshotTree(runtimeDirectory)), 'a no-check native event must write no runtime entry').toEqual([]);
    expect(changedPaths(rootBefore, await snapshotTree(root)), 'a no-check native event must not touch the project').toEqual([]);
  });

  it('AC-004: treats a corrupt or truncated cache entry as no check without any source request', async () => {
    for (const mode of ['invalid-json', 'truncated'] as const) {
      const root = await temporary('ai-workflow-gate-corrupt-');
      const runtimeDirectory = await temporary('ai-workflow-gate-corrupt-runtime-');
      roots.push(root, runtimeDirectory);
      await writeAdoptedTarget(root, COMMIT);
      const state: ScriptedSourceState = { head: COMMIT, branchCalls: 0, httpCalls: 0 };
      const http = scriptedHeadFetch(state);
      const options = { fetch: http, env: {}, runtimeDirectory };

      const primed = await runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'prime', cwd: root }, options);
      expect(primed.report?.status).toBe('synchronized');
      const cacheFile = await singleRuntimeFile(runtimeDirectory);
      if (mode === 'invalid-json') {
        await writeFile(cacheFile, '{ this is not valid json');
      } else {
        const valid = await readFile(cacheFile, 'utf8');
        await writeFile(cacheFile, valid.slice(0, Math.max(1, Math.floor(valid.length / 2))));
      }
      const branchAfterPrime = state.branchCalls;
      const httpAfterPrime = state.httpCalls;
      const runtimeBefore = await snapshotTree(runtimeDirectory);

      const result = await runProjectGate(
        { host: 'claude', event: 'PreToolUse', sessionId: 'after-corrupt', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
        options,
      );
      expectNoCheck(result);
      expect(state.branchCalls, `${mode}: a corrupt cache must not trigger HEAD`).toBe(branchAfterPrime);
      expect(state.httpCalls, `${mode}: a corrupt cache must not trigger a source request`).toBe(httpAfterPrime);
      expect(changedPaths(runtimeBefore, await snapshotTree(runtimeDirectory)), `${mode}: a corrupt cache must not be rewritten`).toEqual([]);
    }
  });

  it('AC-004: treats an unreadable cache entry as no check without any source request', async () => {
    const root = await temporary('ai-workflow-gate-unreadable-');
    const runtimeDirectory = await temporary('ai-workflow-gate-unreadable-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT);
    const state: ScriptedSourceState = { head: COMMIT, branchCalls: 0, httpCalls: 0 };
    const http = scriptedHeadFetch(state);
    const options = { fetch: http, env: {}, runtimeDirectory };

    const primed = await runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'prime', cwd: root }, options);
    expect(primed.report?.status).toBe('synchronized');

    // Force a read error at the exact cache path the gate wrote, by occupying it with a directory.
    const cacheFile = await singleRuntimeFile(runtimeDirectory);
    await rm(cacheFile, { force: true });
    await mkdir(cacheFile);
    const branchAfterPrime = state.branchCalls;
    const httpAfterPrime = state.httpCalls;
    const runtimeBefore = await snapshotTree(runtimeDirectory);

    const result = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'after-unreadable', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      options,
    );
    expectNoCheck(result);
    expect(state.branchCalls, 'an unreadable cache must not trigger HEAD').toBe(branchAfterPrime);
    expect(state.httpCalls, 'an unreadable cache must not trigger a source request').toBe(httpAfterPrime);
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
      const state: ScriptedSourceState = { head: COMMIT, branchCalls: 0, httpCalls: 0 };
      const http = scriptedHeadFetch(state);
      const runtimeBefore = await snapshotTree(runtimeDirectory);
      const rootBefore = await snapshotTree(root);

      const gate = await runProjectGate({ host: 'codex', cwd: root, ...event }, { fetch: http, env: {}, runtimeDirectory });

      expect(gate.decision, event.event).toBe('skip');
      expect(gate.authority, event.event).toBeUndefined();
      expect(gate.report, `${event.event}: a skip must not fabricate a report`).toBeUndefined();
      expect(state.branchCalls, `${event.event}: an unadopted project must not query HEAD`).toBe(0);
      expect(state.httpCalls, `${event.event}: an unadopted project must issue zero source requests`).toBe(0);
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

    const state: ScriptedSourceState = { head: 'a'.repeat(40), branchCalls: 0, httpCalls: 0 };
    const http = scriptedHeadFetch(state);
    const options = { fetch: http, env: {}, runtimeDirectory };
    const invoke = (input: Omit<ProjectGateInput, 'host'>): Promise<ProjectGateResult> =>
      runProjectGate({ host: 'claude', toolName: 'Bash', toolInput: { command: 'ls' }, ...input }, options);

    // One phase entry resolves the source for the actual root.
    const A = state.head;
    const first = await invoke({ event: 'PhaseEntry', sessionId: 'parent', cwd: parentRoot });
    expect(first.decision).toBe('allow');
    expect(first.project).toBe(parentRoot);
    expect(first.report?.source.commit).toBe(A);
    expect(state.branchCalls).toBe(1);
    const httpAfterFirst = state.httpCalls;
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`immutable ${A}`);
    expect(await runtimeFiles(runtimeDirectory)).toHaveLength(1);

    // Upstream advances, but no native event may observe it or re-synchronize. This is the
    // key cadence difference from today's per-boundary invalidation.
    state.head = 'b'.repeat(40);
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
    expect(state.branchCalls, 'no native event may re-synchronize the parent root').toBe(1);
    expect(state.httpCalls, 'no native event may issue a source request').toBe(httpAfterFirst);
    expect(changedPaths(runtimeAfterFirst, await snapshotTree(runtimeDirectory)), 'native events must not rewrite the cache').toEqual([]);
    expect(changedPaths(parentAfterFirst, await snapshotTree(parentRoot)), 'native events must not edit the contract').toEqual([]);
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`immutable ${A}`);

    // A second phase entry replaces the stored entry rather than adding one, and picks up B.
    const B = state.head;
    const second = await invoke({ event: 'PhaseEntry', sessionId: 'parent', cwd: parentRoot });
    expect(second.report?.source.commit).toBe(B);
    expect(state.branchCalls).toBe(2);
    expect(await runtimeFiles(runtimeDirectory), 'a second phase entry must replace the stored entry').toHaveLength(1);
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`immutable ${B}`);
    const httpAfterSecond = state.httpCalls;
    const replayB = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: parentRoot });
    expect(replayB.report?.source.commit).toBe(B);
    expect(state.httpCalls, 'the replaced entry must be served with zero requests').toBe(httpAfterSecond);

    // A distinct actual root with its own `.ai-workflow/` has no stored check: no-check allow,
    // zero requests, and it never replays the parent root's decision or authority.
    state.head = 'c'.repeat(40);
    const C = state.head;
    const worktreeBefore = await snapshotTree(worktreeRoot);
    const worktreeNative = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: worktreeRoot });
    expect(worktreeNative.decision).toBe('allow');
    expect(worktreeNative.project).toBe(worktreeRoot);
    expect(worktreeNative.report, 'an unprimed worktree must not replay the parent report').toBeUndefined();
    expect(worktreeNative.authority, 'an unprimed worktree must not replay the parent authority').toBeUndefined();
    expect(state.branchCalls, 'an unprimed worktree native event must not query the source').toBe(2);
    expect(changedPaths(worktreeBefore, await snapshotTree(worktreeRoot)), 'an unprimed worktree must not be edited').toEqual([]);
    expect(await runtimeFiles(runtimeDirectory)).toHaveLength(1);

    // Only a phase entry in the second root synchronizes it into its own entry.
    const worktreePhase = await invoke({ event: 'PhaseEntry', sessionId: 'parent', cwd: worktreeRoot });
    expect(worktreePhase.project).toBe(worktreeRoot);
    expect(worktreePhase.report?.source.commit).toBe(C);
    expect(state.branchCalls).toBe(3);
    expect(await runtimeFiles(runtimeDirectory), 'each actual root keeps its own cache entry').toHaveLength(2);
    expect(await readFile(join(worktreeRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`immutable ${C}`);
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8'), 'syncing the worktree must not edit the parent').toContain(`immutable ${B}`);

    const httpAfterWorktree = state.httpCalls;
    const worktreeReplay = await invoke({ event: 'UserPromptSubmit', sessionId: 'child', cwd: worktreeRoot });
    expect(worktreeReplay.report?.source.commit).toBe(C);
    expect(state.httpCalls, 'the worktree entry must be served with zero requests').toBe(httpAfterWorktree);

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
    await writeAdoptedTarget(root, COMMIT, { '.ai-workflow/AGENTS.md': MALFORMED_AGENTS });
    const state: ScriptedSourceState = { head: COMMIT, branchCalls: 0, httpCalls: 0 };
    const http = scriptedHeadFetch(state);
    const options = { fetch: http, env: {}, runtimeDirectory };
    const invoke = (toolName: string, toolInput: unknown): Promise<ProjectGateResult> =>
      runProjectGate({ host: 'opencode', event: 'PreToolUse', sessionId: 'exempt-session', cwd: root, toolName, toolInput }, options);

    const contractPath = join(root, '.ai-workflow/AGENTS.md');
    const contract = await readFile(contractPath, 'utf8');
    const before = await snapshotTree(root);

    // A phase entry stores the true conflict (not a source-failure warning) and denies ordinary tools.
    const primed = await runProjectGate({ host: 'opencode', event: 'PhaseEntry', sessionId: 'exempt-session', cwd: root }, options);
    expect(primed.decision).toBe('deny');
    expect(primed.report?.status).toBe('conflict');
    expect(primed.report?.verified).toBe(false);
    const httpAfterPrime = state.httpCalls;
    const branchAfterPrime = state.branchCalls;
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
    ] as const) {
      const actor = await invoke(toolName, { command });
      expect(actor.decision, `actor: ${command}`).toBe('allow');
      expectNoFreshness(actor);
      const stillDenied = await invoke('Bash', { command: 'ls -la' });
      expect(stillDenied.decision).toBe('deny');
      expect(stillDenied.report?.status).toBe('conflict');
    }

    // The required authority read of the exact project contract is permitted for both native
    // casings/keys, even while the cached conflict keeps ordinary tools denied.
    for (const [toolName, key] of [['read', 'filePath'], ['Read', 'file_path']] as const) {
      const authorityRead = await invoke(toolName, { [key]: contractPath });
      expect(authorityRead.decision, `authority read: ${toolName}`).toBe('allow');
      expectNoFreshness(authorityRead);
      if (authorityRead.authority !== undefined) expect(authorityRead.authority).toBe(contract);
      const stillDenied = await invoke('Bash', { command: 'ls -la' });
      expect(stillDenied.decision).toBe('deny');
    }

    // Only the exact actor and the exact contract read are exempted, not every token-bearing
    // command or nearby file.
    const lookalikeCommand = await invoke('Bash', { command: `echo ai-workflow sync-hook --host opencode --phase --project ${root}` });
    expect(lookalikeCommand.decision).toBe('deny');
    const nearMissFile = await invoke('read', { filePath: `${contractPath}.bak` });
    expect(nearMissFile.decision).toBe('deny');
    const unrelatedFile = await invoke('read', { filePath: join(root, 'MEMORY.md') });
    expect(unrelatedFile.decision).toBe('deny');

    expect(state.branchCalls, 'exemptions and native replays must not query HEAD').toBe(branchAfterPrime);
    expect(state.httpCalls, 'exemptions and native replays must issue zero source requests').toBe(httpAfterPrime);
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
    const state: ScriptedSourceState = { head: COMMIT, branchCalls: 0, httpCalls: 0 };
    const http = scriptedHeadFetch(state);
    const options = { fetch: http, env: {}, runtimeDirectory };

    const [first, second] = await Promise.all([
      runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'concurrent-1', cwd: root }, options),
      runProjectGate({ host: 'claude', event: 'PhaseEntry', sessionId: 'concurrent-2', cwd: root }, options),
    ]);
    expect(first.decision).toBe('allow');
    expect(second.decision).toBe('allow');

    const files = await runtimeFiles(runtimeDirectory);
    expect(files, 'concurrent phase entries must leave exactly one cache entry').toHaveLength(1);
    expect(await parseRuntimeFile(files[0]!), 'the surviving entry must be complete and parsable').toBeTruthy();

    const httpAfterPhases = state.httpCalls;
    const replay = await runProjectGate(
      { host: 'claude', event: 'PreToolUse', sessionId: 'after', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
      options,
    );
    expect(replay.decision).toBe('allow');
    expect(replay.report, 'the following native event must replay a complete stored result').toBeDefined();
    expect(state.httpCalls, 'the replay must issue zero source requests').toBe(httpAfterPhases);
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
    const state: ScriptedSourceState = { head: COMMIT, branchCalls: 0, httpCalls: 0 };
    const http = scriptedHeadFetch(state);
    const options = { fetch: http, env: {}, runtimeDirectory };
    const invoke = (input: Omit<ProjectGateInput, 'host'>): Promise<ProjectGateResult> =>
      runProjectGate({ host: 'claude', toolName: 'Bash', toolInput: { command: 'ls' }, ...input }, options);

    const operationAgents = join(operationRoot, '.ai-workflow/AGENTS.md');
    expect(await readFile(operationAgents, 'utf8')).not.toContain(`immutable ${COMMIT}`);

    // Prime only the session root with a phase entry.
    const primed = await invoke({ event: 'PhaseEntry', sessionId: 'route-session', cwd: sessionRoot });
    expect(primed.project).toBe(sessionRoot);
    expect(primed.report?.status).toBe('synchronized');
    const branchAfterPrime = state.branchCalls;
    const httpAfterPrime = state.httpCalls;
    const sessionRootAfterPrime = await snapshotTree(sessionRoot);

    // A native event at the session root answers from that root's cache with no request.
    const sessionNative = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot });
    expect(sessionNative.project).toBe(sessionRoot);
    expect(sessionNative.report?.project).toBe(sessionRoot);
    expect(state.httpCalls, 'a primed native event must issue no request').toBe(httpAfterPrime);

    // A Bash `workdir` targeting another adopted root has no stored check: no-check allow, no
    // request and no write, and it must not reuse the session root's cached result.
    const operationBefore = await snapshotTree(operationRoot);
    const routedBash = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot, toolName: 'Bash', toolInput: { command: 'ls', workdir: operationRoot } });
    expect(routedBash.project).toBe(operationRoot);
    expect(routedBash.decision).toBe('allow');
    expect(routedBash.report, 'an unprimed routed root must not synchronize').toBeUndefined();
    expect(state.branchCalls, 'routing to an unprimed root must not query the source').toBe(branchAfterPrime);
    expect(changedPaths(operationBefore, await snapshotTree(operationRoot)), 'the routed no-check must not edit that root').toEqual([]);
    expect(await readFile(operationAgents, 'utf8')).not.toContain(`immutable ${COMMIT}`);

    // Only a phase entry in the routed root synchronizes it.
    const operationPhase = await invoke({ event: 'PhaseEntry', sessionId: 'route-operation', cwd: operationRoot });
    expect(operationPhase.project).toBe(operationRoot);
    expect(operationPhase.report?.project).toBe(operationRoot);
    expect(operationPhase.report?.status).toBe('synchronized');
    expect(operationPhase.report?.source.commit).toBe(COMMIT);
    expect(state.branchCalls).toBe(branchAfterPrime + 1);
    expect(await readFile(operationAgents, 'utf8'), 'the phase entry must sync the routed root').toContain(`immutable ${COMMIT}`);
    expect(changedPaths(sessionRootAfterPrime, await snapshotTree(sessionRoot)), 'the session root must not be touched by a routed operation').toEqual([]);

    // Now native routed operations replay the routed root's cached result with no request.
    const httpAfterOperation = state.httpCalls;
    const routedRead = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot, toolName: 'read', toolInput: { filePath: join(operationRoot, 'src/file.ts') } });
    expect(routedRead.project).toBe(operationRoot);
    expect(routedRead.report?.project).toBe(operationRoot);
    expect(state.httpCalls, 'a routed read must answer from the routed root cache').toBe(httpAfterOperation);

    const routedBashReplay = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot, toolName: 'Bash', toolInput: { command: 'ls', workdir: operationRoot } });
    expect(routedBashReplay.project).toBe(operationRoot);
    expect(routedBashReplay.report?.project).toBe(operationRoot);
    expect(state.httpCalls).toBe(httpAfterOperation);

    // A relative tool path resolves against the session cwd, never by guessing a parent root.
    const relativeRead = await invoke({ event: 'PreToolUse', sessionId: 'route-session', cwd: sessionRoot, toolName: 'read', toolInput: { filePath: 'src/file.ts' } });
    expect(relativeRead.project).toBe(sessionRoot);
    expect(relativeRead.report?.project).toBe(sessionRoot);
    expect(changedPaths(sessionRootAfterPrime, await snapshotTree(sessionRoot)), 'a relative path must not reroute the operation').toEqual([]);
    expect(state.httpCalls).toBe(httpAfterOperation);
  });
});
