import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPlan, readTasks } from '../../src/workflow/parse.js';
import { frozenDocumentDigest, renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { packagePath } from '../../src/utils/schema.js';
import { temporary, writePlanTriplet } from '../helpers.js';

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

interface BodyPair { en: string; zh: string }

async function writeFrozenPair(
  root: string,
  spec: BodyPair = { en: englishSpecBody(), zh: chineseSpecBody() },
  plan: BodyPair = { en: englishPlanBody(), zh: chinesePlanBody() },
): Promise<string> {
  const directory = join(root, '.ai-workflow', 'plans', PLAN_ID);
  await mkdir(directory, { recursive: true });
  const render = (body: string): string => renderFrozenMarkdown(frozenAttributes(), body);
  await writePlanTriplet(directory, 'spec.md', spec.en, spec.zh, render);
  await writePlanTriplet(directory, 'plan.md', plan.en, plan.zh, render);
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

async function writeTaskPlan(root: string): Promise<string> {
  const directory = await writeFrozenPair(root);
  await mkdir(join(directory, 'tasks'), { recursive: true });
  await writePlanTriplet(join(directory, 'tasks'), 'task-001-example.md', englishTaskBody(), chineseTaskBody(), (body) => renderMarkdown(taskAttributes(), body));
  return directory;
}

function validateCommand(directory: string): Promise<{ stdout: string; stderr: string }> {
  return exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'plan', 'validate', '--plan', directory]);
}

describe('localized planning artifacts', () => {
  it('validates a complete bilingual frozen plan and takes REQ/AC and digests from the English side (AC-008)', async () => {
    const directory = await writeFrozenPair(await temporary());

    const plan = await readPlan(directory);

    expect(plan.requirements).toEqual(['REQ-001']);
    expect(plan.acceptanceCriteria).toEqual(['AC-001']);
    expect(plan.specDigest).toBe(frozenDocumentDigest(await readFile(join(directory, 'spec.md'), 'utf8')));
    expect(plan.planDigest).toBe(frozenDocumentDigest(await readFile(join(directory, 'plan.md'), 'utf8')));

    const { stdout } = await validateCommand(directory);

    expect(stdout).toContain('"valid": true');
  });

  it('parses a complete task triplet identically from the English side (AC-009)', async () => {
    const directory = await writeTaskPlan(await temporary());

    const tasks = await readTasks(directory);

    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    if (!task) throw new Error('Expected exactly one parsed task per plan');

    expect({
      surface: task.surface,
      requirements: task.requirements,
      acceptanceCriteria: task.acceptanceCriteria,
      readScope: task.readScope,
      writeScope: task.writeScope,
    }).toEqual({
      surface: 'backend',
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      readScope: ['MEMORY.md', 'src/input.ts'],
      writeScope: ['src/output.ts'],
    });
    const chineseTask = await readFile(join(directory, 'tasks', 'task-001-example.zh.md'), 'utf8');
    expect(chineseTask.startsWith('# Task\n\n[English](task-001-example.md) | 中文\n')).toBe(true);
    expect(chineseTask).not.toContain('---');
  });

  it('rejects a frozen pair whose English digest does not match (negative)', async () => {
    const directory = await writeFrozenPair(await temporary());
    const specPath = join(directory, 'spec.md');
    const original = await readFile(specPath, 'utf8');
    const tampered = original.replace(/^digest:.*$/m, `digest: sha256:${'0'.repeat(64)}`);

    expect(tampered).not.toBe(original);
    await writeFile(specPath, tampered);

    await expect(readPlan(directory)).rejects.toThrow(/digest mismatch/i);
    await expect(validateCommand(directory)).rejects.toThrow(/digest mismatch/i);
  });

  it('rejects translated REQ/AC heading identifiers on the English side with a count mismatch (negative)', async () => {
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
    const directory = await writeFrozenPair(await temporary(), { en: translatedSpec, zh: translatedSpec });

    await expect(readPlan(directory)).rejects.toThrow(/count mismatch/i);
    await expect(validateCommand(directory)).rejects.toThrow(/count mismatch/i);
  });
});

