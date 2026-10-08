import { afterEach, describe, expect, it } from 'vitest';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runProjectGate, type ProjectGateResult } from '../../src/sync/gate.js';
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
  /** Every external HTTP request, to prove a reused unit performs no retrieval at all. */
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
  event: string;
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

const severityCases: SeverityCase[] = [
  {
    name: 'a marked project with a safe update allows and exposes the fresh contract authority',
    host: 'claude',
    event: 'PreToolUse',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit);
      return fixedHeadFetch(commit, sourceFiles(commit));
    },
    expected: { decision: 'allow', status: 'synchronized', verified: true, proceed: true, authority: true, updatedContains: ['.ai-workflow/AGENTS.md'] },
  },
  {
    name: 'a failed source branch allows warning continuation instead of a host denial',
    host: 'codex',
    event: 'SessionStart',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit);
      return headFailureFetch(403);
    },
    expected: { decision: 'allow', status: 'unverified', verified: false, proceed: true, authority: false },
  },
  {
    name: 'a safe contract update with unresolved differing legacy content still exposes the fresh contract authority',
    host: 'opencode',
    event: 'tool.execute.before',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit, { 'MEMORY.md': DIFFERING_LEGACY_MEMORY });
      return fixedHeadFetch(commit, { ...sourceFiles(commit), 'templates/project/MEMORY.md': DIFFERING_LEGACY_SOURCE_MEMORY });
    },
    expected: { decision: 'allow', status: 'needs_attention', verified: false, proceed: true, authority: true, updatedContains: ['.ai-workflow/AGENTS.md'] },
  },
  {
    name: 'a malformed target marker denies with a visible reason',
    host: 'claude',
    event: 'PreToolUse',
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit, { '.ai-workflow/AGENTS.md': MALFORMED_AGENTS });
      return fixedHeadFetch(commit, sourceFiles(commit));
    },
    expected: { decision: 'deny', status: 'conflict', verified: false, proceed: false, authority: false },
  },
  {
    name: 'an ordinary filesystem failure denies with a visible reason',
    host: 'codex',
    event: 'PreToolUse',
    readOnlyProjectRoot: true,
    setup: async (root, commit) => {
      await writeAdoptedTarget(root, commit);
      return fixedHeadFetch(commit, sourceFiles(commit));
    },
    expected: { decision: 'deny', status: 'failed', verified: false, proceed: false, authority: false },
  },
];

describe('project sync gate decision and authority', () => {
  it.each(severityCases)('AC-007/AC-008: $name', async (testCase) => {
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
        { host: testCase.host, event: testCase.event, sessionId: 'session-1', cwd: root, toolName: 'Bash', toolInput: { command: 'ls' } },
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
  });

  it('skips the updater outside an adoption without creating or claiming freshness', async () => {
    const root = await temporary('ai-workflow-gate-skip-');
    const runtimeDirectory = await temporary('ai-workflow-gate-runtime-');
    roots.push(root, runtimeDirectory);
    const before = await snapshotTree(root);

    // The skip boundary is the absent `.ai-workflow` adoption root, not a missing
    // AGENTS.md: a valid MEMORY/navigation with a missing managed contract is safe
    // managed creation, while a partial adoption missing MEMORY or navigation is a
    // conflict. This fixture carries no adoption at all.
    const gate = await runProjectGate(
      { host: 'codex', event: 'SessionStart', sessionId: 'session-2', cwd: root },
      { fetch: fixedHeadFetch(COMMIT, sourceFiles(COMMIT)), env: {}, runtimeDirectory },
    );

    expect(gate.decision).toBe('skip');
    expect(gate.authority).toBeUndefined();
    expect(gate.report?.verified ?? false).toBe(false);
    expect(await exists(join(root, '.ai-workflow')), 'an unadopted project must not be initialized by the updater').toBe(false);
    expect(changedPaths(before, await snapshotTree(root)), 'skipping must write nothing').toEqual([]);
  });
});

