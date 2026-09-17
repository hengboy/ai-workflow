import { readFile, stat } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { resolveProjectRoot } from '../context/paths.js';
import { exists, readJson } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { enumerateNotes, noteClasses, noteLifecycles, type NoteAnchor } from './index.js';
import {
  blobHash,
  chineseSwitcher,
  englishSwitcher,
  notesRoot,
  parsePairMeta,
  structureDiff,
  noteStructureSignature,
} from './pairing.js';

const manifestPath = `${notesRoot}/archived/manifest.json`;
type ArchiveManifest = { version: 1; files: Record<string, string> };

const implementedSections = ['Problem', 'Decision', 'Alternatives considered', 'Consequences'];
const requiredSections = {
  proposed: ['Problem', 'Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks'],
  implemented: implementedSections,
  rejected: ['Problem', 'Proposal', 'Alternatives considered'],
  archived: implementedSections,
};
const planningSections = ['Proposal', 'Plan', 'Migration plan', 'Acceptance criteria'];
const englishName = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateEnglishName(path: string): string[] {
  const errors: string[] = [];
  const filename = englishName.exec(basename(path));
  if (!filename) errors.push('file name must be YYYY-MM-DD-topic-title.md with an English kebab-case topic');
  else if (!validDate(filename[1] ?? '')) errors.push('file name date must be a real calendar date');
  return errors.map((error) => `${path}: ${error}`);
}

export function validateFormat(
  path: string,
  lifecycle: typeof noteLifecycles[number],
  contents: string,
  switcher: string,
): string[] {
  const errors: string[] = [];
  const lines = contents.split(/\r?\n/);
  if (!/^# Agent Note: \S.*$/.test(lines[0] ?? '') || lines[1] !== '') {
    errors.push('fixed title header must be # Agent Note: <title> followed by a blank line');
  }
  const expectedStatus = lifecycle === 'archived' ? 'implemented' : lifecycle;
  const validStatus = expectedStatus === 'rejected'
    ? /^Status: rejected — \S.*$/.test(lines[2] ?? '')
    : lines[2] === `Status: ${expectedStatus}`;
  if (!validStatus) {
    const expected = expectedStatus === 'rejected' ? 'rejected — <one-line reason>' : expectedStatus;
    errors.push(`Status must be ${expected} for lifecycle ${lifecycle}`);
  }
  let cursor = 3;
  if (lifecycle === 'archived') {
    const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[3] ?? '');
    if (!archived || !validDate(archived[1] ?? '')) errors.push('Archived must immediately follow Status with a real YYYY-MM-DD date');
    cursor = 4;
  }
  if (lines[cursor] !== '') errors.push('the header block must be followed by a blank line');
  else if (lines[cursor + 1] !== switcher) errors.push(`language switcher must be exactly "${switcher}"`);
  else if (lines[cursor + 2] !== '') errors.push('the language switcher must be followed by a blank line');
  const body = lines.slice(cursor + 3);
  if (body.find((line) => line.trim()) !== '## Problem') errors.push('body must start with ## Problem');

  const sections: { title: string; content: string[] }[] = [];
  let fence: string | undefined;
  for (const line of body) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const markerFence = marker?.[1];
    const markerRest = marker?.[2] ?? '';
    if (fence) {
      if (markerFence && markerFence[0] === fence[0] && markerFence.length >= fence.length && !markerRest.trim()) {
        fence = undefined;
      } else {
        sections.at(-1)?.content.push(line);
      }
      continue;
    }
    if (markerFence) {
      fence = markerFence;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    const headingMarker = heading?.[1];
    const title = heading?.[2]?.replace(/\s+#+$/, '');
    if ((lifecycle === 'implemented' || lifecycle === 'archived') && title && planningSections.includes(title)) {
      errors.push(`planning section ${title} is not allowed in ${lifecycle} notes`);
    }
    if (headingMarker && headingMarker.length <= 2) {
      if (headingMarker === '#') errors.push('body sections must use level-two headings');
      sections.push({ title: title ?? '', content: [] });
    } else {
      sections.at(-1)?.content.push(heading ? '' : line);
    }
  }
  let previous = -1;
  for (const title of requiredSections[lifecycle]) {
    const matching = sections.filter((section) => section.title === title);
    if (matching.length !== 1) errors.push(`required section ${title} must occur exactly once`);
    const position = sections.findIndex((section) => section.title === title);
    if (position === -1) continue;
    if (position <= previous) errors.push(`required section ${title} is out of order`);
    previous = position;
    const section = sections[position];
    if (section && !section.content.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim()) {
      errors.push(`required section ${title} must not be empty`);
    }
  }
  return errors.map((error) => `${path}: ${error}`);
}

function markdownLinkTargets(contents: string): string[] {
  const targets: string[] = [];
  let fence: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const markerFence = marker?.[1];
    const markerRest = marker?.[2] ?? '';
    if (fence) {
      if (markerFence && markerFence[0] === fence[0] && markerFence.length >= fence.length && !markerRest.trim()) fence = undefined;
      continue;
    }
    if (markerFence) {
      fence = markerFence;
      continue;
    }
    for (const match of line.matchAll(/(?<!!)\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g)) {
      if (match[1]) targets.push(match[1]);
    }
  }
  return targets;
}

async function validateLinks(root: string, path: string, lifecycle: typeof noteLifecycles[number], contents: string): Promise<string[]> {
  if (lifecycle === 'archived') return [];
  const errors: string[] = [];
  const checked = new Set<string>();
  for (const target of markdownLinkTargets(contents)) {
    const cleaned = (target.replace(/^</, '').replace(/>$/, '').split('#')[0] ?? '').trim();
    if (!cleaned.endsWith('.md') || cleaned.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned) || checked.has(cleaned)) continue;
    checked.add(cleaned);
    const resolved = posix.normalize(posix.join(posix.dirname(path), cleaned));
    if (!(await exists(join(root, resolved)))) {
      errors.push(`${path}: relative Markdown link ${cleaned} does not exist`);
    }
  }
  return errors;
}

