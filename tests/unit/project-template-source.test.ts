import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTemplateSnapshot } from '../../src/sync/source.js';
import { exists } from '../../src/utils/fs.js';
import { fakeGit, type TestGitRunner } from '../helpers.js';

const REPOSITORY = 'hengboy/ai-workflow';
const BRANCH = 'simplify';
const PUBLIC_URL = 'https://github.com/hengboy/ai-workflow.git';

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

function upstreamSectionId(repoPath: string): string {
  return repoPath.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

/**
 * Independent expected upstream content for one immutable commit: the mergeable Markdown
 * templates carry a valid owned section, and the preserved JSON data stays valid.
 */
function upstreamFileContents(commit: string, repoPath: string): string {
  if (repoPath.endsWith('manifest.json')) return '{\n  "version": 1,\n  "files": {}\n}\n';
  if (repoPath.endsWith('json')) return `${JSON.stringify({ version: 1, commit }, null, 2)}\n`;
  const id = upstreamSectionId(repoPath);
  return `# ${repoPath}\n<!-- ai-workflow:section ${id}:begin -->\nimmutable ${commit}\n<!-- ai-workflow:section ${id}:end -->\n`;
}

/** The full valid source set at one commit, keyed by repository-relative path. */
function sourceFiles(commit: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of SOURCE_PATHS) files[path] = upstreamFileContents(commit, path);
  return files;
}

// The regression guard: while these suites run, any HTTP request is a failure. Source
// acquisition must go through the injected git runner only.
let fetchCalls = 0;
beforeEach(() => {
  fetchCalls = 0;
  vi.stubGlobal('fetch', () => {
    fetchCalls += 1;
    throw new Error('source acquisition must use the injected git runner, not HTTP');
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('project template source', () => {
  it('shallow-clones the fixed public source and reads every supported template, never HTTP', async () => {
    const commit = 'a'.repeat(40);
    const fake = fakeGit({ commit, files: sourceFiles(commit) });

    const snapshot = await resolveTemplateSnapshot({ runGit: fake.runGit });

    expect(snapshot.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit });
    expect(Object.keys(snapshot.files).sort()).toEqual([...SOURCE_PATHS].sort());
    for (const path of SOURCE_PATHS) expect(snapshot.files[path]).toBe(upstreamFileContents(commit, path));

    // The exact production sequence: one shallow clone of the fixed public address into the
    // already-created destination, then a rev-parse of that clone's HEAD.
    expect(fake.cloneCount()).toBe(1);
    const destination = fake.clones[0]!;
    expect(fake.calls[0]).toEqual(['clone', '--depth', '1', '--branch', BRANCH, PUBLIC_URL, destination]);
    expect(fake.calls[1]).toEqual(['-C', destination, 'rev-parse', 'HEAD']);

    // No HTTP at all, even though global fetch would now throw if touched.
    expect(fetchCalls).toBe(0);
  });

  it('clones once per trigger with fresh state, so a later head returns the new commit and bytes', async () => {
    const commitA = 'a'.repeat(40);
    const commitB = 'b'.repeat(40);
    const state = { commit: commitA, files: sourceFiles(commitA) };
    const fake = fakeGit(state);

    const first = await resolveTemplateSnapshot({ runGit: fake.runGit });
    expect(first.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit: commitA });
    for (const path of SOURCE_PATHS) expect(first.files[path]).toBe(upstreamFileContents(commitA, path));

    // A later trigger observes a new HEAD; it must read only the new commit and reuse nothing.
    state.commit = commitB;
    state.files = sourceFiles(commitB);
    const second = await resolveTemplateSnapshot({ runGit: fake.runGit });
    expect(second.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit: commitB });
    for (const path of SOURCE_PATHS) expect(second.files[path]).toBe(upstreamFileContents(commitB, path));
    expect(second.files).not.toEqual(first.files);
    expect(fake.cloneCount()).toBe(2);
    expect(fake.calls.filter((arguments_) => arguments_[0] === 'clone')).toHaveLength(2);
  });

  it('removes the temporary clone directory after a successful acquisition', async () => {
    const commit = 'c'.repeat(40);
    const fake = fakeGit({ commit, files: sourceFiles(commit) });

    await resolveTemplateSnapshot({ runGit: fake.runGit });

    const destination = fake.clones[0]!;
    expect(await exists(destination), 'the temporary clone must be removed').toBe(false);
  });

  it('rejects with a useful message when the clone itself fails', async () => {
    const runGit: TestGitRunner = async () => {
      throw new Error('git clone: fatal: repository not found');
    };

    await expect(resolveTemplateSnapshot({ runGit })).rejects.toThrow(/repository not found/);
    expect(fetchCalls).toBe(0);
  });

  it('rejects an ambiguous branch head that is not an immutable 40-hex commit', async () => {
    const fake = fakeGit({ commit: 'deadbeef', files: sourceFiles('a'.repeat(40)) });

    await expect(resolveTemplateSnapshot({ runGit: fake.runGit })).rejects.toThrow(/Template source branch has no immutable commit: simplify/);
  });

  it('rejects a clone that lacks the templates/project directory', async () => {
    const fake = fakeGit({ commit: 'e'.repeat(40), files: {} });

    await expect(resolveTemplateSnapshot({ runGit: fake.runGit })).rejects.toThrow(/Template source directory is unavailable: templates\/project/);
    expect(fetchCalls).toBe(0);
  });
});

describe('project template source structure validation', () => {
  const malformedCases: Array<{ name: string; path: string; contents: string; reason: RegExp }> = [
    {
      name: 'an unclosed owned-section marker',
      path: 'templates/project/MEMORY.md',
      contents: '# Project memory\n\n<!-- ai-workflow:section standards:begin -->\nnever closed\n',
      reason: /Template source structure is invalid: templates\/project\/MEMORY\.md/,
    },
    {
      name: 'a JSON template with invalid syntax',
      path: 'templates/project/navigation.json',
      contents: '{ this is not valid json\n',
      reason: /Template source structure is invalid: templates\/project\/navigation\.json/,
    },
    {
      name: 'an archive manifest that is not version 1 with a files object',
      path: 'templates/project/notes/archived/manifest.json',
      contents: '{\n  "version": 2,\n  "files": {}\n}\n',
      reason: /Template source structure is invalid: templates\/project\/notes\/archived\/manifest\.json/,
    },
  ];

  it.each(malformedCases)('rejects $name before any target is touched', async ({ path, contents, reason }) => {
    const commit = 'd'.repeat(40);
    const fake = fakeGit({ commit, files: { ...sourceFiles(commit), [path]: contents } });

    await expect(resolveTemplateSnapshot({ runGit: fake.runGit })).rejects.toThrow(reason);
    expect(fetchCalls).toBe(0);
  });
});