describe('project sync gate execution-unit lifecycle', () => {
  it('AC-006: shares one source snapshot across a unit, refreshes at each boundary and never inherits a stale root claim', async () => {
    const parentRoot = await temporary('ai-workflow-gate-parent-');
    const childRoot = await temporary('ai-workflow-gate-child-');
    const worktreeRoot = await temporary('ai-workflow-gate-worktree-');
    const runtimeDirectory = await temporary('ai-workflow-gate-runtime-');
    roots.push(parentRoot, childRoot, worktreeRoot, runtimeDirectory);
    for (const root of [parentRoot, childRoot, worktreeRoot]) await writeAdoptedTarget(root, COMMIT);

    // The transient unit store lives outside every synchronization target.
    for (const root of [parentRoot, childRoot, worktreeRoot]) expect(runtimeDirectory.startsWith(root)).toBe(false);

    const state: ScriptedSourceState = { head: 'a'.repeat(40), branchCalls: 0, httpCalls: 0 };
    const http = scriptedHeadFetch(state);

    const invoke = (input: { event: string; sessionId: string; cwd: string; parentSessionId?: string; eventSource?: string }): Promise<ProjectGateResult> =>
      runProjectGate(
        {
          host: 'claude',
          event: input.event,
          sessionId: input.sessionId,
          cwd: input.cwd,
          toolName: 'Bash',
          toolInput: { command: 'ls' },
          ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
          ...(input.eventSource === undefined ? {} : { eventSource: input.eventSource }),
        },
        { fetch: http, env: {}, runtimeDirectory },
      );

    const A = state.head;
    const first = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: parentRoot });
    expect(first.decision).toBe('allow');
    expect(first.project).toBe(parentRoot);
    expect(first.report?.source.commit).toBe(A);
    expect(state.branchCalls).toBe(1);
    const httpCallsAfterFirst = state.httpCalls;
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`immutable ${A}`);

    // Upstream advances mid-unit: no trigger inside the same unit may observe B.
    state.head = 'b'.repeat(40);
    const B = state.head;
    const second = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: parentRoot });
    expect(second.report?.source.commit).toBe(A);
    const childTool = await invoke({ event: 'PreToolUse', sessionId: 'child', cwd: parentRoot, parentSessionId: 'parent' });
    expect(childTool.report?.source.commit).toBe(A);
    const childStart = await invoke({ event: 'SessionStart', sessionId: 'child', cwd: parentRoot, parentSessionId: 'parent' });
    expect(childStart.report?.source.commit).toBe(A);
    const parentAfterChild = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: parentRoot });
    expect(parentAfterChild.report?.source.commit).toBe(A);
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8'), 'a mid-unit trigger must not rewrite the contract').toContain(`immutable ${A}`);
    expect(state.branchCalls, 'one unit queries HEAD once; child boundaries must not invalidate the parent unit').toBe(1);
    expect(state.httpCalls, 'a reused unit performs no external HTTP retrieval').toBe(httpCallsAfterFirst);

    // A prompt event begins a new unit and picks up the advanced HEAD (B).
    const prompt = await invoke({ event: 'UserPromptSubmit', sessionId: 'parent', cwd: parentRoot });
    expect(prompt.report?.source.commit).toBe(B);
    expect(state.branchCalls).toBe(2);
    expect(await readFile(join(parentRoot, '.ai-workflow/AGENTS.md'), 'utf8')).toContain(`immutable ${B}`);
    const promptTool = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: parentRoot });
    expect(promptTool.report?.source.commit).toBe(B);
    expect(state.branchCalls).toBe(2);

    // A resume SessionStart invalidates the previous result and syncs the new HEAD (C).
    state.head = 'c'.repeat(40);
    const C = state.head;
    const resume = await invoke({ event: 'SessionStart', sessionId: 'parent', cwd: parentRoot, eventSource: 'resume' });
    expect(resume.report?.source.commit).toBe(C);
    expect(state.branchCalls).toBe(3);

    // A root switch to a separately adopted child root starts its own unit and normalizes
    // the project to that actual root without editing the parent. The cwd is a nested
    // subdirectory, so the gate must walk up to the adopted root.
    const childSubdirectory = join(childRoot, 'src');
    await mkdir(childSubdirectory, { recursive: true });
    const parentBeforeSwitch = await snapshotTree(parentRoot);
    state.head = 'd'.repeat(40);
    const D = state.head;
    const childUnit = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: childSubdirectory });
    expect(childUnit.project).toBe(childRoot);
    expect(childUnit.report?.project).toBe(childRoot);
    expect(childUnit.report?.source.commit).toBe(D);
    expect(state.branchCalls).toBe(4);
    expect(changedPaths(parentBeforeSwitch, await snapshotTree(parentRoot)), 'syncing a child root must not edit the parent root').toEqual([]);

    // A second distinct adopted root (a disposable coding-worktree stand-in) also gets its
    // own unit; the sibling child root keeps its D bytes.
    state.head = 'e'.repeat(40);
    const E = state.head;
    const worktreeUnit = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: worktreeRoot });
    expect(worktreeUnit.project).toBe(worktreeRoot);
    expect(worktreeUnit.report?.source.commit).toBe(E);
    expect(state.branchCalls).toBe(5);
    expect(await readFile(join(childRoot, '.ai-workflow/AGENTS.md'), 'utf8'), 'a sibling root must not be edited').toContain(`immutable ${D}`);

    // Switching back cannot inherit the earlier parent claim: HEAD is queried again.
    state.head = 'f'.repeat(40);
    const F = state.head;
    const parentAgain = await invoke({ event: 'PreToolUse', sessionId: 'parent', cwd: parentRoot });
    expect(parentAgain.project).toBe(parentRoot);
    expect(parentAgain.report?.source.commit).toBe(F);
    expect(state.branchCalls).toBe(6);

    // An explicit PhaseEntry begins a new unit on the next HEAD (G); a same-root child
    // reuses that phase snapshot instead of starting another unit.
    state.head = '1'.repeat(40);
    const G = state.head;
    const phase = await invoke({ event: 'PhaseEntry', sessionId: 'parent', cwd: parentRoot });
    expect(phase.report?.source.commit).toBe(G);
    expect(state.branchCalls).toBe(7);
    const phaseChild = await invoke({ event: 'PreToolUse', sessionId: 'child', cwd: parentRoot, parentSessionId: 'parent' });
    expect(phaseChild.report?.source.commit).toBe(G);
    expect(state.branchCalls, 'a same-root child must reuse the phase unit').toBe(7);

    // No project synchronization metadata beyond the managed safe patches.
    for (const metadata of ['.ai-workflow/sync.json', '.ai-workflow/project.yml', '.ai-workflow/.sync']) {
      expect(await exists(join(parentRoot, metadata)), `${metadata} must not be created`).toBe(false);
    }
  });
});

