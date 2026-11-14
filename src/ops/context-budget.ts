import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ContextBudgetFile {
  path: string;
  code_points: number;
  baseline_code_points?: number;
  delta?: number;
}

export interface ContextBudgetGroup {
  id: string;
  code_points: number;
  baseline_code_points?: number;
  delta?: number;
  files: ContextBudgetFile[];
}

export interface ContextBudgetReport {
  groups: ContextBudgetGroup[];
}

export interface ContextBudgetOptions {
  baseline?: string;
}

const CONTRACT = '.ai-workflow/AGENTS.md';
const MEMORY = 'MEMORY.md';
const CODING_SKILL = 'templates/skills/coding/SKILL.md';
const REVIEW_REFERENCE = 'templates/skills/coding/references/review.md';
const WORKSPACE_REFERENCE = 'templates/skills/coding/references/workspace.md';
const SPEC_REVIEW_AGENT = 'templates/agents/spec-review.md';
const STANDARDS_REVIEW_AGENT = 'templates/agents/standards-review.md';
const OTHER_ROLES = ['backend', 'frontend', 'test', 'file-explorer', 'researcher', 'documentation-maintainer', 'git-operator'] as const;

function agentFile(role: string): string {
  return `templates/agents/${role}.md`;
}

const GROUP_FILES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['primary', [CONTRACT, MEMORY, CODING_SKILL, REVIEW_REFERENCE, WORKSPACE_REFERENCE]],
  ['spec-review', [CONTRACT, SPEC_REVIEW_AGENT]],
  ['standards-review', [CONTRACT, MEMORY, STANDARDS_REVIEW_AGENT]],
  ...OTHER_ROLES.map((role) => [role, [CONTRACT, MEMORY, agentFile(role)]] as const)
];

function codePointCount(value: string): number {
  // Count Unicode code points deliberately; grapheme clusters would not be deterministic here.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return [...value].length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

function parseBaseline(contents: string): ContextBudgetReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.groups)) return null;
  const groups: ContextBudgetGroup[] = [];
  for (const group of parsed.groups) {
    if (!isRecord(group) || typeof group.id !== 'string' || !isCount(group.code_points) || !Array.isArray(group.files)) return null;
    const files: ContextBudgetFile[] = [];
    for (const file of group.files) {
      if (!isRecord(file) || typeof file.path !== 'string' || !isCount(file.code_points)) return null;
      files.push({ path: file.path, code_points: file.code_points });
    }
    groups.push({ id: group.id, code_points: group.code_points, files });
  }
  return { groups };
}

async function readBaseline(path: string): Promise<ContextBudgetReport> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Context budget baseline is not readable: ${path}`);
  }
  const report = parseBaseline(contents);
  if (report === null) throw new Error(`Context budget baseline is malformed: ${path}`);
  return report;
}

function baselineMatches(report: ContextBudgetReport, baseline: ContextBudgetReport): boolean {
  const ids = sortedStrings(report.groups.map((group) => group.id));
  const baselineIds = sortedStrings(baseline.groups.map((group) => group.id));
  if (!sameStrings(ids, baselineIds)) return false;
  return report.groups.every((group) => {
    const baseGroup = baseline.groups.find((candidate) => candidate.id === group.id);
    if (baseGroup === undefined) return false;
    return sameStrings(sortedStrings(group.files.map((file) => file.path)), sortedStrings(baseGroup.files.map((file) => file.path)));
  });
}

/** Count fixed context groups in Unicode code points and optionally attach baseline deltas. */
export async function computeContextBudget(project: string, options: ContextBudgetOptions = {}): Promise<ContextBudgetReport> {
  const counts = new Map<string, number>();
  const count = async (path: string): Promise<number> => {
    const cached = counts.get(path);
    if (cached !== undefined) return cached;
    const value = codePointCount(await readFile(join(project, path), 'utf8'));
    counts.set(path, value);
    return value;
  };

  const groups: ContextBudgetGroup[] = [];
  for (const [id, paths] of [...GROUP_FILES].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))) {
    const files: ContextBudgetFile[] = [];
    for (const path of paths) files.push({ path, code_points: await count(path) });
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    groups.push({ id, code_points: files.reduce((total, file) => total + file.code_points, 0), files });
  }
  const report: ContextBudgetReport = { groups };

  if (options.baseline === undefined) return report;
  const baseline = await readBaseline(options.baseline);
  if (!baselineMatches(report, baseline)) throw new Error(`Context budget baseline is malformed: ${options.baseline}`);

  for (const group of report.groups) {
    const baseGroup = baseline.groups.find((candidate) => candidate.id === group.id);
    if (baseGroup === undefined) throw new Error(`Context budget baseline is malformed: ${options.baseline}`);
    group.baseline_code_points = baseGroup.code_points;
    group.delta = group.code_points - baseGroup.code_points;
    for (const file of group.files) {
      const baseFile = baseGroup.files.find((candidate) => candidate.path === file.path);
      if (baseFile === undefined) throw new Error(`Context budget baseline is malformed: ${options.baseline}`);
      file.baseline_code_points = baseFile.code_points;
      file.delta = file.code_points - baseFile.code_points;
    }
  }
  return report;
}
