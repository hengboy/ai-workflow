import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { packagePath } from '../../src/utils/schema.js';

const SKILL_PARTS = ['templates', 'skills', 'plan-to-tasks', 'SKILL.md'];
const REFERENCE_PARTS = ['templates', 'skills', 'plan-to-tasks', 'references', 'execution-order.md'];

/** Read a shipped template without importing it, so a missing file is an assertion, not a crash. */
async function readShipped(parts: string[]): Promise<string | null> {
  try {
    return await readFile(packagePath(...parts), 'utf8');
  } catch {
    return null;
  }
}

/** Extract one `## Heading` section up to the next level-two heading. */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Extract the blank-line-delimited paragraph that contains the given needle. */
function paragraphContaining(text: string, needle: string): string {
  const index = text.indexOf(needle);
  if (index === -1) return '';
  const before = text.slice(0, index);
  const boundary = before.lastIndexOf('\n\n');
  const start = boundary === -1 ? 0 : boundary + 2;
  const after = text.slice(index);
  const end = after.indexOf('\n\n');
  return text.slice(start, end === -1 ? text.length : index + end);
}

/** Extract the first ```yaml fenced block body. */
function yamlFence(text: string): string {
  return text.match(/```yaml\n([\s\S]*?)```/)?.[1] ?? '';
}

describe('plan-to-tasks freezes and previews the execution order (REQ-001, REQ-004 / AC-001, AC-005)', () => {
  it('names the execution-order artifact and links its reference in the shipped skill', async () => {
    const text = await readShipped(SKILL_PARTS);
    expect(text, 'the plan-to-tasks skill is shipped').not.toBeNull();
    const skill = text ?? '';

    expect(skill, 'the skill names the execution-order artifact').toContain('tasks/execution-order.yaml');
    expect(skill, 'the skill links the execution-order reference').toContain('references/execution-order.md');
  });

  it('states the phase derivation rule and the ordered write with the validate gate', async () => {
    const skill = (await readShipped(SKILL_PARTS)) ?? '';

    expect(skill, 'the skill states how a phase is derived').toContain('one greater than the latest phase of its dependencies');
    expect(skill, 'the skill states the equal-depth parallel rule').toContain('tasks at the same depth form one parallel group');

    const writeLine = skill
      .split('\n')
      .find((line) => line.includes('Write ') && line.includes('`tasks/execution-order.yaml`')) ?? '';
    expect(writeLine, 'the skill requires writing tasks/execution-order.yaml in one ordering sentence').not.toBe('');
    expect(writeLine, 'the write comes after the task triplets').toContain('after');
    expect(writeLine, 'the write precedes the final validation').toContain('before the final');
    expect(writeLine, 'the ordering sentence names the final validate command').toContain(
      '`ai-workflow plan validate --plan <directory>`'
    );
  });

  it('requires the written execution order to match the approved preview', async () => {
    const skill = (await readShipped(SKILL_PARTS)) ?? '';
    expect(skill, 'the written schedule matches what the user approved').toContain('matches the approved preview');
  });

  it('requires the approval preview to show parallel phases and the critical path', async () => {
    const skill = (await readShipped(SKILL_PARTS)) ?? '';
    const preview = section(skill, '## Approval preview');
    expect(preview, 'the approval preview section exists').not.toBe('');
    expect(preview, 'the preview shows the parallel phases').toContain('parallel phases');
    expect(preview, 'the preview shows the critical path').toContain('critical path');
  });

  it('forbids bilingual siblings for the schedule and lists the artifact and gate in the completion checklist', async () => {
    const skill = (await readShipped(SKILL_PARTS)) ?? '';
    expect(skill, 'the schedule is not a bilingual planning artifact').toContain('no .zh.md or .i18n.yaml sibling');

    const checklist = section(skill, '## Completion checklist');
    expect(checklist, 'the completion checklist section exists').not.toBe('');
    expect(checklist, 'the checklist lists the execution-order artifact').toContain('tasks/execution-order.yaml');
    expect(checklist, 'the checklist lists the passing validate gate').toContain('ai-workflow plan validate');
  });

  it('re-reads the execution order after writing and repeats the coverage, dependency and scope checks', async () => {
    const skill = (await readShipped(SKILL_PARTS)) ?? '';
    const reRead = paragraphContaining(skill, 're-read');
    expect(reRead, 'the post-write re-read paragraph exists').not.toBe('');
    expect(reRead, 'the re-read covers the execution order').toMatch(/execution[- ]order/i);
    expect(reRead, 'the re-read repeats the coverage check').toMatch(/coverage/i);
    expect(reRead, 'the re-read repeats the dependency check').toMatch(/dependenc/i);
    expect(reRead, 'the re-read repeats the scope check').toMatch(/scope/i);
  });
});

