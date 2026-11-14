import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { packagePath } from '../../src/utils/schema.js';
import { changedPaths, snapshotTree, temporary } from '../helpers.js';

// CLI boundary: `ai-workflow review packet` prints one rendered packet on stdout or writes
// nothing to stdout and exits nonzero with a reason. Observable = exit code, stdout packet
// text and stderr reason only.

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const PREVIOUS = 'c'.repeat(40);

const SPEC_INITIAL = ['role', 'mode', 'purpose', 'repository', 'contract', 'requirements', 'requirement_scope', 'base_commit', 'head_commit', 'raw_diff', 'source_blobs', 'committed_tests', 'instruction'];
const SPEC_RECHECK = ['role', 'mode', 'purpose', 'repository', 'contract', 'requirements', 'requirement_scope', 'base_commit', 'previous_head', 'head_commit', 'raw_diff', 'repair_diff', 'repair_scope', 'source_blobs', 'committed_tests', 'instruction'];
const STANDARDS_INITIAL = ['role', 'mode', 'purpose', 'repository', 'contract', 'memory', 'note_standards', 'base_commit', 'head_commit', 'changed_paths', 'raw_diff', 'source_blobs', 'test_reports', 'instruction'];
const STANDARDS_RECHECK = ['role', 'mode', 'purpose', 'repository', 'contract', 'memory', 'note_standards', 'base_commit', 'previous_head', 'head_commit', 'original_findings', 'raw_diff', 'repair_diff', 'repair_scope', 'source_blobs', 'test_reports', 'instruction'];

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', [...cli, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function fieldNames(packet: string): string[] {
  return packet.split('\n').flatMap((line) => {
    const match = /^([a-z_]+): /.exec(line);
    return match ? [match[1] as string] : [];
  });
}

function field(packet: string, name: string): string {
  const line = packet.split('\n').find((entry) => entry.startsWith(`${name}: `));
  expect(line, `packet field ${name} is present`).toBeDefined();
  return (line as string).slice(name.length + 2);
}

async function templateInstruction(heading: string): Promise<string> {
  const reference = await readFile(packagePath('templates/skills/coding/references/review.md'), 'utf8');
  const start = reference.indexOf(`## ${heading}`);
  const fenceStart = reference.indexOf('```text', start);
  const bodyStart = reference.indexOf('\n', fenceStart) + 1;
  const bodyEnd = reference.indexOf('```', bodyStart);
  const body = reference.slice(bodyStart, bodyEnd);
  const line = body.split('\n').find((entry) => entry.startsWith('instruction: '));
  return line ? line.slice('instruction: '.length) : '';
}

interface Fixture {
  root: string;
  repository: string;
  contract: string;
  memory: string;
  noteStandards: string[];
  requirements: string[];
  rawDiff: string;
  repairDiff: string;
  sourceBlobs: string[];
  committedTests: string[];
  changedPaths: string[];
  testReports: string[];
  repairScope: string[];
}

async function evidenceFixture(): Promise<Fixture> {
  const root = await temporary('ai-workflow-review-packet-cli-');
  const repository = join(root, 'repository');
  const files: Record<string, string> = {
    '.ai-workflow/AGENTS.md': '# contract\n',
    'MEMORY.md': '# memory\n',
    'references/note-standards.md': '# note standards\n',
    'requirements/spec.md': '# specification\n',
    'evidence/raw.diff': 'diff --git a/one b/one\n',
    'evidence/repair.diff': 'diff --git a/two b/two\n',
    'evidence/report.txt': 'command: pnpm test; exit: 0\n',
    'repository/src/cli.ts': 'export const cli = true;\n',
    'repository/tests/review.test.ts': 'export const test = true;\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return {
    root,
    repository,
    contract: join(root, '.ai-workflow/AGENTS.md'),
    memory: join(root, 'MEMORY.md'),
    noteStandards: [join(root, 'references/note-standards.md')],
    requirements: [join(root, 'requirements/spec.md')],
    rawDiff: join(root, 'evidence/raw.diff'),
    repairDiff: join(root, 'evidence/repair.diff'),
    sourceBlobs: [join(repository, 'src/cli.ts')],
    committedTests: [join(repository, 'tests/review.test.ts')],
    changedPaths: ['src/cli.ts', 'tests/review.test.ts'],
    testReports: [join(root, 'evidence/report.txt')],
    repairScope: ['src/cli.ts'],
  };
}

interface ArgsSpec {
  axis: string;
  mode: string;
  purpose: string;
  repository: string;
  contract: string;
  base: string;
  head: string;
  previousHead?: string;
  requirements?: string[];
  requirementScope?: string[];
  rawDiff?: string;
  repairDiff?: string;
  repairScope?: string[];
  sourceBlobs?: string[];
  committedTests?: string[];
  changedPaths?: string[];
  testReports?: string[];
  memory?: string;
  noteStandards?: string[];
  originalFindings?: string[];
  evidenceDir?: string;
}

