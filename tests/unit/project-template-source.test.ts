import { describe, expect, it, vi } from 'vitest';
import { resolveTemplateSnapshot } from '../../src/sync/source.js';

const REPOSITORY = 'hengboy/ai-workflow';
const BRANCH = 'simplify';

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

/** Directory listings returned by the contents API, keyed by repository-relative path. */
const DIRECTORIES: Record<string, readonly string[]> = {
  'templates/project': ['AGENTS.md', 'MEMORY.md', 'navigation.json', 'navigation.md', 'notes'],
  'templates/project/notes': ['AGENTS.md', 'README.md', 'implemented', 'archived'],
  'templates/project/notes/implemented': ['AGENTS.md'],
  'templates/project/notes/archived': ['AGENTS.md', 'manifest.json'],
};

const FILE_PATHS = new Set<string>(SOURCE_PATHS);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function blobSha(ref: string, repoPath: string): string {
  return Buffer.from(`${ref}:${repoPath}`).toString('hex').slice(0, 40);
}

/** One native contents-API directory entry, pinned to the requested immutable `ref`. */
function contentsEntry(ref: string, repoPath: string, name: string): Record<string, unknown> {
  const childPath = `${repoPath}/${name}`;
  const sha = blobSha(ref, childPath);
  const isDirectory = childPath in DIRECTORIES;
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

function upstreamSectionId(repoPath: string): string {
  return repoPath.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

/**
 * Independent expected upstream content for one immutable ref: the six Markdown
 * templates carry a valid owned section, and the preserved JSON data stays valid JSON.
 */
function upstreamFileContents(ref: string, repoPath: string): string {
  if (repoPath.endsWith('manifest.json')) return '{\n  "version": 1,\n  "files": {}\n}\n';
  if (repoPath.endsWith('json')) return `${JSON.stringify({ version: 1, ref }, null, 2)}\n`;
  const id = upstreamSectionId(repoPath);
  return `# ${repoPath}\n<!-- ai-workflow:section ${id}:begin -->\nimmutable ${ref}\n<!-- ai-workflow:section ${id}:end -->\n`;
}

/**
 * Contents-API fixture. The branch endpoint returns each supplied HEAD in order; every
 * directory listing and file read is served at the request's immutable `ref`, so any
 * cross-commit reuse shows up in the returned bytes.
 */
function sourceFetch(heads: readonly string[], log: string[]): typeof fetch {
  let headIndex = 0;
  return async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = requestUrl(input);
    log.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${REPOSITORY}/branches/${BRANCH}`) {
      const commit = heads[Math.min(headIndex, heads.length - 1)];
      headIndex += 1;
      return jsonResponse({ name: BRANCH, commit: { sha: commit } });
    }
    const contentsPrefix = `/repos/${REPOSITORY}/contents/`;
    if (parsed.pathname.startsWith(contentsPrefix)) {
      const repoPath = decodeURIComponent(parsed.pathname.slice(contentsPrefix.length));
      const ref = parsed.searchParams.get('ref') ?? '';
      const listing = DIRECTORIES[repoPath];
      if (listing) return jsonResponse(listing.map((name) => contentsEntry(ref, repoPath, name)));
      if (FILE_PATHS.has(repoPath)) return contentsFile(ref, repoPath, upstreamFileContents(ref, repoPath));
    }
    return jsonResponse({ message: `Unexpected request ${url}` }, 404);
  };
}

/** Every `ref` seen on a contents request, so a test can prove reads stayed on one commit. */
function requestedRefs(log: readonly string[]): Set<string> {
  const refs = new Set<string>();
  for (const url of log) {
    const parsed = new URL(url);
    if (!parsed.pathname.includes('/contents/')) continue;
    const ref = parsed.searchParams.get('ref');
    if (ref) refs.add(ref);
  }
  return refs;
}

describe('project template source', () => {
  it('pins every supported template read to the single HEAD resolved for each trigger', async () => {
    const commitA = 'a'.repeat(40);
    const commitB = 'b'.repeat(40);
    const log: string[] = [];
    const fetch = sourceFetch([commitA, commitB], log);

    const first = await resolveTemplateSnapshot({ fetch, env: {} });
    expect(first.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit: commitA });
    expect(Object.keys(first.files).sort()).toEqual([...SOURCE_PATHS].sort());
    for (const path of SOURCE_PATHS) expect(first.files[path]).toBe(upstreamFileContents(commitA, path));
    expect(requestedRefs(log)).toEqual(new Set([commitA]));

    // A later trigger observes a new HEAD; it must read only the new commit and reuse nothing.
    log.length = 0;
    const second = await resolveTemplateSnapshot({ fetch, env: {} });
    expect(second.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit: commitB });
    for (const path of SOURCE_PATHS) expect(second.files[path]).toBe(upstreamFileContents(commitB, path));
    expect(requestedRefs(log)).toEqual(new Set([commitB]));
    expect(second.files).not.toEqual(first.files);
  });

  it('sends GH_TOKEN before GITHUB_TOKEN as a bearer header and never prints the token', async () => {
    const commit = 'c'.repeat(40);
    const seen: Array<Record<string, string>> = [];
    const base = sourceFetch([commit], []);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen.push({ ...((init?.headers as Record<string, string> | undefined) ?? {}) });
      return base(input, init);
    };
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];

    try {
      await resolveTemplateSnapshot({ fetch, env: { GH_TOKEN: 'gh-token-value', GITHUB_TOKEN: 'github-token-value' } });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((headers) => headers.Authorization === 'Bearer gh-token-value')).toBe(true);
      expect(seen.some((headers) => headers.Authorization === 'Bearer github-token-value')).toBe(false);

      seen.length = 0;
      await resolveTemplateSnapshot({ fetch, env: { GITHUB_TOKEN: 'github-token-value' } });
      expect(seen.every((headers) => headers.Authorization === 'Bearer github-token-value')).toBe(true);

      seen.length = 0;
      await resolveTemplateSnapshot({ fetch, env: {} });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((headers) => headers.Authorization === undefined)).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const printed = spies.flatMap((spy) => spy.mock.calls.flat()).join(' ');
    expect(printed).not.toContain('gh-token-value');
    expect(printed).not.toContain('github-token-value');
  });
});
