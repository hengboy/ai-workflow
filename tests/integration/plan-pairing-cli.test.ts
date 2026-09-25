import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { blobHash, parsePairMeta } from '../../src/notes/pairing.js';
import { recordPlanPair, renderExecutionOrderYaml, temporary, writePlanTriplet } from '../helpers.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;
const PLAN_ID = '20260831-example';

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', [...cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[path.slice(directory.length + 1)] = (await readFile(path)).toString('base64');
    }
  };
  await walk(directory);
  return files;
}

function frozenAttributes(): Record<string, unknown> {
  return {
    plan_id: PLAN_ID,
    status: 'frozen',
    created_at: '2026-08-31T00:00:00.000Z',
    supersedes: null,
    requirement_count: 1,
    acceptance_criteria_count: 1,
    digest: 'sha256:placeholder',
  };
}

const frozenRenderer = (body: string): string => renderFrozenMarkdown(frozenAttributes(), body);

const SPEC_EN = [
  '# Specification',
  '',
  '## Goal',
  '',
  'Goal prose.',
  '',
  '```ts',
  'const value = 1;',
  '```',
  '',
  '| Column | Other |',
  '| --- | --- |',
  '| a | b |',
  '',
  '- first',
  '- second',
  '',
  'See [the plan](plan.md).',
  '',
  '## Requirements',
  '',
  '### REQ-001: Example requirement',
  '',
  'Requirement prose.',
  '',
  '## Acceptance criteria',
  '',
  '### AC-001: Example acceptance',
  '',
  'Acceptance prose.',
  '',
].join('\n');

const SPEC_ZH = [
  '# Specification',
  '',
  '## Goal',
  '',
  '目标正文。',
  '',
  '```ts',
  'const value = 1;',
  '```',
  '',
  '| Column | Other |',
  '| --- | --- |',
  '| 甲 | 乙 |',
  '',
  '- 第一',
  '- 第二',
  '',
  'See [the plan](plan.zh.md).',
  '',
  '## Requirements',
  '',
  '### REQ-001: Example requirement',
  '',
  '需求正文。',
  '',
  '## Acceptance criteria',
  '',
  '### AC-001: Example acceptance',
  '',
  '验收正文。',
  '',
].join('\n');

const PLAN_EN = [
  '# Implementation Plan',
  '',
  '## Requirement coverage',
  '',
  '| Requirement | Acceptance criteria | Implementation step |',
  '| --- | --- | --- |',
  '| REQ-001 | AC-001 | Step 1 |',
  '',
  '## Implementation sequence',
  '',
  '1. Implement REQ-001 and verify AC-001.',
  '',
].join('\n');

const PLAN_ZH = [
  '# Implementation Plan',
  '',
  '## Requirement coverage',
  '',
  '| Requirement | Acceptance criteria | Implementation step |',
  '| --- | --- | --- |',
  '| REQ-001 | AC-001 | 第一步 |',
  '',
  '## Implementation sequence',
  '',
  '1. 实现 REQ-001 并验证 AC-001。',
  '',
].join('\n');

const TASK_EN = ['# Task', '', '## Objective', '', 'Do the task.', ''].join('\n');
const TASK_ZH = ['# Task', '', '## Objective', '', '执行任务。', ''].join('\n');

function taskAttributes(): Record<string, unknown> {
  return {
    id: 'task-001-example',
    requirements: ['REQ-001'],
    acceptance_criteria: ['AC-001'],
    depends_on: [],
    surface: 'backend',
    read_scope: ['MEMORY.md', 'src/input.ts'],
    write_scope: ['src/output.ts'],
    test_commands: ['pnpm test'],
  };
}

async function completePlan(root: string, withTasks = false): Promise<string> {
  const directory = join(root, '.ai-workflow/plans', PLAN_ID);
  await mkdir(join(directory, 'tasks'), { recursive: true });
  await writePlanTriplet(directory, 'spec.md', SPEC_EN, SPEC_ZH, frozenRenderer);
  await writePlanTriplet(directory, 'plan.md', PLAN_EN, PLAN_ZH, frozenRenderer);
  if (withTasks) {
    await writePlanTriplet(join(directory, 'tasks'), 'task-001-example.md', TASK_EN, TASK_ZH, (body) => renderMarkdown(taskAttributes(), body));
    await writeFile(join(directory, 'tasks', 'execution-order.yaml'), renderExecutionOrderYaml(PLAN_ID, [['task-001-example']]));
  }
  return directory;
}

async function rewriteChinese(directory: string, englishBasename: string, mutate: (source: string) => string, record: boolean): Promise<void> {
  const path = join(directory, englishBasename.replace(/\.md$/, '.zh.md'));
  const source = await readFile(path, 'utf8');
  const mutated = mutate(source);
  expect(mutated, 'the mutation must change the Chinese source').not.toBe(source);
  await writeFile(path, mutated);
  if (record) await recordPlanPair(directory, englishBasename);
}