function expectNoFreshness(result: ProjectGateResult): void {
  expect(result.report?.verified ?? false).toBe(false);
  if (result.report !== undefined) expect(result.report.status).not.toBe('synchronized');
}

describe('project sync gate actor and authority exemptions', () => {
  it('REQ-004/AC-008: permits the exact sync actor and contract read through a cached conflict without clearing it', async () => {
    const root = await temporary('ai-workflow-gate-exempt-');
    const runtimeDirectory = await temporary('ai-workflow-gate-exempt-runtime-');
    roots.push(root, runtimeDirectory);
    await writeAdoptedTarget(root, COMMIT, { '.ai-workflow/AGENTS.md': MALFORMED_AGENTS });
    const http = fixedHeadFetch(COMMIT, sourceFiles(COMMIT));
    const before = await snapshotTree(root);
    const contractPath = join(root, '.ai-workflow/AGENTS.md');
    const contract = await readFile(contractPath, 'utf8');

    const invoke = (toolName: string, toolInput: unknown): Promise<ProjectGateResult> =>
      runProjectGate(
        { host: 'opencode', event: 'PreToolUse', sessionId: 'exempt-session', cwd: root, toolName, toolInput },
        { fetch: http, env: {}, runtimeDirectory },
      );

    // A true conflict (not a source-failure warning) denies an ordinary tool and is cached.
    const ordinary = await invoke('Bash', { command: 'ls -la' });
    expect(ordinary.decision).toBe('deny');
    expect(ordinary.report?.status).toBe('conflict');
    expect(ordinary.report?.verified).toBe(false);

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

    // Permitting a tool performs no target or frozen-plan write; the contract is unmodified.
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
    expect(await readFile(contractPath, 'utf8')).toBe(contract);
  });
});

