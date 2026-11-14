import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { computeContextBudget } from '../../src/ops/context-budget.js';
import { changedPaths, snapshotTree, temporary } from '../helpers.js';

/**
 * Context budget public contract:
 *
 *   computeContextBudget(project: string, options?: { baseline?: string }): Promise<{
 *     groups: Array<{
 *       id: string;                 // sorted group ids
 *       code_points: number;
 *       baseline_code_points?: number;
 *       delta?: number;
 *       files: Array<{ path: string; code_points: number; baseline_code_points?: number; delta?: number }>;
 *     }>;
 *   }>
 *
 * Groups: `primary` (contract, MEMORY.md, coding skill, review and workspace references),
 * `spec-review` (contract and its agent, never MEMORY.md), `standards-review` (contract,
 * MEMORY.md and its agent), and one group per other role agent (contract, MEMORY.md and
 * that agent). Counts are Unicode code points, never UTF-16 units or bytes.
 * Groups and files are sorted; `--json` prints this structure. A baseline is the same
 * structure. A missing or unreadable baseline throws
 * `Context budget baseline is not readable: <path>`; malformed JSON or shape throws
 * `Context budget baseline is malformed: <path>`. Nothing is written.
 */

const execFileAsync = promisify(execFile);
const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const CONTRACT = '.ai-workflow/AGENTS.md';
const MEMORY = 'MEMORY.md';
const CODING_SKILL = 'templates/skills/coding/SKILL.md';
const REVIEW_REFERENCE = 'templates/skills/coding/references/review.md';
const WORKSPACE_REFERENCE = 'templates/skills/coding/references/workspace.md';
const SPEC_REVIEW_AGENT = 'templates/agents/spec-review.md';
const STANDARDS_REVIEW_AGENT = 'templates/agents/standards-review.md';
const OTHER_ROLES = ['backend', 'frontend', 'test', 'file-explorer', 'researcher', 'documentation-maintainer', 'git-operator'] as const;

const FILES: ReadonlyArray<readonly [string, string]> = [
  [CONTRACT, 'contract 😀\n'],
  [MEMORY, 'memory\n'],
  [CODING_SKILL, 'coding skill\n'],
  [REVIEW_REFERENCE, 'review reference\n'],
  [WORKSPACE_REFERENCE, 'workspace reference\n'],
  [SPEC_REVIEW_AGENT, 'spec review agent\n'],
  [STANDARDS_REVIEW_AGENT, 'standards review agent\n'],
  [join('templates/agents', 'backend.md'), 'backend agent\n'],
  [join('templates/agents', 'frontend.md'), 'frontend agent\n'],
  [join('templates/agents', 'test.md'), 'test agent\n'],
  [join('templates/agents', 'file-explorer.md'), 'file explorer agent\n'],
  [join('templates/agents', 'researcher.md'), 'researcher agent\n'],
  [join('templates/agents', 'documentation-maintainer.md'), 'documentation maintainer agent\n'],
  [join('templates/agents', 'git-operator.md'), 'git operator agent\n'],
];

const GROUP_FILES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['primary', [CONTRACT, MEMORY, CODING_SKILL, REVIEW_REFERENCE, WORKSPACE_REFERENCE]],
  ['spec-review', [CONTRACT, SPEC_REVIEW_AGENT]],
  ['standards-review', [CONTRACT, MEMORY, STANDARDS_REVIEW_AGENT]],
  ...OTHER_ROLES.map((role) => [role, [CONTRACT, MEMORY, join('templates/agents', `${role}.md`)]] as const),
];

interface BudgetFile {
  path: string;
  code_points: number;
  baseline_code_points?: number;
  delta?: number;
}

interface BudgetGroup {
  id: string;
  code_points: number;
  baseline_code_points?: number;
  delta?: number;
  files: readonly BudgetFile[];
}

interface BudgetReport {
  groups: readonly BudgetGroup[];
}

