import { validateOwnedSections } from './merge.js';

const repository = 'hengboy/ai-workflow';
const branch = 'simplify';
const sourcePaths = [
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
const sourceDirectories = ['templates/project', 'templates/project/notes', 'templates/project/notes/implemented', 'templates/project/notes/archived'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function resolveTemplateSnapshot(options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<{
  source: { repository: string; branch: string; commit: string };
  files: Record<string, string>;
}> {
  const http = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ai-workflow',
    'X-GitHub-Api-Version': '2026-03-10',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function requestJson(path: string): Promise<unknown> {
    const response = await http(`https://api.github.com/repos/${repository}/${path}`, { headers });
    if (!response.ok) throw new Error(`Template source request failed (${response.status}): ${path}`);
    return response.json();
  }

  const head = await requestJson(`branches/${branch}`);
  if (!isRecord(head) || head.name !== branch || !isRecord(head.commit)
    || typeof head.commit.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(head.commit.sha)) {
    throw new Error(`Template source branch has no immutable commit: ${branch}`);
  }
  const commit = head.commit.sha;
  const listed = new Map<string, Record<string, unknown>>();
  for (const directory of sourceDirectories) {
    if (directory !== 'templates/project') {
      const entry = listed.get(directory);
      if (!entry) continue;
      if (entry.type !== 'dir') throw new Error(`Template source directory is unavailable: ${directory}`);
    }
    const listing = await requestJson(`contents/${directory}?ref=${commit}`);
    if (!Array.isArray(listing)) throw new Error(`Invalid template source listing: ${directory}`);
    for (const entry of listing) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === ''
        || entry.path !== `${directory}/${entry.name}` || typeof entry.type !== 'string'
        || typeof entry.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(entry.sha) || listed.has(entry.path)) {
        throw new Error(`Incomplete template source listing: ${directory}`);
      }
      listed.set(entry.path, entry);
    }
  }
  const files: Record<string, string> = {};
  for (const path of sourcePaths) {
    const entry = listed.get(path);
    if (!entry) continue;
    if (entry.type !== 'file') throw new Error(`Template source file is unavailable: ${path}`);
    const file = await requestJson(`contents/${path}?ref=${commit}`);
    if (!isRecord(file) || file.type !== 'file' || file.path !== path || file.sha !== entry.sha
      || file.encoding !== 'base64' || typeof file.content !== 'string'
      || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`Template source content is unavailable: ${path}`);
    }
    const encoded = file.content.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error(`Invalid template source encoding: ${path}`);
    }
    const contents = Buffer.from(encoded, 'base64');
    if (contents.length !== file.size) throw new Error(`Incomplete template source content: ${path}`);
    const text = contents.toString('utf8');
    try {
      if (path.endsWith('.md') && path !== 'templates/project/navigation.md') {
        validateOwnedSections(text, true);
      } else if (path.endsWith('.json')) {
        const data: unknown = JSON.parse(text);
        if (!isRecord(data)) throw new Error('Template data must be a JSON object');
        if (path === 'templates/project/notes/archived/manifest.json' && (data.version !== 1 || !isRecord(data.files))) {
          throw new Error('Archive manifest must contain version 1 and a files object');
        }
      }
    } catch (error) {
      throw new Error(`Template source structure is invalid: ${path} (${error instanceof Error ? error.message : String(error)})`);
    }
    files[path] = text;
  }
  return { source: { repository, branch, commit }, files };
}
