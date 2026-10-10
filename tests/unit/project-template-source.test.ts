import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTemplateSnapshot } from '../../src/sync/source.js';
import { exists } from '../../src/utils/fs.js';
import { fakeGit, type TestGitRunner } from '../helpers.js';

const REPOSITORY = 'hengboy/ai-workflow';
const BRANCH = 'main';
const PUBLIC_URL = 'https://github.com/hengboy/ai-workflow.git';

/** The exactly-five generated members fixed by REQ-001. */
const GENERATED_SOURCES = [
  'templates/project/AGENTS.md',
  'templates/project/notes/AGENTS.md',
  'templates/project/notes/README.md',
  'templates/project/notes/implemented/AGENTS.md',
  'templates/project/notes/archived/AGENTS.md',
] as const;

/**
 * Independent expected upstream content for one immutable commit: every generated member is
 * markerless Markdown with a nonempty level-one title.
 */
function generatedFiles(commit: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of GENERATED_SOURCES) {
    const name = path.slice('templates/project/'.length).replace(/\.md$/, '');
    files[path] = `# ${name}\n\nImmutable commit ${commit} body.\n`;
  }
  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

describe('project template source acquisition', () => {
  it('shallow-clones the fixed public source once and returns exactly the five generated members, never HTTP', async () => {
    const commit = 'a'.repeat(40);
    const expected = generatedFiles(commit);
    const fake = fakeGit({ commit, files: expected });

    const snapshot = await resolveTemplateSnapshot({ runGit: fake.runGit });

    expect(snapshot.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit });
    expect(Object.keys(snapshot.files).sort()).toEqual([...GENERATED_SOURCES].sort());
    for (const path of GENERATED_SOURCES) expect(snapshot.files[path]).toBe(expected[path]);

    // The exact production sequence: one shallow clone into the destination, then rev-parse.
    expect(fake.cloneCount()).toBe(1);
    const destination = fake.clones[0]!;
    expect(fake.calls[0]).toEqual(['clone', '--depth', '1', '--branch', BRANCH, PUBLIC_URL, destination]);
    expect(fake.calls[1]).toEqual(['-C', destination, 'rev-parse', 'HEAD']);
    expect(fetchCalls).toBe(0);
  });

  it('does not extend the allowlist for extra upstream files', async () => {
    const commit = '2'.repeat(40);
    const files = {
      ...generatedFiles(commit),
      'templates/project/EXTRA.md': '# Extra\n\nUnsupported destination.\n',
      'templates/project/notes/EXTRA.md': '# Extra notes\n\nUnsupported destination.\n',
    };
    const fake = fakeGit({ commit, files });

    const snapshot = await resolveTemplateSnapshot({ runGit: fake.runGit });

    expect(Object.keys(snapshot.files).sort()).toEqual([...GENERATED_SOURCES].sort());
    expect(snapshot.files).not.toHaveProperty('templates/project/EXTRA.md');
    expect(snapshot.files).not.toHaveProperty('templates/project/notes/EXTRA.md');
  });

  it('clones once per trigger with fresh state, so a later head returns the new commit and bytes', async () => {
    const commitA = 'a'.repeat(40);
    const commitB = 'b'.repeat(40);
    const state = { commit: commitA, files: generatedFiles(commitA) };
    const fake = fakeGit(state);

    const first = await resolveTemplateSnapshot({ runGit: fake.runGit });
    expect(first.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit: commitA });
    for (const path of GENERATED_SOURCES) expect(first.files[path]).toBe(generatedFiles(commitA)[path]);

    // A later trigger observes a new HEAD; it must read only the new commit and reuse nothing.
    state.commit = commitB;
    state.files = generatedFiles(commitB);
    const second = await resolveTemplateSnapshot({ runGit: fake.runGit });
    expect(second.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit: commitB });
    for (const path of GENERATED_SOURCES) expect(second.files[path]).toBe(generatedFiles(commitB)[path]);
    expect(second.files).not.toEqual(first.files);
    expect(fake.cloneCount()).toBe(2);
    expect(fake.calls.filter((arguments_) => arguments_[0] === 'clone')).toHaveLength(2);
  });

  it('removes the temporary clone directory after a successful acquisition', async () => {
    const commit = 'c'.repeat(40);
    const fake = fakeGit({ commit, files: generatedFiles(commit) });

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
    const fake = fakeGit({ commit: 'deadbeef', files: generatedFiles('a'.repeat(40)) });

    await expect(resolveTemplateSnapshot({ runGit: fake.runGit })).rejects.toThrow(/Template source branch has no immutable commit: main/);
  });

  it('rejects a clone that lacks the templates/project directory', async () => {
    const fake = fakeGit({ commit: 'e'.repeat(40), files: {} });

    await expect(resolveTemplateSnapshot({ runGit: fake.runGit })).rejects.toThrow(/Template source directory is unavailable: templates\/project/);
    expect(fetchCalls).toBe(0);
  });
});

describe('project template source completeness and format validation', () => {
  it('rejects an incomplete snapshot that is missing one required generated member', async () => {
    const commit = '1'.repeat(40);
    const path = 'templates/project/notes/implemented/AGENTS.md';
    const files = generatedFiles(commit);
    delete files[path];
    const fake = fakeGit({ commit, files });

    await expect(resolveTemplateSnapshot({ runGit: fake.runGit })).rejects.toThrow(new RegExp(escapeRegExp(path)));
    expect(fetchCalls).toBe(0);
  });

  it('rejects a member that is empty, whitespace-only, titleless or still carries legacy section-marker syntax', async () => {
    const commit = 'f'.repeat(40);
    const path = 'templates/project/notes/README.md';
    const malformed = [
      '',
      '   \n\t\n',
      'Body without a level-one title.\n',
      '# Title\n\n<!-- ai-workflow:section standards:begin -->\nold body\n<!-- ai-workflow:section standards:end -->\n',
    ];

    for (const contents of malformed) {
      const files = { ...generatedFiles(commit), [path]: contents };
      const fake = fakeGit({ commit, files });
      await expect(resolveTemplateSnapshot({ runGit: fake.runGit })).rejects.toThrow(new RegExp(escapeRegExp(path)));
    }
    expect(fetchCalls).toBe(0);
  });
});