describe('project sync gate supported project path routing', () => {
  it('REQ-003/AC-006: routes an explicit tool path to its own adopted root instead of the session root', async () => {
    const sessionRoot = await temporary('ai-workflow-gate-session-');
    const operationRoot = await temporary('ai-workflow-gate-operation-');
    const runtimeDirectory = await temporary('ai-workflow-gate-route-runtime-');
    roots.push(sessionRoot, operationRoot, runtimeDirectory);
    await writeAdoptedTarget(sessionRoot, COMMIT);
    await writeAdoptedTarget(operationRoot, COMMIT);
    await mkdir(join(operationRoot, 'src'), { recursive: true });
    await writeFile(join(operationRoot, 'src/file.ts'), 'export const routed = true;\n');
    const http = fixedHeadFetch(COMMIT, sourceFiles(COMMIT));

    const invoke = (sessionId: string, toolName: string, toolInput: unknown): Promise<ProjectGateResult> =>
      runProjectGate(
        { host: 'claude', event: 'PreToolUse', sessionId, cwd: sessionRoot, toolName, toolInput },
        { fetch: http, env: {}, runtimeDirectory },
      );

    const operationAgents = join(operationRoot, '.ai-workflow/AGENTS.md');
    expect(await readFile(operationAgents, 'utf8')).not.toContain(`immutable ${COMMIT}`);

    // Prime the session root with a cached synchronized unit for this session.
    const primed = await invoke('route-session', 'Bash', { command: 'ls' });
    expect(primed.project).toBe(sessionRoot);
    expect(primed.report?.status).toBe('synchronized');
    const sessionRootAfterPrime = await snapshotTree(sessionRoot);

    // A Bash `workdir` explicitly targets a different adopted root: the operation must run at
    // that root, synchronize it fresh, and never reuse the session root's cached result.
    const routedBash = await invoke('route-session', 'Bash', { command: 'ls', workdir: operationRoot });
    expect(routedBash.project).toBe(operationRoot);
    expect(routedBash.report?.project).toBe(operationRoot);
    expect(routedBash.report?.status).toBe('synchronized');
    expect(routedBash.report?.source.commit).toBe(COMMIT);
    expect(await readFile(operationAgents, 'utf8'), 'the routed root must sync fresh').toContain(`immutable ${COMMIT}`);
    expect(changedPaths(sessionRootAfterPrime, await snapshotTree(sessionRoot)), 'the session root must not be touched by a routed operation').toEqual([]);

    // An absolute Read file path under another adopted root routes to that root too.
    const routedRead = await invoke('read-session', 'read', { filePath: join(operationRoot, 'src/file.ts') });
    expect(routedRead.project).toBe(operationRoot);
    expect(routedRead.report?.project).toBe(operationRoot);

    // A relative tool path resolves against the session cwd, never by guessing a parent root.
    const relativeRead = await invoke('relative-session', 'read', { filePath: 'src/file.ts' });
    expect(relativeRead.project).toBe(sessionRoot);
    expect(changedPaths(sessionRootAfterPrime, await snapshotTree(sessionRoot)), 'relative paths must not reroute the operation').toEqual([]);
  });
});
