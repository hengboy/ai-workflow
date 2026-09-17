import { lstat, readFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { resolveProjectRoot } from '../context/paths.js';
import { exists } from '../utils/fs.js';
import { enumerateNotes, noteClasses, noteLifecycles } from './index.js';

const implementedSections = ['Problem', 'Decision', 'Alternatives considered', 'Consequences'];
const requiredSections = {
  proposed: ['Problem', 'Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks'],
  implemented: implementedSections,
  rejected: ['Problem', 'Proposal', 'Alternatives considered'],
  archived: implementedSections,
};
const planningSections = ['Proposal', 'Plan', 'Migration plan', 'Acceptance criteria'];

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateFormat(path: string, lifecycle: typeof noteLifecycles[number], contents: string): string[] {
  const errors: string[] = [];
  const filename = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(basename(path));
  if (!filename) errors.push('file name must be YYYY-MM-DD-topic-title.md with an English kebab-case topic');
  else if (!validDate(filename[1]!)) errors.push('file name date must be a real calendar date');

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
  let bodyStart = 3;
  if (lifecycle === 'archived') {
    const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[3] ?? '');
    if (!archived || !validDate(archived[1]!)) errors.push('Archived must immediately follow Status with a real YYYY-MM-DD date');
    bodyStart = 4;
  }
  const body = lines.slice(bodyStart);
  if (body.find((line) => line.trim()) !== '## Problem') errors.push('body must start with ## Problem');

  const sections: { title: string; content: string[] }[] = [];
  let fence: string | undefined;
  for (const line of body) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        fence = undefined;
      } else {
        sections.at(-1)?.content.push(line);
      }
      continue;
    }
    if (marker) {
      fence = marker[1]!;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    const title = heading?.[2]?.replace(/\s+#+$/, '');
    if ((lifecycle === 'implemented' || lifecycle === 'archived') && title && planningSections.includes(title)) {
      errors.push(`planning section ${title} is not allowed in ${lifecycle} notes`);
    }
    if (heading && heading[1]!.length <= 2) {
      if (heading[1] === '#') errors.push('body sections must use level-two headings');
      sections.push({ title: title!, content: [] });
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
    if (!sections[position]!.content.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim()) {
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
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker[1]!;
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
    const cleaned = target.replace(/^</, '').replace(/>$/, '').split('#')[0]!.trim();
    if (!cleaned.endsWith('.md') || cleaned.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned) || checked.has(cleaned)) continue;
    checked.add(cleaned);
    const resolved = posix.normalize(posix.join(posix.dirname(path), cleaned));
    if (!(await exists(join(root, resolved)))) {
      errors.push(`${path}: relative Markdown link ${cleaned} does not exist`);
    }
  }
  return errors;
}

export async function validateNotes(project: string): Promise<{ valid: boolean; errors: string[] }> {
  const root = resolveProjectRoot(project);
  const notesRoot = '.ai-workflow/notes';
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
    const stats = await lstat(join(root, path));
    const isFile = path.endsWith('.md') || path.endsWith('.json');
    if (isFile ? !stats.isFile() : !stats.isDirectory()) {
      errors.push(`${path}: required notes structure must be a ${isFile ? 'file' : 'directory'}`);
    }
  }
  if (errors.length) return { valid: false, errors };

  for await (const note of enumerateNotes(root, errors)) {
    const contents = await readFile(join(root, note.path), 'utf8');
    errors.push(...validateFormat(note.path, note.lifecycle, contents));
    errors.push(...await validateLinks(root, note.path, note.lifecycle, contents));
  }
  return { valid: errors.length === 0, errors };
}