describe('plan pairing CLI', () => {
  it('validates a complete triplet with exit 0 and reports plan_id and digests', async () => {
    const root = await temporary('ai-workflow-plan-validate-');
    const directory = await completePlan(root, true);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; plan_id: string; digests: { spec: string; plan: string; combined: string } };
    expect(parsed.valid).toBe(true);
    expect(parsed.plan_id).toBe(PLAN_ID);
    for (const digest of [parsed.digests.spec, parsed.digests.plan, parsed.digests.combined]) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('fails plan validate for a stale recorded hash and locates the record', async () => {
    const root = await temporary('ai-workflow-plan-validate-stale-');
    const directory = await completePlan(root);
    await rewriteChinese(directory, 'spec.md', (source) => source.replace('目标正文。', '不同的目标正文。'), false);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    expect(outputOf(result)).toMatch(/spec\.i18n\.yaml/);
    expect(outputOf(result)).toMatch(/hash/i);
  });

  it('fails plan validate for an imprecise switcher and locates the document', async () => {
    const root = await temporary('ai-workflow-plan-validate-switcher-');
    const directory = await completePlan(root);
    await rewriteChinese(directory, 'spec.md', (source) => source.replace('[English](spec.md) | 中文', '[English](spec.md)|中文'), true);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    expect(outputOf(result)).toMatch(/language switcher/i);
    expect(outputOf(result)).toMatch(/spec/);
  });

  it('fails plan validate for a structure divergence and names the field', async () => {
    const root = await temporary('ai-workflow-plan-validate-structure-');
    const directory = await completePlan(root);
    await rewriteChinese(directory, 'spec.md', (source) => source.replace('## Goal', '#### Goal'), true);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    expect(outputOf(result)).toMatch(/heading \(depth\)/);
  });

  it('fails plan validate when a Chinese counterpart is missing', async () => {
    const root = await temporary('ai-workflow-plan-validate-no-zh-');
    const directory = await completePlan(root);
    await rm(join(directory, 'spec.zh.md'));

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    expect(outputOf(result)).toMatch(/spec\.zh\.md/);
    expect(outputOf(result)).toMatch(/missing/i);
  });

  it('fails plan validate when a consistency record is missing', async () => {
    const root = await temporary('ai-workflow-plan-validate-no-meta-');
    const directory = await completePlan(root);
    await rm(join(directory, 'spec.i18n.yaml'));

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    expect(outputOf(result)).toMatch(/spec\.i18n\.yaml/);
  });

  it('fails plan validate for an orphan task sidecar', async () => {
    const root = await temporary('ai-workflow-plan-validate-orphan-');
    const directory = await completePlan(root, true);
    await writeFile(join(directory, 'tasks', 'task-002-orphan.i18n.yaml'), `# orphan sidecar\ntask-002-orphan.md: ${blobHash('a')}\ntask-002-orphan.zh.md: ${blobHash('b')}\n`);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code).not.toBe(0);
    expect(outputOf(result)).toMatch(/task-002-orphan\.i18n\.yaml/);
    expect(outputOf(result)).toMatch(/no matching English document/i);
  });

  it('reports a complete triplet as valid from plan pairing with no flags', async () => {
    const root = await temporary('ai-workflow-plan-pairing-ok-');
    const directory = await completePlan(root, true);

    const result = await runCli(['plan', 'pairing', '--plan', directory]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ valid: true, errors: [] });
  });

  it('fails plan pairing with no flags on stale or missing docs without touching any file', async () => {
    const root = await temporary('ai-workflow-plan-pairing-bad-');
    const directory = await completePlan(root, true);
    await rewriteChinese(directory, 'spec.md', (source) => source.replace('目标正文。', '不同的目标正文。'), false);
    await rm(join(directory, 'plan.zh.md'));
    const before = await snapshot(directory);

    const result = await runCli(['plan', 'pairing', '--plan', directory]);

    expect(result.code).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; errors: string[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.join('\n')).toMatch(/spec\.i18n\.yaml/);
    expect(parsed.errors.join('\n')).toMatch(/plan\.zh\.md/);
    expect(await snapshot(directory)).toEqual(before);
  });

  it('lists every pair state and always exits 0', async () => {
    const root = await temporary('ai-workflow-plan-pairing-list-');
    const directory = await completePlan(root, true);
    await rm(join(directory, 'plan.zh.md'));
    await rewriteChinese(join(directory, 'tasks'), 'task-001-example.md', (source) => source.replace('执行任务。', '执行任务（更新）。'), false);

    const result = await runCli(['plan', 'pairing', '--plan', directory, '--list']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      entries: [
        { path: 'plan.md', state: 'missing' },
        { path: 'spec.md', state: 'ok' },
        { path: 'tasks/task-001-example.md', state: 'out-of-sync' },
      ],
    });
  });

  it.each(['spec.md', 'spec.zh.md', 'spec.i18n.yaml', 'spec'])('records a pair named by %s and leaves both document bytes unchanged', async (form) => {
    const root = await temporary('ai-workflow-plan-pairing-write-');
    const directory = await completePlan(root, true);
    await rm(join(directory, 'spec.i18n.yaml'));
    const englishBefore = await readFile(join(directory, 'spec.md'));
    const chineseBefore = await readFile(join(directory, 'spec.zh.md'));

    const result = await runCli(['plan', 'pairing', '--plan', directory, '--write', form]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ written: ['spec.md'] });
    expect(await readFile(join(directory, 'spec.md'))).toEqual(englishBefore);
    expect(await readFile(join(directory, 'spec.zh.md'))).toEqual(chineseBefore);
    const record = parsePairMeta(await readFile(join(directory, 'spec.i18n.yaml'), 'utf8'));
    expect(record?.get('spec.md')).toBe(blobHash(englishBefore));
    expect(record?.get('spec.zh.md')).toBe(blobHash(chineseBefore));
    const validated = await runCli(['plan', 'validate', '--plan', directory]);
    expect(validated.code).toBe(0);
  });

  it('rejects --write with no documents and no --all without writing anything', async () => {
    const root = await temporary('ai-workflow-plan-pairing-bare-');
    const directory = await completePlan(root);
    const before = await snapshot(directory);

    const result = await runCli(['plan', 'pairing', '--plan', directory, '--write']);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--write requires/);
    expect(await snapshot(directory)).toEqual(before);
  });

  it('prevalidates explicit selections and writes no record when one lacks its Chinese side', async () => {
    const root = await temporary('ai-workflow-plan-pairing-precheck-');
    const directory = await completePlan(root);
    await rm(join(directory, 'plan.zh.md'));
    await writeFile(join(directory, 'spec.i18n.yaml'), '# sentinel\n');
    await writeFile(join(directory, 'plan.i18n.yaml'), '# sentinel\n');
    const before = await snapshot(directory);

    const result = await runCli(['plan', 'pairing', '--plan', directory, '--write', 'spec.md', 'plan.md']);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Chinese counterpart/);
    expect(await snapshot(directory)).toEqual(before);
  });

  it('records only complete pairs with --write --all and skips the incomplete one', async () => {
    const root = await temporary('ai-workflow-plan-pairing-all-');
    const directory = await completePlan(root, true);
    await rm(join(directory, 'spec.i18n.yaml'));
    await rm(join(directory, 'plan.zh.md'));
    await writeFile(join(directory, 'plan.i18n.yaml'), '# sentinel\n');

    const result = await runCli(['plan', 'pairing', '--plan', directory, '--write', '--all']);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { written: string[] };
    expect(parsed.written).toContain('spec.md');
    expect(parsed.written).not.toContain('plan.md');
    expect(await readFile(join(directory, 'plan.i18n.yaml'), 'utf8')).toBe('# sentinel\n');
    const record = parsePairMeta(await readFile(join(directory, 'spec.i18n.yaml'), 'utf8'));
    expect(record?.get('spec.md')).toBe(blobHash(await readFile(join(directory, 'spec.md'))));
  });

  it('rejects --write selections that are not documented plan-document forms', async () => {
    const root = await temporary('ai-workflow-plan-pairing-invalid-');
    const directory = await completePlan(root);
    const before = await snapshot(directory);

    const extension = await runCli(['plan', 'pairing', '--plan', directory, '--write', 'spec.txt']);
    const nested = await runCli(['plan', 'pairing', '--plan', directory, '--write', 'notes/spec.md']);

    expect(extension.code).not.toBe(0);
    expect(nested.code).not.toBe(0);
    expect(await snapshot(directory)).toEqual(before);
  });

  it('rejects --all without --write before doing anything', async () => {
    const root = await temporary('ai-workflow-plan-pairing-args-');
    const directory = await completePlan(root);
    const before = await snapshot(directory);

    const result = await runCli(['plan', 'pairing', '--plan', directory, '--all']);

    expect(result.code).not.toBe(0);
    expect(await snapshot(directory)).toEqual(before);
  });

  // Review finding W1 (warning): REQ-004 requires project-relative paths in errors,
  // but the CLI resolves --plan to an absolute path before reporting. A user-supplied
  // relative --plan must be preserved verbatim in the failure output.
  it('preserves a user-supplied relative --plan path in validate errors', async () => {
    const root = await temporary('ai-workflow-plan-relative-');
    const directory = await completePlan(root);
    await rm(join(directory, 'spec.zh.md'));
    const relativeDirectory = relative(process.cwd(), directory);
    expect(relativeDirectory.startsWith('/'), 'the relative --plan value must not be absolute').toBe(false);

    const result = await runCli(['plan', 'validate', '--plan', relativeDirectory]);

    expect(result.code).not.toBe(0);
    const output = outputOf(result);
    expect(output, 'the error must name the relative document path').toContain(join(relativeDirectory, 'spec.zh.md'));
    const prefix = 'ai-workflow: ';
    const reported = output.slice(output.indexOf(prefix) + prefix.length);
    const reportedPath = reported.slice(0, reported.indexOf(': '));
    expect(reportedPath.startsWith('/'), 'the reported document path must not be absolute').toBe(false);
  });
});
