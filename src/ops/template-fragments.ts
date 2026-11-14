import type { Dirent } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

export type TemplateFragmentProblemKind =
  | 'drift'
  | 'unknown-fragment'
  | 'unpaired-marker'
  | 'duplicate-occurrence'
  | 'unused-fragment';

export interface TemplateFragmentProblem {
  kind: TemplateFragmentProblemKind;
  /** Exact project-relative target or fragment path. */
  path: string;
  fragment?: string;
  message: string;
}

export interface TemplateFragmentCheckResult {
  /** True only when `problems` is empty. */
  valid: boolean;
  /** Canonical fragment files under `templates/fragments`. */
  fragmentCount: number;
  /** Total marked regions across shipped targets. */
  occurrenceCount: number;
  /** Shipped template files containing at least one marker. */
  targetCount: number;
  /** Sorted fragment names (file basename without `.md`). */
  fragments: string[];
  /** Sorted project-relative target paths with markers. */
  targets: string[];
  problems: TemplateFragmentProblem[];
}

const FRAGMENT_DIRECTORY = 'templates/fragments';
const TEMPLATE_DIRECTORY = 'templates';
const MARKDOWN_EXTENSION = '.md';

const START_MARKER = /^<!-- fragment:([^\s<>]+) -->$/;
const END_MARKER = /^<!-- \/fragment:([^\s<>]+) -->$/;

interface Line {
  /** Line content without its terminator; a trailing carriage return is stripped for marker tests. */
  text: string;
  /** Offset of the first byte of the line. */
  start: number;
  /** Offset just past the line's newline (or the end of the file). */
  end: number;
}

interface ParsedRegion {
  name: string;
  /** Offset just past the start marker line's newline. */
  start: number;
  /** Offset of the first byte of the end marker line. */
  end: number;
}

interface ParsedTarget {
  regions: ParsedRegion[];
  /** Marker names whose start or end marker has no matching partner. */
  unpaired: string[];
}

interface FragmentFile {
  name: string;
  path: string;
  bytes: string;
}

interface TargetFile {
  path: string;
  absolute: string;
}

function byName(left: Dirent, right: Dirent): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function projectPath(project: string, absolute: string): string {
  return relative(project, absolute).split(sep).join('/');
}

function problem(kind: TemplateFragmentProblemKind, path: string, message: string, fragment?: string): TemplateFragmentProblem {
  return fragment === undefined ? { kind, path, message } : { kind, path, message, fragment };
}

async function listFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of [...entries].sort(byName)) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function listFragments(project: string): Promise<FragmentFile[]> {
  const directory = join(project, FRAGMENT_DIRECTORY);
  const fragments: FragmentFile[] = [];
  for (const absolute of await listFiles(directory)) {
    if (!absolute.toLowerCase().endsWith(MARKDOWN_EXTENSION)) continue;
    fragments.push({
      name: basename(absolute, MARKDOWN_EXTENSION),
      path: projectPath(project, absolute),
      bytes: await readFile(absolute, 'utf8')
    });
  }
  return fragments;
}

async function listTargets(project: string): Promise<TargetFile[]> {
  const root = join(project, TEMPLATE_DIRECTORY);
  const fragmentRoot = join(project, FRAGMENT_DIRECTORY);
  const targets: TargetFile[] = [];
  for (const absolute of await listFiles(root)) {
    if (!absolute.toLowerCase().endsWith(MARKDOWN_EXTENSION)) continue;
    if (absolute === fragmentRoot || absolute.startsWith(`${fragmentRoot}${sep}`)) continue;
    targets.push({ path: projectPath(project, absolute), absolute });
  }
  return targets;
}

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n') continue;
    const raw = content.slice(start, index);
    lines.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, start, end: index + 1 });
    start = index + 1;
  }
  if (start < content.length) {
    const raw = content.slice(start);
    lines.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, start, end: content.length });
  }
  return lines;
}

function parseTarget(content: string): ParsedTarget {
  const regions: ParsedRegion[] = [];
  const unpaired: string[] = [];
  let open: { name: string; start: number } | undefined;
  for (const line of splitLines(content)) {
    const startMarker = START_MARKER.exec(line.text);
    const endMarker = END_MARKER.exec(line.text);
    if (open === undefined) {
      if (startMarker?.[1] !== undefined) {
        open = { name: startMarker[1], start: line.end };
      } else if (endMarker?.[1] !== undefined) {
        unpaired.push(endMarker[1]);
      }
      continue;
    }
    if (endMarker?.[1] === open.name) {
      regions.push({ name: open.name, start: open.start, end: line.start });
      open = undefined;
      continue;
    }
    if (startMarker?.[1] !== undefined) {
      unpaired.push(open.name);
      open = { name: startMarker[1], start: line.end };
      continue;
    }
    if (endMarker?.[1] !== undefined) unpaired.push(endMarker[1]);
  }
  if (open !== undefined) unpaired.push(open.name);
  return { regions, unpaired };
}