describe('plan-to-tasks execution-order reference (REQ-001, REQ-004 / AC-001, AC-005)', () => {
  it('ships the reference with the exact scheduled YAML shape', async () => {
    const text = await readShipped(REFERENCE_PARTS);
    expect(text, 'the execution-order reference is shipped').not.toBeNull();
    const reference = text ?? '';

    const block = yamlFence(reference);
    expect(block, 'the reference shows a yaml fenced schedule').not.toBe('');
    expect(block, 'the schedule names the frozen plan').toContain('plan_id:');
    expect(block, 'the schedule lists phases').toContain('phases:');
    expect(block, 'each phase is a parallel group').toContain('parallel:');
    expect(block, 'phases carry a parallel key').toMatch(/- parallel:/);
    expect(block, 'phases hold a task id list').toMatch(/-\s+task-/i);

    // Mirror the shape rendered by renderExecutionOrderYaml in tests/helpers.ts.
    const parsed = parse(block) as { plan_id?: unknown; phases?: Array<{ parallel?: unknown }> };
    expect(typeof parsed.plan_id, 'plan_id is a string').toBe('string');
    expect(Array.isArray(parsed.phases), 'phases is a list').toBe(true);
    const phases = parsed.phases ?? [];
    expect(phases.length, 'at least one phase is shown').toBeGreaterThan(0);
    for (const phase of phases) {
      expect(Array.isArray(phase.parallel), 'each phase has a parallel list').toBe(true);
      const ids = (phase.parallel as unknown[] | undefined) ?? [];
      expect(ids.length, 'each parallel list is non-empty').toBeGreaterThan(0);
      for (const id of ids) expect(typeof id, 'each scheduled id is a string').toBe('string');
    }
  });

  it('states the derivation rule, the critical path and the validation command', async () => {
    const reference = (await readShipped(REFERENCE_PARTS)) ?? '';
    expect(reference, 'the reference states how a phase is derived').toContain(
      'one greater than the latest phase of its dependencies'
    );
    expect(reference, 'the reference states the equal-depth parallel rule').toContain(
      'tasks at the same depth form one parallel group'
    );
    expect(reference, 'the reference defines the critical path').toContain('longest dependency chain');
    expect(reference, 'the reference names the validation command').toContain('ai-workflow plan validate --plan');
  });

  it('states the no-sibling rule and that a missing or invalid order blocks the split', async () => {
    const reference = (await readShipped(REFERENCE_PARTS)) ?? '';
    expect(reference, 'the schedule has no bilingual siblings').toContain('no .zh.md or .i18n.yaml sibling');
    expect(reference, 'the reference names the missing-or-invalid failure').toContain('missing or invalid');
    expect(reference, 'the reference states that the failure blocks the split').toContain('blocks');
  });

  it('does not create or require a bilingual sibling for the schedule or its reference', async () => {
    const skill = (await readShipped(SKILL_PARTS)) ?? '';
    const reference = (await readShipped(REFERENCE_PARTS)) ?? '';
    const texts = [
      ['skill', skill],
      ['reference', reference]
    ] as const;

    for (const [label, text] of texts) {
      expect(text, `${label} must not name a Chinese schedule sibling`).not.toContain('execution-order.yaml.zh.md');
      expect(text, `${label} must not name an i18n schedule sibling`).not.toContain('execution-order.yaml.i18n.yaml');
      expect(text, `${label} must not name a Chinese reference sibling`).not.toContain('execution-order.zh.md');
      expect(text, `${label} must not name an i18n reference sibling`).not.toContain('execution-order.i18n.yaml');
    }
    expect(skill, 'the execution-order reference is not listed as requiring a .zh.md counterpart').not.toMatch(
      /references\/execution-order\.(?:md\.)?zh\.md/
    );
  });
});