function packetArgs(spec: ArgsSpec): string[] {
  const args = ['review', 'packet', '--axis', spec.axis, '--mode', spec.mode, '--purpose', spec.purpose, '--repository', spec.repository, '--contract', spec.contract, '--base', spec.base, '--head', spec.head];
  if (spec.previousHead !== undefined) args.push('--previous-head', spec.previousHead);
  if (spec.requirements) args.push('--requirements', ...spec.requirements);
  if (spec.requirementScope) args.push('--requirement-scope', ...spec.requirementScope);
  if (spec.rawDiff !== undefined) args.push('--raw-diff', spec.rawDiff);
  if (spec.repairDiff !== undefined) args.push('--repair-diff', spec.repairDiff);
  if (spec.repairScope) args.push('--repair-scope', ...spec.repairScope);
  if (spec.sourceBlobs) args.push('--source-blobs', ...spec.sourceBlobs);
  if (spec.committedTests) args.push('--committed-tests', ...spec.committedTests);
  if (spec.changedPaths) args.push('--changed-paths', ...spec.changedPaths);
  if (spec.testReports) args.push('--test-reports', ...spec.testReports);
  if (spec.memory !== undefined) args.push('--memory', spec.memory);
  if (spec.noteStandards) args.push('--note-standards', ...spec.noteStandards);
  if (spec.originalFindings) args.push('--original-findings', ...spec.originalFindings);
  if (spec.evidenceDir !== undefined) args.push('--evidence-dir', spec.evidenceDir);
  return args;
}

function specInitialSpec(fixture: Fixture): ArgsSpec {
  return {
    axis: 'spec', mode: 'initial', purpose: 'delivery',
    repository: fixture.repository, contract: fixture.contract,
    base: BASE, head: HEAD,
    requirements: fixture.requirements,
    requirementScope: ['REQ-005', 'AC-006'],
    rawDiff: fixture.rawDiff,
    sourceBlobs: fixture.sourceBlobs,
    committedTests: fixture.committedTests,
  };
}

function specRecheckSpec(fixture: Fixture): ArgsSpec {
  return {
    ...specInitialSpec(fixture),
    mode: 'recheck',
    previousHead: PREVIOUS,
    repairDiff: fixture.repairDiff,
    repairScope: fixture.repairScope,
  };
}

function standardsInitialSpec(fixture: Fixture): ArgsSpec {
  return {
    axis: 'standards', mode: 'initial', purpose: 'delivery',
    repository: fixture.repository, contract: fixture.contract,
    memory: fixture.memory,
    noteStandards: fixture.noteStandards,
    base: BASE, head: HEAD,
    changedPaths: fixture.changedPaths,
    rawDiff: fixture.rawDiff,
    sourceBlobs: fixture.sourceBlobs,
    testReports: fixture.testReports,
  };
}

function standardsRecheckSpec(fixture: Fixture): ArgsSpec {
  return {
    ...standardsInitialSpec(fixture),
    mode: 'recheck',
    previousHead: PREVIOUS,
    originalFindings: ['logic: first finding'],
    repairDiff: fixture.repairDiff,
    repairScope: fixture.repairScope,
  };
}

const SUCCESS_CASES: Array<{ name: string; expected: string[]; template: string; spec: (fixture: Fixture) => ArgsSpec }> = [
  { name: 'Spec initial', expected: SPEC_INITIAL, template: 'Spec initial', spec: specInitialSpec },
  { name: 'Spec recheck', expected: SPEC_RECHECK, template: 'Spec recheck', spec: specRecheckSpec },
  { name: 'Standards initial', expected: STANDARDS_INITIAL, template: 'Standards initial', spec: standardsInitialSpec },
  { name: 'Standards recheck', expected: STANDARDS_RECHECK, template: 'Standards recheck', spec: standardsRecheckSpec },
];

