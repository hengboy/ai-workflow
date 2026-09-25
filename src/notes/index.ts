import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProjectRoot } from '../context/paths.js';
import { englishPathOf, metaPathOf, notesRoot, zhPathOf } from './pairing.js';

export const noteLifecycles = ['proposed', 'implemented', 'rejected', 'archived'] as const;
export const noteClasses = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing'] as const;

export type NoteEntry = {
  path: string;
  title: string;
  lifecycle: typeof noteLifecycles[number];
  class: typeof noteClasses[number];
  date: string;
  status: string;
};

export type NoteAnchor = {
  path: string;
  lifecycle: typeof noteLifecycles[number];
  zhPath: string;
  metaPath: string;
};

export async function listNotes(project: string, options: { archived?: boolean } = {}): Promise<NoteEntry[]> {
  const root = resolveProjectRoot(project);
  const entries: NoteEntry[] = [];
  for await (const note of enumerateNotes(root)) {
    if (!options.archived && note.lifecycle === 'archived') continue;
    const segments = note.path.split('/');
    const filename = segments[4] ?? '';
    const lines = (await readFile(join(root, note.path), 'utf8')).split(/\r?\n/);
    entries.push({
      path: note.path,
      title: /^# Agent Note: (.*)$/.exec(lines[0] ?? '')?.[1] ?? '',
      lifecycle: note.lifecycle,
      class: segments[3] as typeof noteClasses[number],
      date: /^(\d{4}-\d{2}-\d{2})-/.exec(filename)?.[1] ?? '',
      status: /^Status: (.*)$/.exec(lines[2] ?? '')?.[1] ?? '',
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export async function* enumerateNotes(root: string, errors: string[] = []): AsyncGenerator<NoteAnchor> {
  const managementFiles = new Set(['AGENTS.md', 'README.md', 'implemented/AGENTS.md', 'archived/AGENTS.md', 'archived/manifest.json']);
  const anchors: NoteAnchor[] = [];
  const siblings: string[] = [];
  async function walk(parts: string[]): Promise<void> {
    const directory = [notesRoot, ...parts].join('/');
    const files = await readdir(join(root, directory), { withFileTypes: true });
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const segments = [...parts, file.name];
      const path = `${directory}/${file.name}`;
      const lifecycle = noteLifecycles.find((value) => value === segments[0]);
      const validClass = noteClasses.some((value) => value === segments[1]);
      if (file.isDirectory()) {
        if (!lifecycle || segments.length > 2 || (segments.length === 2 && !validClass)) {
          errors.push(`${path}: unsupported lifecycle, class or nested directory`);
        }
        await walk(segments);
      } else if (file.isFile() && file.name === '.gitkeep') {
        continue;
      } else if (file.isFile() && managementFiles.has(segments.join('/'))) {
        continue;
      } else if (file.isFile() && lifecycle && validClass && segments.length === 3) {
        if (file.name.endsWith('.zh.md') || file.name.endsWith('.i18n.yaml')) {
          siblings.push(path);
        } else if (file.name.endsWith('.md')) {
          anchors.push({
            path,
            lifecycle,
            zhPath: zhPathOf(path),
            metaPath: metaPathOf(path),
          });
        } else {
          errors.push(`${path}: unsupported lifecycle, class or note path; expected {lifecycle}/{class}/YYYY-MM-DD-topic-title.md`);
        }
      } else {
        errors.push(`${path}: unsupported lifecycle, class or note path; expected {lifecycle}/{class}/YYYY-MM-DD-topic-title.md`);
      }
    }
  }
  await walk([]);
  const anchorPaths = new Set(anchors.map((anchor) => anchor.path));
  for (const path of siblings) {
    if (!anchorPaths.has(englishPathOf(path))) {
      errors.push(`${path}: ${path.endsWith('.i18n.yaml') ? 'consistency record' : 'Chinese note'} has no matching English note`);
    }
  }
  for (const anchor of anchors) yield anchor;
}
