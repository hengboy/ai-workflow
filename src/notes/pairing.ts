import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const notesRoot = '.ai-workflow/notes';
export const pairMetaSuffix = '.i18n.yaml';
export const zhSuffix = '.zh.md';

export function englishPathOf(notePath: string): string {
  return notePath.endsWith(zhSuffix) ? notePath.slice(0, -zhSuffix.length).concat('.md')
    : notePath.endsWith(pairMetaSuffix) ? notePath.slice(0, -pairMetaSuffix.length).concat('.md')
      : notePath;
}

export function zhPathOf(englishPath: string): string {
  return englishPath.replace(/\.md$/, zhSuffix);
}

export function metaPathOf(englishPath: string): string {
  return englishPath.replace(/\.md$/, pairMetaSuffix);
}

export function pairAnchorOfArgument(argument: string): string {
  const normalized = argument.split('\\').join('/').replace(/^\.\//, '');
  if (normalized.endsWith(zhSuffix)) return `${normalized.slice(0, -zhSuffix.length)}.md`;
  if (normalized.endsWith(pairMetaSuffix)) return `${normalized.slice(0, -pairMetaSuffix.length)}.md`;
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

export function blobHash(content: string | Buffer): string {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const hash = createHash('sha1');
  hash.update(`blob ${buffer.byteLength}\0`);
  hash.update(buffer);
  return hash.digest('hex');
}

const pairMetaLine = /^([^:#]+\.md): ([0-9a-f]{40})$/;

export function parsePairMeta(content: string): Map<string, string> | undefined {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = pairMetaLine.exec(line);
    if (!match?.[1] || !match[2]) return undefined;
    if (entries.has(match[1])) return undefined;
    entries.set(match[1], match[2]);
  }
  return entries;
}

export function renderPairMeta(englishPath: string, englishHash: string, zhHash: string): string {
  const english = basename(englishPath);
  const zh = basename(zhPathOf(englishPath));
  return [
    '# Bilingual-pair consistency record (.ai-workflow/notes/README.md): the git blob hash of each',
    '# side as of the last confirmed-consistent state. Both languages carry equal authority;',
    '# after editing either side, bring the other along and re-record with:',
    `# ai-workflow notes pairing --project <project-root> --write ${englishPath}`,
    `${english}: ${englishHash}`,
    `${zh}: ${zhHash}`,
    '',
  ].join('\n');
}

export function englishSwitcher(englishPath: string): string {
  return `English | [中文](${basename(zhPathOf(englishPath))})`;
}

export function chineseSwitcher(englishPath: string): string {
  return `[English](${basename(englishPath)}) | 中文`;
}

export interface NoteStructureSignature {
  headings: number[];
  code: string[];
  tables: string[];
  lists: string[];
  links: string[];
}

function listItem(line: string): RegExpExecArray | null {
  return /^(\s*)([-*+]|\d{1,9}[.)])\s+/.exec(line);
}

function tableCells(line: string): string[] | undefined {
  if (!line.includes('|')) return undefined;
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') && !trimmed.endsWith('|') && !trimmed.includes('|')) return undefined;
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function isTableDelimiter(line: string, columns: number): boolean {
  const cells = tableCells(line);
  if (!cells || cells.length !== columns) return false;
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function normalizeTarget(target: string, counterpart: string): string | undefined {
  const cleaned = target.replace(/^</, '').replace(/>$/, '');
  const [path, suffix] = splitFragment(cleaned);
  if (basename(path) === counterpart) return undefined;
  const normalized = path.endsWith(zhSuffix) ? `${path.slice(0, -zhSuffix.length)}.md` : path;
  return `${normalized}${suffix}`;
}

function splitFragment(target: string): [string, string] {
  const index = target.search(/[?#]/);
  return index === -1 ? [target, ''] : [target.slice(0, index), target.slice(index)];
}

export function noteStructureSignature(markdown: string, counterpartBasename: string): NoteStructureSignature {
  const lines = markdown.split(/\r?\n/);
  const signature: NoteStructureSignature = { headings: [], code: [], tables: [], lists: [], links: [] };
  let fence: string | undefined;
  let fenceInfo = '';
  let code: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker?.[1] && marker[1][0] === fence[0] && marker[1].length >= fence.length && !(marker[2] ?? '').trim()) {
        signature.code.push(`${fenceInfo}\n${code.join('\n')}`);
        fence = undefined;
        fenceInfo = '';
        code = [];
      } else {
        code.push(line);
      }
      continue;
    }
    if (marker?.[1]) {
      fence = marker[1];
      fenceInfo = (marker[2] ?? '').trim();
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s/.exec(line);
    if (heading?.[1]) {
      signature.headings.push(heading[1].length);
      continue;
    }
    const cells = tableCells(line);
    if (cells && isTableDelimiter(lines[index + 1] ?? '', cells.length)) {
      index = collectTable(lines, index, cells.length, signature.tables);
      continue;
    }
    if (listItem(line)) {
      index = collectList(lines, index, signature.lists);
      continue;
    }
    for (const match of line.matchAll(/(?<!!)\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g)) {
      const target = match[1] ? normalizeTarget(match[1], counterpartBasename) : undefined;
      if (target !== undefined) signature.links.push(target);
    }
  }
  return signature;
}

function collectTable(lines: string[], start: number, columns: number, tables: string[]): number {
  let rows = 1;
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || !line.includes('|')) break;
    rows += 1;
    index += 1;
  }
  tables.push(`${rows}x${columns}`);
  return index - 1;
}

function collectList(lines: string[], start: number, lists: string[]): number {
  const first = listItem(lines[start] ?? '');
  const baseIndent = first?.[1]?.length ?? 0;
  const ordered = first ? /^\d/.test(first[2] ?? '') : false;
  const orderedStart = ordered ? Number.parseInt((first?.[2] ?? '1').replace(/[.)]$/, ''), 10) : 1;
  let items = 0;
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') { index += 1; continue; }
    const item = listItem(line);
    if (!item) {
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (indent <= baseIndent) break;
      index += 1;
      continue;
    }
    if ((item[1]?.length ?? 0) === baseIndent) items += 1;
    index += 1;
  }
  lists.push(ordered ? `ordered:start=${Number.isFinite(orderedStart) ? orderedStart : 1}:items=${items}` : `bullet:items=${items}`);
  return index - 1;
}

function show(value: string | number | undefined): string {
  if (value === undefined) return 'nothing';
  const text = JSON.stringify(value);
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

export function structureDiff(english: NoteStructureSignature, chinese: NoteStructureSignature): string[] {
  const differences: string[] = [];
  const fields: [string, (string | number)[], (string | number)[]][] = [
    ['heading (depth)', english.headings, chinese.headings],
    ['code block', english.code, chinese.code],
    ['table (row x column count)', english.tables, chinese.tables],
    ['list (kind, start, item count)', english.lists, chinese.lists],
    ['link target', english.links, chinese.links],
  ];
  for (const [field, sourceValues, zhValues] of fields) {
    const length = Math.max(sourceValues.length, zhValues.length);
    for (let index = 0; index < length; index += 1) {
      if (sourceValues[index] !== zhValues[index]) {
        differences.push(`${field} #${index + 1} diverges between the pair: ${show(sourceValues[index])} vs ${show(zhValues[index])}`);
        break;
      }
    }
  }
  return differences;
}
