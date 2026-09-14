import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

const FULL_CONTRACT = [
  'templates/agents/documentation-maintainer.md',
  'templates/agents/standards-review.md',
];

const COMPACT_CONTRACT = [
  'templates/project/AGENTS.md',
  'templates/project/CLAUDE.md',
  'templates/project/MEMORY.md',
  'templates/skills/planning/SKILL.md',
  'AGENTS.md',
  'CLAUDE.md',
];

const ALL_CONTRACT_FILES = [...FULL_CONTRACT, ...COMPACT_CONTRACT];

const PHASE_STATEMENTS = [
  'Planning schedules the ADR step',
  'the change that lands the architecture decision writes the ADR file',
];

const PROPOSED_STATEMENTS = ['may be recorded as proposed', 'becomes accepted'];

const REQUIRED_FIELDS = ['Title', 'Status', 'Date', 'Summary', 'Context', 'Decision', 'Consequences', 'Alternatives'];

const STATUS_VALUES = ['proposed', 'accepted', 'deprecated', 'superseded-by', 'rejected'];

const ADR_LIST_COMMAND = 'ai-workflow adr list';

const ADR_TRIGGERS: Array<[string, RegExp]> = [
  ['architecture', /architecture/i],
  ['module boundary', /module boundar/i],
  ['cross-cutting', /cross-cutting/i],
  ['hard-to-reverse technology choice', /hard[- ]to[- ]reverse|difficult to reverse|难回退/i],
];

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