function agentFile(role: string): string {
  return join('templates/agents', `${role}.md`);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function contentOf(path: string): string {
  const entry = FILES.find(([candidate]) => candidate === path);
  if (!entry) throw new Error(`Fixture does not define ${path}`);
  return entry[1];
}

function expectedGroupFiles(id: string): readonly string[] {
  const entry = GROUP_FILES.find(([candidate]) => candidate === id);
  if (!entry) throw new Error(`Fixture does not define group ${id}`);
  return entry[1];
}

async function budgetFixture(): Promise<string> {
  const root = await temporary('ai-workflow-context-budget-');
  temporaries.push(root);
  for (const [path, contents] of FILES) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

function groupOf(report: BudgetReport, id: string): BudgetGroup {
  const group = report.groups.find((candidate) => candidate.id === id);
  if (!group) throw new Error(`Missing budget group ${id}`);
  return group;
}

function fileOf(group: BudgetGroup, path: string): BudgetFile {
  const file = group.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing budget file ${path}`);
  return file;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected the promise to reject');
}

interface ExecFailure {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

function execFailure(error: unknown): ExecFailure {
  const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return {
    code: typeof value.code === 'number' ? value.code : undefined,
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
  };
}

function packageScripts(): Promise<Record<string, string>> {
  return readFile(join(process.cwd(), 'package.json'), 'utf8').then((contents) => {
    const parsed = JSON.parse(contents) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  });
}

describe('computeContextBudget', () => {
  it('counts Unicode code points deterministically for every fixed group', async () => {
    const root = await budgetFixture();
    const first = await computeContextBudget(root);
    const second = await computeContextBudget(root);

    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);

    const ids = first.groups.map((group) => group.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(GROUP_FILES.map(([id]) => id).sort());

    expect(contentOf(CONTRACT).length).toBe(codePointLength(contentOf(CONTRACT)) + 1);

    for (const [id] of GROUP_FILES) {
      const group = groupOf(first, id);
      const files = expectedGroupFiles(id);
      expect(group.files.map((file) => file.path)).toEqual([...files].sort());
      expect(group.code_points).toBe(files.reduce((total, path) => total + codePointLength(contentOf(path)), 0));
      for (const file of group.files) {
        expect(file.code_points).toBe(codePointLength(contentOf(file.path)));
      }
    }

    expect(groupOf(first, 'primary').files.map((file) => file.path)).toEqual([CONTRACT, MEMORY, CODING_SKILL, REVIEW_REFERENCE, WORKSPACE_REFERENCE].sort());
    expect(groupOf(first, 'spec-review').files.map((file) => file.path)).toEqual([CONTRACT, SPEC_REVIEW_AGENT].sort());
    expect(groupOf(first, 'spec-review').files.map((file) => file.path)).not.toContain(MEMORY);
    expect(groupOf(first, 'standards-review').files.map((file) => file.path)).toEqual([CONTRACT, MEMORY, STANDARDS_REVIEW_AGENT].sort());
    for (const role of OTHER_ROLES) {
      expect(groupOf(first, role).files.map((file) => file.path)).toEqual([CONTRACT, MEMORY, agentFile(role)].sort());
    }
  });

  it('reads the JSON structure as a baseline and adds per-group and per-file deltas', async () => {
    const root = await budgetFixture();
    const baselineDirectory = await temporary('ai-workflow-context-baseline-');
    temporaries.push(baselineDirectory);
    const baselinePath = join(baselineDirectory, 'baseline.json');
    const before = await computeContextBudget(root);
    await writeFile(baselinePath, `${JSON.stringify(before, null, 2)}\n`);

    const backendAgent = agentFile('backend');
    await writeFile(join(root, backendAgent), `${contentOf(backendAgent)}X`);

    const after = await computeContextBudget(root, { baseline: baselinePath });

    expect(groupOf(after, 'primary').delta).toBe(0);
    expect(groupOf(after, 'spec-review').delta).toBe(0);
    const backend = groupOf(after, 'backend');
    expect(backend.baseline_code_points).toBe(groupOf(before, 'backend').code_points);
    expect(backend.code_points).toBe(groupOf(before, 'backend').code_points + 1);
    expect(backend.delta).toBe(1);

    const changed = fileOf(backend, backendAgent);
    expect(changed.baseline_code_points).toBe(codePointLength(contentOf(backendAgent)));
    expect(changed.code_points).toBe(codePointLength(contentOf(backendAgent)) + 1);
    expect(changed.delta).toBe(1);
    expect(fileOf(backend, CONTRACT).delta).toBe(0);

    for (const group of after.groups) {
      expect(typeof group.delta).toBe('number');
      expect(typeof group.baseline_code_points).toBe('number');
      for (const file of group.files) {
        expect(typeof file.delta).toBe('number');
        expect(typeof file.baseline_code_points).toBe('number');
      }
    }
  });

  it('rejects a missing baseline with the exact unreadable error and writes no file', async () => {
    const root = await budgetFixture();
    const baselineDirectory = await temporary('ai-workflow-context-baseline-');
    temporaries.push(baselineDirectory);
    const missing = join(baselineDirectory, 'missing.json');
    const before = await snapshotTree(root);

    const error = await rejection(computeContextBudget(root, { baseline: missing }));
    expect(error.message).toBe(`Context budget baseline is not readable: ${missing}`);

    const after = await snapshotTree(root);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('rejects malformed JSON and a malformed baseline shape with the exact error', async () => {
    const root = await budgetFixture();
    const baselineDirectory = await temporary('ai-workflow-context-baseline-');
    temporaries.push(baselineDirectory);
    const before = await snapshotTree(root);

    const malformedJson = join(baselineDirectory, 'malformed.json');
    await writeFile(malformedJson, '{not json\n');
    const jsonError = await rejection(computeContextBudget(root, { baseline: malformedJson }));
    expect(jsonError.message).toBe(`Context budget baseline is malformed: ${malformedJson}`);

    const malformedShape = join(baselineDirectory, 'shape.json');
    await writeFile(malformedShape, '{"groups":"not an array"}\n');
    const shapeError = await rejection(computeContextBudget(root, { baseline: malformedShape }));
    expect(shapeError.message).toBe(`Context budget baseline is malformed: ${malformedShape}`);

    const after = await snapshotTree(root);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('exposes the declared package script and prints the sorted JSON structure', async () => {
    const scripts = await packageScripts();
    expect(scripts['context:budget']).toMatch(/context-budget/);

    const { stdout } = await execFileAsync('pnpm', ['run', '--silent', 'context:budget', '--', '--json'], { cwd: process.cwd(), timeout: 15_000 });
    const parsed = JSON.parse(stdout) as { groups: Array<{ id: string; files: Array<{ path: string }> }> };

    expect(parsed.groups.map((group) => group.id)).toEqual(parsed.groups.map((group) => group.id).sort());
    expect(parsed.groups.map((group) => group.id)).toEqual(['primary', 'spec-review', 'standards-review', ...OTHER_ROLES].sort());
    for (const group of parsed.groups) {
      expect(group.files.map((file) => file.path)).toEqual(group.files.map((file) => file.path).sort());
    }
  });

  it('prints an exact error and no deltas for a missing baseline at the package-script boundary', async () => {
    const baselineDirectory = await temporary('ai-workflow-context-baseline-');
    temporaries.push(baselineDirectory);
    const missing = join(baselineDirectory, 'missing.json');

    let failure: ExecFailure | undefined;
    try {
      await execFileAsync('pnpm', ['run', '--silent', 'context:budget', '--', '--baseline', missing], { cwd: process.cwd(), timeout: 15_000 });
    } catch (error) {
      failure = execFailure(error);
    }

    expect(failure).toBeDefined();
    expect(failure?.code).not.toBe(0);
    const output = `${failure?.stdout ?? ''}\n${failure?.stderr ?? ''}`;
    expect(output).toContain(`Context budget baseline is not readable: ${missing}`);
    expect(output).not.toMatch(/delta/i);
  });
});
