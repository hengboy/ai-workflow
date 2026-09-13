import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

const FILES = [
  'templates/project/AGENTS.md',
  'templates/project/CLAUDE.md',
  'templates/project/MEMORY.md',
  'templates/agents/documentation-maintainer.md',
  'templates/agents/standards-review.md',
  'templates/skills/planning/SKILL.md',
];

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

describe('local ADR contract content', () => {
  it('exposes the same ADR location, numbering, fields, statuses and discovery rules in every shipped contract', async () => {
    for (const path of FILES) {
      const text = await read(path);
      expect(text, path).toContain('.ai-workflow/adr/');
      expect(text, path).toContain('NNNN-kebab-title.md');
      expect(text, path).toMatch(/4[- ]digit|4 位|zero-?padd?ed/i);
      expect(text, path).toMatch(/never reuse|永不复用/i);
      for (const field of ['Title', 'Status', 'Date', 'Context', 'Decision', 'Consequences', 'Alternatives']) {
        expect(text, `${path} field ${field}`).toContain(field);
      }
      for (const status of ['proposed', 'accepted', 'deprecated', 'superseded-by', 'rejected']) {
        expect(text, `${path} status ${status}`).toContain(status);
      }
      expect(text, path).toContain('superseded by ADR-NNNN');
      expect(text, path).toMatch(/list(?:ing)?|enumerate|列出/i);
    }
  });

  it('requires the planning skill to produce an ADR step for architecture-triggering plans', async () => {
    const text = await read('templates/skills/planning/SKILL.md');
    expect(text).toMatch(/architecture/i);
    expect(text).toMatch(/module boundar/i);
    expect(text).toMatch(/cross-cutting/i);
    expect(text).toMatch(/hard[- ]to[- ]reverse|difficult to reverse|难回退/i);
    expect(text).toMatch(/MEMORY\.md/);
    // A plan for an architecture-triggering change must contain a step that produces an ADR.
    expect(text).toMatch(/ADR/);
    expect(text).toMatch(/plan/i);
    expect(text).toMatch(/step|步骤/i);
  });

  it('requires Standards Review to enforce ADR immutability and MEMORY alignment', async () => {
    const text = await read('templates/agents/standards-review.md');
    expect(text).toMatch(/ADR/);
    expect(text).toMatch(/MEMORY\.md/);
    expect(text).toMatch(/immutab|不可变|must not (?:modify|edit)|error/i);
  });

  it('gives Documentation Maintainer ADR authoring ownership and max-plus-one numbering', async () => {
    const text = await read('templates/agents/documentation-maintainer.md');
    expect(text).toMatch(/ADR/);
    expect(text).toMatch(/0001/);
    expect(text).toMatch(/max(?:imum)?\b.{0,40}(?:plus one|\+ ?1|加一)/i);
  });

  it('exposes ADR rules in the installable project AGENTS.md and CLAUDE.md', async () => {
    for (const path of ['templates/project/AGENTS.md', 'templates/project/CLAUDE.md']) {
      const text = await read(path);
      expect(text, path).toMatch(/ADR/);
      expect(text, path).toMatch(/architecture/i);
      expect(text, path).toMatch(/MEMORY\.md/);
    }
  });

  it('separates current standards (MEMORY.md) from decision history (ADR)', async () => {
    const combined = (await Promise.all(FILES.map((path) => read(path)))).join('\n');
    expect(combined).toMatch(/ADR/);
    expect(combined).toMatch(/MEMORY\.md/);
    expect(combined).toMatch(/why|decision history|决策|理由/i);
  });
});
