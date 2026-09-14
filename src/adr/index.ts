import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists } from '../utils/fs.js';
import { resolveProjectRoot } from '../context/paths.js';

const adrRelative = '.ai-workflow/adr';
const adrFilePattern = /^(\d{4})-.+\.md$/;
const empty = '-';

export interface AdrEntry {
  number: string;
  status: string;
  date: string;
  supersedes: string;
  supersededBy: string;
  summary: string;
}

function adrDirectory(project: string): string {
  return join(resolveProjectRoot(project), adrRelative);
}

function headerField(header: string, name: string): string {
  const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(header);
  return match?.[1]?.trim() ?? '';
}

function cell(value: string): string {
  return value ? value.replace(/\|/g, '\\|') : empty;
}

export async function readAdrEntries(project: string): Promise<AdrEntry[]> {
  const directory = adrDirectory(project);
  if (!(await exists(directory))) return [];
  const entries: AdrEntry[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const match = adrFilePattern.exec(name);
    if (!match) continue;
    const source = await readFile(join(directory, name), 'utf8');
    const header = source.split(/\r?\n##[ \t]/)[0] ?? source;
    const status = headerField(header, 'Status');
    const [statusToken = '', supersededBy = ''] = status.split(/\s+/);
    entries.push({
      number: match[1] as string,
      status: statusToken,
      date: headerField(header, 'Date'),
      supersedes: headerField(header, 'Supersedes'),
      supersededBy: statusToken === 'superseded-by' ? supersededBy : '',
      summary: headerField(header, 'Summary')
    });
  }
  return entries.sort((left, right) => left.number.localeCompare(right.number));
}

export function renderAdrList(entries: AdrEntry[]): string {
  const rows = entries.map((entry) => `| ${entry.number} | ${cell(entry.status)} | ${cell(entry.date)} | ${cell(entry.supersedes)} | ${cell(entry.supersededBy)} | ${cell(entry.summary)} |`);
  return ['# ADR list', '', '| # | Status | Date | Supersedes | Superseded-by | Summary |', '| --- | --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}