describe('local ADR contract content', () => {
  it('states the ADR phase boundary and proposed semantics in every shipped contract', async () => {
    for (const path of ALL_CONTRACT_FILES) {
      const text = await read(path);
      for (const statement of PHASE_STATEMENTS) {
        expect(text, `${path} phase: ${statement}`).toContain(statement);
      }
      for (const statement of PROPOSED_STATEMENTS) {
        expect(text, `${path} proposed: ${statement}`).toContain(statement);
      }
    }
  });

  it('keeps the complete ADR contract in the Documentation Maintainer and Standards Review role files', async () => {
    for (const path of FULL_CONTRACT) {
      const text = await read(path);
      expect(text, `${path} filename pattern`).toContain('NNNN-kebab-title.md');
      expect(text, `${path} zero padding`).toMatch(/4[- ]digit|4 位|zero-?padd?ed/i);
      expect(text, `${path} no number reuse`).toMatch(/never reuse|永不复用/i);
      for (const field of REQUIRED_FIELDS) {
        expect(text, `${path} field ${field}`).toContain(field);
      }
      for (const status of STATUS_VALUES) {
        expect(text, `${path} status ${status}`).toContain(status);
      }
      expect(text, `${path} supersedes field`).toContain('Supersedes');
      expect(text, `${path} superseded-by column`).toContain('Superseded-by');
      expect(text, `${path} supersession value`).toContain('superseded-by ADR-NNNN');
      expect(text, `${path} superseded-by derivation`).toContain('derived from `Status`');
      expect(text, `${path} list command`).toContain(ADR_LIST_COMMAND);
      expect(text, `${path} no stored index`).toMatch(/no stored (?:ADR )?index|there is no stored/i);
      for (const [label, pattern] of ADR_TRIGGERS) {
        expect(text, `${path} trigger ${label}`).toMatch(pattern);
      }
      expect(text, `${path} first number`).toContain('0001');
      expect(text, `${path} next number`).toMatch(/max(?:imum)?\b.{0,40}(?:plus one|\+ ?1|加一)/i);
      expect(text, `${path} immutability`).toMatch(/immutab|不可变|must not (?:modify|edit)/i);
    }
  });

  it('states the configured ADR prose language and English structural elements in both full contracts', async () => {
    for (const path of FULL_CONTRACT) {
      const text = await read(path);
      for (const clause of ['output_language', 'field names', 'Status', 'Supersedes', 'superseded-by ADR-NNNN']) {
        expect(text, `${path} locale contract: ${clause}`).toContain(clause);
      }
      expect(text, `${path} ADR prose follows the configured language`).toMatch(/ADR.*natural-language prose.*(?:follow|accord).*output_language/is);
      expect(text, `${path} ADR structure remains English`).toMatch(/structur(?:al|e)? elements?.*(?:remain|stay|keep).*English/is);
    }

    const standardsReview = await read('templates/agents/standards-review.md');
    expect(standardsReview).toMatch(/language.*(?:user preference|preference)/i);
    expect(standardsReview).toMatch(/not.*merge-blocking|merge-blocking.*not/i);
  });

  it('requires the Documentation Maintainer to keep each ADR concise and read only relevant ADRs', async () => {
    const text = await read('templates/agents/documentation-maintainer.md');
    expect(text).toContain('Keep each ADR concise');
    expect(text).toContain('Read only the ADRs relevant to the change');
  });

  it('keeps the compact session-facing contracts layered with a Documentation Maintainer pointer', async () => {
    for (const path of COMPACT_CONTRACT) {
      const text = await read(path);
      expect(text, `${path} location`).toContain('.ai-workflow/adr/');
      expect(text, `${path} list command`).toContain(ADR_LIST_COMMAND);
      expect(text, `${path} numbering`).toContain('NNNN');
      expect(text, `${path} no number reuse`).toMatch(/never reuse|永不复用/i);
      expect(text, `${path} architecture trigger`).toMatch(/architecture/i);
      expect(text, `${path} full contract pointer`).toContain('Documentation Maintainer');
      expect(text, `${path} must not enumerate Status values`).not.toContain('superseded-by');
      expect(text, `${path} must not reference a stored index`).not.toContain('INDEX.md');
    }
  });

  it('limits every .ai-workflow/adr/ line in session-facing contracts to 600 characters', async () => {
    for (const path of COMPACT_CONTRACT) {
      const lines = (await read(path)).split('\n');
      lines.forEach((line, index) => {
        if (line.includes('.ai-workflow/adr/')) {
          expect(line.length, `${path}:${index + 1}`).toBeLessThanOrEqual(600);
        }
      });
    }
  });

  it('requires the planning skill to schedule an ADR step for architecture-triggering plans', async () => {
    const text = await read('templates/skills/planning/SKILL.md');
    expect(text).toMatch(/architecture/i);
    for (const [label, pattern] of ADR_TRIGGERS) {
      expect(text, `trigger ${label}`).toMatch(pattern);
    }
    expect(text).toMatch(/MEMORY\.md/);
    // A plan for an architecture-triggering change must contain a step that produces an ADR.
    expect(text).toMatch(/ADR/);
    expect(text).toMatch(/plan/i);
    expect(text).toMatch(/step|步骤/i);
  });

  it('requires Standards Review to enforce ADR integrity, MEMORY alignment and the stored-index prohibition', async () => {
    const text = await read('templates/agents/standards-review.md');
    expect(text).toMatch(/ADR/);
    expect(text).toMatch(/MEMORY\.md/);
    expect(text).toMatch(/immutab|不可变|must not (?:modify|edit)|error/i);
    expect(text).toContain(ADR_LIST_COMMAND);
    expect(text).toMatch(/no stored (?:ADR )?index|there is no stored/i);
  });

  it('gives Documentation Maintainer ADR authoring ownership, list output and max-plus-one numbering', async () => {
    const text = await read('templates/agents/documentation-maintainer.md');
    expect(text).toMatch(/ADR/);
    expect(text).toMatch(/0001/);
    expect(text).toContain(ADR_LIST_COMMAND);
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

  it('references the adr list command from MEMORY.md instead of a stored index or ADR numbers', async () => {
    for (const path of ['MEMORY.md']) {
      const text = await read(path);
      expect(text, `${path} list command`).toContain(ADR_LIST_COMMAND);
      expect(text, `${path} no stored index`).not.toContain('INDEX.md');
      expect(text, `${path} no ADR number citations`).not.toMatch(/ADR-\d{4}/);
    }
  });

  it('documents the ADR output-language rule in the root MEMORY.md', async () => {
    const text = await read('MEMORY.md');
    expect(text).toContain('documentation-maintainer');
    expect(text).toContain('output_language');
    expect(text).toMatch(/ADR.*(?:natural-language prose|prose).*language/i);
    expect(text).not.toMatch(/ADR-\d{4}/);
  });

  it('separates current standards (MEMORY.md) from decision history (ADR)', async () => {
    const combined = (await Promise.all(ALL_CONTRACT_FILES.map((path) => read(path)))).join('\n');
    expect(combined).toMatch(/ADR/);
    expect(combined).toMatch(/MEMORY\.md/);
    expect(combined).toMatch(/why|decision history|决策|理由/i);
  });
});