// REQ-006, REQ-008 / AC-016: the README must describe the delivered project
// contract and notes workflow and stay consistent with the implemented CLI
// surface instead of presenting the retired ADR mechanism as current. These
// assertions cover non-omittable entry points and retired-description removal
// only; they do not prove the quality of the prose and do not replace semantic
// review. The grep is bounded to the documented command surface, so a truthful
// historical note about retired ADR files is not treated as a current feature.
async function registeredCliCommands(): Promise<Set<string>> {
  const source = await readFile(packagePath('src/cli.ts'), 'utf8');
  return new Set([...source.matchAll(/\.command\('([^']+)'\)/g)].map((match) => match[1] as string));
}

function documentedCommands(readme: string): string[] {
  return [...readme.matchAll(/^[ \t]*ai-workflow[ \t]+([a-z][a-z-]*)/gm)].map((match) => match[1] as string);
}

describe('current workflow documentation', () => {
  it('documents the implemented CLI surface and explicit project contract loading (REQ-001, REQ-007 / AC-013, AC-016)', async () => {
    const readme = await readFile(packagePath('README.md'), 'utf8');
    const normalized = readme.replace(/\s+/g, ' ');
    const registered = await registeredCliCommands();

    for (const command of documentedCommands(readme)) {
      expect(registered.has(command), `README documents ai-workflow ${command}, which the implemented CLI registers`).toBe(true);
    }

    expect(normalized).toContain('ai-workflow init');
    expect(normalized).toMatch(/ai-workflow init[^.]{0,160}--upgrade|--upgrade[^.]{0,160}ai-workflow init/);
    expect(normalized).toContain('ai-workflow notes validate');
    expect(normalized).toContain('ai-workflow notes list');
    expect(normalized).toContain('ai-workflow notes archive');
    expect(normalized).toContain('ai-workflow context');

    expect(normalized).toContain('.ai-workflow/AGENTS.md');
    expect(normalized).toMatch(/explicit\w*[^.]{0,160}\.ai-workflow\/AGENTS\.md|\.ai-workflow\/AGENTS\.md[^.]{0,160}explicit/i);
  });

  it('retires ADR from the documented CLI surface and decision-record rules (REQ-006 / AC-016)', async () => {
    const readme = await readFile(packagePath('README.md'), 'utf8');
    const normalized = readme.replace(/\s+/g, ' ');

    expect(documentedCommands(readme), 'the retired adr command is not documented').not.toContain('adr');
    expect(normalized, 'the retired adr command is not referenced').not.toMatch(/ai-workflow\s+adr\b/i);
    expect(normalized, 'notes are the documented decision-record store').toMatch(/ai-workflow notes (?:validate|list|archive)/);
    expect(normalized).not.toContain('NNNN-kebab-title.md');
    expect(normalized).not.toContain('superseded-by ADR-NNNN');
    expect(normalized).not.toMatch(/ADR natural-language prose[^.]{0,160}output_language/i);
  });

  it('no longer documents an output_language configuration source (REQ-008)', async () => {
    const readme = (await readFile(packagePath('README.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(readme).toContain('~/.config/ai-workflow/config.yaml');
    expect(readme, 'the removed configuration key is gone from the docs').not.toMatch(/output_language/i);
    expect(readme, 'config.yaml is documented with its active_profile field').toMatch(/active_profile/);
  });

  it('keeps notes and planning artifacts bilingual without a language preference (REQ-008 / AC-016)', async () => {
    const readme = (await readFile(packagePath('README.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(readme, 'notes are always bilingual').toMatch(/notes.{0,200}bilingual/i);
    expect(readme, 'the Chinese body is documented').toMatch(/\.zh\.md/);
    expect(readme, 'the consistency record is documented').toMatch(/\.i18n\.yaml/);
    expect(readme, 'no language preference selects the artifact language').not.toMatch(/output_language/i);
  });
});