function problemForDuplicate(path: string, fragment: string): TemplateFragmentProblem {
  return problem('duplicate-occurrence', path, `Duplicate occurrence of fragment '${fragment}' in ${path}`, fragment);
}

function problemForUnpaired(path: string, fragment: string): TemplateFragmentProblem {
  return problem('unpaired-marker', path, `Unpaired fragment marker '${fragment}' in ${path}`, fragment);
}

function problemForUnknown(path: string, fragment: string): TemplateFragmentProblem {
  return problem('unknown-fragment', path, `Unknown fragment '${fragment}' in ${path}`, fragment);
}

function problemForDrift(path: string, fragmentPath: string, fragment: string): TemplateFragmentProblem {
  return problem('drift', path, `Fragment drift in ${path}: region does not match ${fragmentPath}`, fragment);
}

function problemForUnused(fragmentPath: string, fragment: string): TemplateFragmentProblem {
  return problem('unused-fragment', fragmentPath, `Fragment ${fragmentPath} has no occurrence in any shipped target`, fragment);
}

/** Read-only byte-exact check of every inline fragment copy in the shipped Markdown templates. */
export async function checkTemplateFragments(project: string): Promise<TemplateFragmentCheckResult> {
  const fragments = await listFragments(project);
  const fragmentByName = new Map(fragments.map((fragment) => [fragment.name, fragment]));
  const used = new Set<string>();
  const problems: TemplateFragmentProblem[] = [];
  const targets: string[] = [];
  let occurrenceCount = 0;

  for (const target of await listTargets(project)) {
    const content = await readFile(target.absolute, 'utf8');
    const parsed = parseTarget(content);
    if (parsed.regions.length === 0 && parsed.unpaired.length === 0) continue;
    targets.push(target.path);
    occurrenceCount += parsed.regions.length;

    const occurrences = new Map<string, number>();
    for (const region of parsed.regions) {
      occurrences.set(region.name, (occurrences.get(region.name) ?? 0) + 1);
      const fragment = fragmentByName.get(region.name);
      if (fragment === undefined) {
        problems.push(problemForUnknown(target.path, region.name));
        continue;
      }
      used.add(region.name);
      const inline = content.slice(region.start, region.end);
      if (inline !== fragment.bytes) problems.push(problemForDrift(target.path, fragment.path, region.name));
    }
    for (const [name, count] of occurrences) {
      if (count > 1) problems.push(problemForDuplicate(target.path, name));
    }
    for (const name of new Set(parsed.unpaired)) {
      problems.push(problemForUnpaired(target.path, name));
    }
  }

  for (const fragment of fragments) {
    if (!used.has(fragment.name)) problems.push(problemForUnused(fragment.path, fragment.name));
  }

  const fragmentsSorted = fragments.map((fragment) => fragment.name).sort();
  targets.sort();
  return {
    valid: problems.length === 0,
    fragmentCount: fragments.length,
    occurrenceCount,
    targetCount: targets.length,
    fragments: fragmentsSorted,
    targets,
    problems
  };
}

/** Replace only marked regions with canonical fragment bytes, leaving all unmarked text untouched. */
export async function writeTemplateFragments(project: string): Promise<TemplateFragmentCheckResult> {
  const fragmentByName = new Map((await listFragments(project)).map((fragment) => [fragment.name, fragment]));

  for (const target of await listTargets(project)) {
    const content = await readFile(target.absolute, 'utf8');
    const parsed = parseTarget(content);
    let next = '';
    let cursor = 0;
    let changed = false;
    for (const region of parsed.regions) {
      const fragment = fragmentByName.get(region.name);
      if (fragment === undefined) continue;
      next += content.slice(cursor, region.start);
      next += fragment.bytes;
      cursor = region.end;
      changed = true;
    }
    next += content.slice(cursor);
    if (changed && next !== content) await writeFile(target.absolute, next);
  }

  return checkTemplateFragments(project);
}

/** Render a stable human-readable summary naming every problem's exact path. */
export function formatTemplateFragmentCheck(result: TemplateFragmentCheckResult): string {
  const lines = [
    `Template fragments: ${result.valid ? 'ok' : 'FAILED'}`,
    `fragments: ${result.fragmentCount}, occurrences: ${result.occurrenceCount}, targets: ${result.targetCount}`
  ];
  if (result.fragments.length > 0) lines.push(`names: ${result.fragments.join(', ')}`);
  for (const issue of result.problems) lines.push(`${issue.kind}: ${issue.message}`);
  return lines.join('\n');
}
