import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPlan, readTasks } from '../../src/workflow/parse.js';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { packagePath } from '../../src/utils/schema.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);
const PLAN_ID = '20260913-localized-plan';

function frozenAttributes(): Record<string, unknown> {
  return {
    plan_id: PLAN_ID,
    status: 'frozen',
    created_at: '2026-09-13T00:00:00.000Z',
    supersedes: null,
    requirement_count: '1',
    acceptance_criteria_count: '1',
    digest: 'sha256:placeholder',
  };
}

function chineseSpecBody(): string {
  return [
    '# Specification',
    '',
    '## Goal',
    '',
    '让规划产物中的自然语言正文使用简体中文，同时保持机器可解析结构不变。',
    '',
    '## Requirements',
    '',
    '### REQ-001: 可配置的输出语言',
    '',
    '规划文档的正文可以使用简体中文书写。',
    '',
    '## Acceptance criteria',
    '',
    '### AC-001: 中文正文的冻结文档仍然有效',
    '',
    '当正文使用简体中文时，冻结文档仍然通过校验。',
    '',
  ].join('\n');
}

function englishSpecBody(): string {
  return [
    '# Specification',
    '',
    '## Goal',
    '',
    'Allow the natural-language prose of planning artifacts to be written in Simplified Chinese while leaving the machine-parseable structure unchanged.',
    '',
    '## Requirements',
    '',
    '### REQ-001: Configurable output language',
    '',
    'The prose of planning documents may be written in Simplified Chinese.',
    '',
    '## Acceptance criteria',
    '',
    '### AC-001: Frozen documents with Chinese prose remain valid',
    '',
    'A frozen document whose body uses Simplified Chinese still validates.',
    '',
  ].join('\n');
}

function chinesePlanBody(): string {
  return [
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
    '1. 实现中文正文支持。',
    '',
  ].join('\n');
}

function englishPlanBody(): string {
  return [
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
    '1. Implement Chinese-prose support.',
    '',
  ].join('\n');
}

function chineseTaskBody(): string {
  return ['# Task', '', '## Objective', '', '实现中文正文的示例变更。', '', '## Notes', '', '仅正文使用简体中文。', ''].join('\n');
}

function englishTaskBody(): string {
  return [
    '# Task',
    '',
    '## Objective',
    '',
    'Implement the English-prose example change.',
    '',
    '## Notes',
    '',
    'Only the prose changes.',
    '',
  ].join('\n');
}

async function writeFrozenPair(root: string, specBody: string, planBody: string): Promise<string> {
  const directory = join(root, '.ai-workflow', 'plans', PLAN_ID);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'spec.md'), renderFrozenMarkdown(frozenAttributes(), specBody));
  await writeFile(join(directory, 'plan.md'), renderFrozenMarkdown(frozenAttributes(), planBody));
  return directory;
}

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

async function writeTaskPlan(root: string, specBody: string, planBody: string, taskBody: string): Promise<string> {
  const directory = await writeFrozenPair(root, specBody, planBody);
  await mkdir(join(directory, 'tasks'), { recursive: true });
  await writeFile(join(directory, 'tasks', 'task-001-example.md'), renderMarkdown(taskAttributes(), taskBody));
  return directory;
}

function validateCommand(directory: string): Promise<{ stdout: string; stderr: string }> {
  return exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'plan', 'validate', '--plan', directory]);
}

describe('localized planning artifacts', () => {
  it('validates a frozen plan whose body prose is Simplified Chinese (AC-008)', async () => {
    const chinese = await writeFrozenPair(await temporary(), chineseSpecBody(), chinesePlanBody());
    const english = await writeFrozenPair(await temporary(), englishSpecBody(), englishPlanBody());

    const chinesePlan = await readPlan(chinese);
    const englishPlan = await readPlan(english);

    expect(chinesePlan.requirements).toEqual(['REQ-001']);
    expect(chinesePlan.acceptanceCriteria).toEqual(['AC-001']);
    expect(chinesePlan.requirements).toEqual(englishPlan.requirements);
    expect(chinesePlan.acceptanceCriteria).toEqual(englishPlan.acceptanceCriteria);

    const { stdout } = await validateCommand(chinese);

    expect(stdout).toContain('"valid": true');
  });

  it('parses Chinese-prose and English-prose tasks identically (AC-009)', async () => {
    const chinese = await writeTaskPlan(await temporary(), chineseSpecBody(), chinesePlanBody(), chineseTaskBody());
    const english = await writeTaskPlan(await temporary(), englishSpecBody(), englishPlanBody(), englishTaskBody());

    const chineseTasks = await readTasks(chinese);
    const englishTasks = await readTasks(english);

    expect(chineseTasks).toHaveLength(1);
    expect(englishTasks).toHaveLength(1);
    const chineseTask = chineseTasks[0];
    const englishTask = englishTasks[0];
    if (!chineseTask || !englishTask) throw new Error('Expected exactly one parsed task per plan');

    expect({
      surface: chineseTask.surface,
      requirements: chineseTask.requirements,
      acceptanceCriteria: chineseTask.acceptanceCriteria,
      readScope: chineseTask.readScope,
      writeScope: chineseTask.writeScope,
    }).toEqual({
      surface: englishTask.surface,
      requirements: englishTask.requirements,
      acceptanceCriteria: englishTask.acceptanceCriteria,
      readScope: englishTask.readScope,
      writeScope: englishTask.writeScope,
    });
  });

  it('documents the output-language configuration, values, default and reinstall requirement (AC-010)', async () => {
    const readme = (await readFile(packagePath('README.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(readme).toContain('~/.config/ai-workflow/config.yaml');
    expect(readme).toContain('output_language');
    expect(readme).toContain('`en`');
    expect(readme).toContain('`zh-CN`');
    expect(readme).toMatch(/default is `en`/);
    expect(readme).toMatch(/re-running `ai-workflow install`/);
    expect(readme).toMatch(/\$switch-profile/);
  });

  it('rejects a Chinese-prose frozen pair whose digest does not match (negative)', async () => {
    const directory = await writeFrozenPair(await temporary(), chineseSpecBody(), chinesePlanBody());
    const specPath = join(directory, 'spec.md');
    const original = await readFile(specPath, 'utf8');
    const tampered = original.replace(/^digest:.*$/m, `digest: sha256:${'0'.repeat(64)}`);

    expect(tampered).not.toBe(original);
    await writeFile(specPath, tampered);

    await expect(readPlan(directory)).rejects.toThrow(/digest mismatch/i);
    await expect(validateCommand(directory)).rejects.toThrow(/digest mismatch/i);
  });

  it('rejects translated REQ/AC heading identifiers that no longer match the declared counts (negative)', async () => {
    const root = await temporary();
    const directory = join(root, '.ai-workflow', 'plans', PLAN_ID);
    await mkdir(directory, { recursive: true });
    const translatedSpec = [
      '# Specification',
      '',
      '## 需求',
      '',
      '### 需求-001：可配置的输出语言',
      '',
      '正文。',
      '',
      '## 验收标准',
      '',
      '### 验收-001：中文正文的冻结文档仍然有效',
      '',
      '正文。',
      '',
    ].join('\n');
    await writeFile(join(directory, 'spec.md'), renderFrozenMarkdown(frozenAttributes(), translatedSpec));
    await writeFile(join(directory, 'plan.md'), renderFrozenMarkdown(frozenAttributes(), '# Implementation Plan\n\n正文。\n'));

    await expect(readPlan(directory)).rejects.toThrow(/count mismatch/i);
    await expect(validateCommand(directory)).rejects.toThrow(/count mismatch/i);
  });
});