export async function validateNotePair(root: string, note: NoteAnchor, errors: string[]): Promise<void> {
  const english = await readFile(join(root, note.path), 'utf8');
  const switcher = englishSwitcher(note.path);
  errors.push(...validateEnglishName(note.path));
  errors.push(...validateFormat(note.path, note.lifecycle, english, switcher));
  errors.push(...await validateLinks(root, note.path, note.lifecycle, english));

  if (!(await exists(join(root, note.zhPath)))) {
    errors.push(`${note.zhPath}: missing Chinese counterpart (.zh.md) for the note`);
  } else {
    const chinese = await readFile(join(root, note.zhPath), 'utf8');
    errors.push(...validateFormat(note.zhPath, note.lifecycle, chinese, chineseSwitcher(note.path)));
    errors.push(...await validateLinks(root, note.zhPath, note.lifecycle, chinese));
    const counterpart = basename(note.path);
    for (const difference of structureDiff(
      noteStructureSignature(english, basename(note.zhPath)),
      noteStructureSignature(chinese, counterpart),
    )) {
      errors.push(`${note.path}: ${difference}`);
    }
  }

  if (!(await exists(join(root, note.metaPath)))) {
    errors.push(`${note.metaPath}: missing consistency record (.i18n.yaml) for the note`);
    return;
  }
  const meta = await readFile(join(root, note.metaPath), 'utf8');
  const entries = parsePairMeta(meta);
  if (!entries) {
    errors.push(`${note.metaPath}: consistency record must contain only <note>.md: <40-hex git blob hash> lines`);
    return;
  }
  const englishKey = basename(note.path);
  const zhKey = basename(note.zhPath);
  if (entries.size !== 2 || !entries.has(englishKey) || !entries.has(zhKey)) {
    errors.push(`${note.metaPath}: consistency record must record exactly ${englishKey} and ${zhKey}`);
  }
  if (entries.get(englishKey) !== blobHash(english)) {
    errors.push(`${note.metaPath}: recorded hash for ${englishKey} does not match the current English bytes; re-record with ai-workflow notes pairing --write`);
  }
  if (await exists(join(root, note.zhPath))) {
    const chinese = await readFile(join(root, note.zhPath), 'utf8');
    if (entries.get(zhKey) !== blobHash(chinese)) {
      errors.push(`${note.metaPath}: recorded hash for ${zhKey} does not match the current Chinese bytes; re-record with ai-workflow notes pairing --write`);
    }
  }
}

async function validateArchive(root: string, archived: Map<string, NoteAnchor>, errors: string[]): Promise<void> {
  let manifest: ArchiveManifest;
  try {
    manifest = await readJson<ArchiveManifest>(join(root, manifestPath));
  } catch (error) {
    errors.push(`${manifestPath}: archive manifest must be readable JSON (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  const files = manifest?.files;
  if (manifest?.version !== 1 || !files || typeof files !== 'object' || Array.isArray(files)) {
    errors.push(`${manifestPath}: archive manifest must be { version: 1, files: { <path>: sha256:<hex> } }`);
    return;
  }
  for (const [key, digest] of Object.entries(files)) {
    if (!(await exists(join(root, notesRoot, key)))) {
      errors.push(`${manifestPath}: entry ${key} has no archived artifact`);
      continue;
    }
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      errors.push(`${manifestPath}: entry ${key} must map to sha256:<hex>`);
      continue;
    }
    if (sha256(await readFile(join(root, notesRoot, key))) !== digest) {
      errors.push(`${key}: archived artifact bytes differ from the manifest digest`);
    }
  }
  for (const note of archived.values()) {
    for (const artifact of [note.path, note.zhPath, note.metaPath]) {
      const key = artifact.slice(notesRoot.length + 1);
      if (!(key in files)) errors.push(`${artifact}: archived artifact is not registered in ${manifestPath}`);
    }
  }
}

export async function validateNotes(project: string): Promise<{ valid: boolean; errors: string[] }> {
  const root = resolveProjectRoot(project);
  const requiredPaths = [
    '.ai-workflow/AGENTS.md',
    notesRoot,
    `${notesRoot}/AGENTS.md`,
    `${notesRoot}/README.md`,
    `${notesRoot}/implemented/AGENTS.md`,
    `${notesRoot}/archived/AGENTS.md`,
    `${notesRoot}/archived/manifest.json`,
    ...noteLifecycles.flatMap((lifecycle) => [
      `${notesRoot}/${lifecycle}`,
      ...noteClasses.map((noteClass) => `${notesRoot}/${lifecycle}/${noteClass}`),
    ]),
  ];
  const errors: string[] = [];
  for (const path of requiredPaths) {
    if (!(await exists(join(root, path)))) {
      errors.push(`${path}: required notes structure is missing`);
      continue;
    }
    const stats = await stat(join(root, path));
    const isFile = path.endsWith('.md') || path.endsWith('.json');
    if (isFile ? !stats.isFile() : !stats.isDirectory()) {
      errors.push(`${path}: required notes structure must be a ${isFile ? 'file' : 'directory'}`);
    }
  }
  if (errors.length) return { valid: false, errors };

  const archived = new Map<string, NoteAnchor>();
  for await (const note of enumerateNotes(root, errors)) {
    await validateNotePair(root, note, errors);
    if (note.lifecycle === 'archived') archived.set(note.path, note);
  }
  await validateArchive(root, archived, errors);
  return { valid: errors.length === 0, errors };
}