describe('ai-workflow review packet', () => {
  it.each(SUCCESS_CASES)('prints the $name packet with the template field order and instruction line', async ({ expected, template, spec }) => {
    const fixture = await evidenceFixture();
    const result = await runCli(packetArgs(spec(fixture)));

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(fieldNames(result.stdout)).toEqual(expected);
    expect(field(result.stdout, 'instruction')).toBe(await templateInstruction(template));
    expect(result.stdout).not.toMatch(/<[^>]+>/);
  });

  it('prints recheck-only fields for a recheck and omits them for an initial packet', async () => {
    const fixture = await evidenceFixture();
    const initial = await runCli(packetArgs(specInitialSpec(fixture)));
    const recheck = await runCli(packetArgs(specRecheckSpec(fixture)));

    expect(initial.code).toBe(0);
    expect(fieldNames(initial.stdout)).not.toContain('previous_head');
    expect(fieldNames(initial.stdout)).not.toContain('repair_diff');
    expect(fieldNames(initial.stdout)).not.toContain('repair_scope');

    expect(recheck.code).toBe(0);
    expect(field(recheck.stdout, 'previous_head')).toBe(PREVIOUS);
    expect(field(recheck.stdout, 'repair_diff')).toBe(fixture.repairDiff);
    expect(fieldNames(recheck.stdout)).toContain('repair_scope');
  });

  it('prints a Spec packet without plan, task, MEMORY or implementation narrative content', async () => {
    const fixture = await evidenceFixture();
    const result = await runCli(packetArgs(specRecheckSpec(fixture)));

    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/\bplan\b/i);
    expect(result.stdout).not.toMatch(/\btasks?\b/i);
    expect(result.stdout).not.toMatch(/\bMEMORY\b/);
    expect(result.stdout).not.toMatch(/implementation narrative/i);
  });

  it('resolves relative evidence paths only when --evidence-dir is supplied', async () => {
    const fixture = await evidenceFixture();
    const spec: ArgsSpec = {
      ...specInitialSpec(fixture),
      rawDiff: 'evidence/raw.diff',
      requirements: ['requirements/spec.md'],
      evidenceDir: fixture.root,
    };
    const result = await runCli(packetArgs(spec));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(fixture.rawDiff);
    expect(result.stdout).toContain(fixture.requirements[0] as string);
  });

  it('writes nothing around a successful run', async () => {
    const fixture = await evidenceFixture();
    const before = await snapshotTree(fixture.root);
    const result = await runCli(packetArgs(specInitialSpec(fixture)));
    const after = await snapshotTree(fixture.root);

    expect(result.code).toBe(0);
    expect(changedPaths(before, after)).toEqual([]);
  });

  const ERROR_CASES: Array<{ name: string; spec: (fixture: Fixture) => ArgsSpec; reason: RegExp }> = [
    { name: 'a short SHA', spec: (fixture) => ({ ...specInitialSpec(fixture), base: 'abc1234' }), reason: /base|sha|hex/i },
    { name: 'a non-hex SHA', spec: (fixture) => ({ ...specInitialSpec(fixture), head: 'z'.repeat(40) }), reason: /head|sha|hex/i },
    {
      name: 'a recheck without --previous-head',
      spec: (fixture) => {
        const spec = specRecheckSpec(fixture);
        delete spec.previousHead;
        return spec;
      },
      reason: /previous/i,
    },
    {
      name: 'a missing required field',
      spec: (fixture) => {
        const spec = specInitialSpec(fixture);
        delete spec.rawDiff;
        return spec;
      },
      reason: /raw.?diff|required|missing/i,
    },
    { name: 'a Spec option belonging to Standards', spec: (fixture) => ({ ...specInitialSpec(fixture), memory: fixture.memory }), reason: /memory|standards|axis|option|unexpected/i },
    { name: 'a Spec test-report option', spec: (fixture) => ({ ...specInitialSpec(fixture), testReports: fixture.testReports }), reason: /test|report|standards|axis|option|unexpected/i },
    { name: 'a Spec narrative option', spec: (fixture) => ({ ...specInitialSpec(fixture), originalFindings: ['logic: first finding'] }), reason: /finding|narrative|mode|axis|option|unexpected/i },
    { name: 'an unknown axis', spec: (fixture) => ({ ...specInitialSpec(fixture), axis: 'verdict' }), reason: /axis|spec|standards/i },
    { name: 'an unknown mode', spec: (fixture) => ({ ...specInitialSpec(fixture), mode: 'final' }), reason: /mode|initial|recheck/i },
    { name: 'an invalid enum value', spec: (fixture) => ({ ...specInitialSpec(fixture), purpose: 'review' }), reason: /purpose|delivery|finalization|invalid/i },
    { name: 'a relative --repository', spec: (fixture) => ({ ...specInitialSpec(fixture), repository: 'repository' }), reason: /repository|absolute/i },
    { name: 'a relative --contract', spec: (fixture) => ({ ...specInitialSpec(fixture), contract: 'AGENTS.md' }), reason: /contract|absolute/i },
    { name: 'a missing evidence file', spec: (fixture) => ({ ...specInitialSpec(fixture), rawDiff: join(fixture.root, 'evidence/missing.diff') }), reason: /missing|not found|exist|raw.?diff/i },
    { name: 'a relative evidence path without --evidence-dir', spec: (fixture) => ({ ...specInitialSpec(fixture), rawDiff: 'evidence/raw.diff' }), reason: /evidence-dir|absolute|relative/i },
  ];

  it.each(ERROR_CASES)('refuses $name with a nonzero exit, an empty stdout and a reason', async ({ spec, reason }) => {
    const fixture = await evidenceFixture();
    const result = await runCli(packetArgs(spec(fixture)));

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(reason);
  });
});
