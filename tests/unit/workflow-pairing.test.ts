import { describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPlan, readTasks } from '../../src/workflow/parse.js';
import { frozenDocumentDigest, renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { blobHash, metaPathOf, zhPathOf } from '../../src/notes/pairing.js';
import { recordPlanPair, temporary, writePlanTriplet } from '../helpers.js';

const PLAN_ID = '20260831-example';

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

function taskAttributes(id = 'task-001-example'): Record<string, unknown> {
  return {
    id,
    requirements: ['REQ-001'],
    acceptance_criteria: ['AC-001'],
    depends_on: [],
    surface: 'backend',
    read_scope: ['MEMORY.md', 'src/input.ts'],
    write_scope: ['src/output.ts'],
    test_commands: ['pnpm test'],
  };
}

async function planFixture(root: string): Promise<string> {
  const directory = join(root, '.ai-workflow/plans', PLAN_ID);
  await mkdir(join(directory, 'tasks'), { recursive: true });
  await writePlanTriplet(directory, 'spec.md', SPEC_EN, SPEC_ZH, frozenRenderer);
  await writePlanTriplet(directory, 'plan.md', PLAN_EN, PLAN_ZH, frozenRenderer);
  return directory;
}

async function taskFixture(root: string): Promise<string> {
  const directory = await planFixture(root);
  await writePlanTriplet(join(directory, 'tasks'), 'task-001-example.md', TASK_EN, TASK_ZH, (body) => renderMarkdown(taskAttributes(), body));
  return directory;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the operation to reject, but it resolved');
}

async function rewriteChinese(directory: string, basename: string, mutate: (source: string) => string): Promise<void> {
  const path = join(directory, zhPathOf(basename));
  const source = await readFile(path, 'utf8');
  const mutated = mutate(source);
  expect(mutated, 'the mutation must change the Chinese source').not.toBe(source);
  await writeFile(path, mutated);
}

async function mutateChinese(directory: string, basename: string, mutate: (source: string) => string): Promise<void> {
  await rewriteChinese(directory, basename, mutate);
  await recordPlanPair(directory, basename);
}

async function mutateEnglish(directory: string, basename: string, mutate: (source: string) => string): Promise<void> {
  const path = join(directory, basename);
  const source = await readFile(path, 'utf8');
  const mutated = mutate(source);
  expect(mutated, 'the mutation must change the English source').not.toBe(source);
  const canonical = mutated.replace(/^digest:.*$/m, 'digest: ""');
  const withDigest = canonical.replace('digest: ""', `digest: ${frozenDocumentDigest(canonical)}`);
  await writeFile(path, withDigest);
  await recordPlanPair(directory, basename);
}

describe('planning document triplets', () => {
  it('accepts a complete spec/plan triplet and keeps planId, REQ/AC and English digests', async () => {
    const directory = await planFixture(await temporary());
    const document = await readPlan(directory);
    const specSource = await readFile(join(directory, 'spec.md'), 'utf8');
    const planSource = await readFile(join(directory, 'plan.md'), 'utf8');

    expect(document.planId).toBe(PLAN_ID);
    expect(document.requirements).toEqual(['REQ-001']);
    expect(document.acceptanceCriteria).toEqual(['AC-001']);
    expect(document.specDigest).toBe(frozenDocumentDigest(specSource));
    expect(document.planDigest).toBe(frozenDocumentDigest(planSource));
  });

  it('rejects a plan whose spec.zh.md is missing', async () => {
    const directory = await planFixture(await temporary());
    await rm(join(directory, 'spec.zh.md'));

    const message = await rejection(readPlan(directory));

    expect(message).toMatch(/spec\.zh\.md/);
    expect(message).toMatch(/missing/i);
  });

  it('rejects a plan whose spec.i18n.yaml is missing', async () => {
    const directory = await planFixture(await temporary());
    await rm(join(directory, 'spec.i18n.yaml'));

    const message = await rejection(readPlan(directory));

    expect(message).toMatch(/spec\.i18n\.yaml/);
    expect(message).toMatch(/missing|consistency record/i);
  });

  it('rejects an imprecise or missing language switcher on either side', async () => {
    const cases: [string, (directory: string) => Promise<void>][] = [
      ['imprecise English switcher', (directory) => mutateEnglish(directory, 'spec.md', (source) => source.replace('English | [中文](spec.zh.md)', 'English|[中文](spec.zh.md)'))],
      ['missing English switcher', (directory) => mutateEnglish(directory, 'spec.md', (source) => source.replace('English | [中文](spec.zh.md)\n\n', ''))],
      ['imprecise Chinese switcher', (directory) => mutateChinese(directory, 'spec.md', (source) => source.replace('[English](spec.md) | 中文', '[English](spec.md)|中文'))],
      ['missing Chinese switcher', (directory) => mutateChinese(directory, 'spec.md', (source) => source.replace('[English](spec.md) | 中文\n\n', ''))],
    ];

    for (const [name, mutate] of cases) {
      const directory = await planFixture(await temporary());
      await mutate(directory);
      const message = await rejection(readPlan(directory));
      expect(message, name).toMatch(/language switcher/i);
    }
  });

  it('rejects a Chinese side whose mirrored structure diverges', async () => {
    const cases: [string, RegExp, (source: string) => string][] = [
      ['heading depth', /heading \(depth\)/, (source) => source.replace('## Goal', '#### Goal')],
      ['code block', /code block/, (source) => source.replace('const value = 1;', 'const value = 1;\nconst other = 2;')],
      ['table rows', /table \(row x column count\)/, (source) => source.replace('| 甲 | 乙 |', '| 甲 | 乙 |\n| 丙 | 丁 |')],
      ['list items', /list \(kind, start, item count\)/, (source) => source.replace('- 第二', '- 第二\n- 第三')],
      ['link target', /link target/, (source) => source.replace('plan.zh.md', 'plan-other.zh.md')],
    ];

    for (const [name, pattern, mutate] of cases) {
      const directory = await planFixture(await temporary());
      await mutateChinese(directory, 'spec.md', mutate);
      const message = await rejection(readPlan(directory));
      expect(message, name).toMatch(pattern);
    }
  });

  it('rejects a stale recorded hash even when the English digest still matches', async () => {
    const directory = await planFixture(await temporary());
    const specSource = await readFile(join(directory, 'spec.md'), 'utf8');
    expect(specSource, 'the English digest must still be self-consistent').toContain(`digest: ${frozenDocumentDigest(specSource)}`);
    await rewriteChinese(directory, 'spec.md', (source) => source.replace('目标正文。', '不同的目标正文。'));

    const message = await rejection(readPlan(directory));

    expect(message).toMatch(/spec\.i18n\.yaml/);
    expect(message).toMatch(/hash/i);
  });

  it('rejects an empty consistency record or one recording the wrong basenames', async () => {
    const empty = await planFixture(await temporary());
    await writeFile(join(empty, 'spec.i18n.yaml'), '');
    expect(await rejection(readPlan(empty))).toMatch(/spec\.i18n\.yaml/);

    const wrong = await planFixture(await temporary());
    await writeFile(join(wrong, 'spec.i18n.yaml'), `other.md: ${blobHash('a')}\nother.zh.md: ${blobHash('b')}\n`);
    const wrongMessage = await rejection(readPlan(wrong));

    expect(wrongMessage).toMatch(/spec\.i18n\.yaml/);
  });

  it('enumerates only task-NNN-slug.md and ignores the task sidecars', async () => {
    const directory = await taskFixture(await temporary());

    const tasks = await readTasks(directory);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('task-001-example');
    expect(tasks[0]?.surface).toBe('backend');
    expect(tasks[0]?.requirements).toEqual(['REQ-001']);
    expect(tasks[0]?.acceptanceCriteria).toEqual(['AC-001']);
    expect(tasks[0]?.readScope).toEqual(['MEMORY.md', 'src/input.ts']);
    expect(tasks[0]?.writeScope).toEqual(['src/output.ts']);
  });

  it('accepts a complete task triplet whose surface, reqs and scopes parse as before', async () => {
    const directory = await taskFixture(await temporary());

    const [task] = await readTasks(directory);

    expect(task).toMatchObject({
      id: 'task-001-example',
      surface: 'backend',
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      readScope: ['MEMORY.md', 'src/input.ts'],
      writeScope: ['src/output.ts'],
      testCommands: ['pnpm test'],
    });
    expect(await readFile(join(directory, 'tasks', 'task-001-example.zh.md'), 'utf8')).toContain('[English](task-001-example.md) | 中文');
    expect(await readFile(join(directory, 'tasks', metaPathOf('task-001-example.md')), 'utf8')).toContain('task-001-example.zh.md: ');
  });

  it('rejects orphan task sidecars with no matching English document', async () => {
    const zhOrphan = await taskFixture(await temporary());
    await writeFile(join(zhOrphan, 'tasks', 'task-002-orphan.zh.md'), '# Task\n\n[English](task-002-orphan.md) | 中文\n\n孤儿。\n');
    const zhMessage = await rejection(readTasks(zhOrphan));

    expect(zhMessage).toMatch(/task-002-orphan\.zh\.md/);
    expect(zhMessage).toMatch(/no matching English document/i);

    const metaOrphan = await taskFixture(await temporary());
    await writeFile(join(metaOrphan, 'tasks', 'task-002-orphan.i18n.yaml'), `# orphan sidecar\ntask-002-orphan.md: ${blobHash('a')}\ntask-002-orphan.zh.md: ${blobHash('b')}\n`);
    const metaMessage = await rejection(readTasks(metaOrphan));

    expect(metaMessage).toMatch(/task-002-orphan\.i18n\.yaml/);
    expect(metaMessage).toMatch(/no matching English document/i);
  });

  it('accepts a plan with an empty tasks directory', async () => {
    const directory = await planFixture(await temporary());

    expect(await readTasks(directory)).toEqual([]);
  });
});
