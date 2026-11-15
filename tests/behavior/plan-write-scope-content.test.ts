import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

async function shipped(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

describe('plan write-scope completeness', () => {
  it('requires planning to derive a complete exact per-step write inventory', async () => {
    const text = flatten(await shipped('templates/skills/planning/SKILL.md'));

    expect(text).toMatch(/## Write-scope completeness/);
    expect(text).toMatch(/creates?,? modifies?,? deletes? or renames?/i);
    for (const category of [
      'test',
      'fixture',
      'snapshot',
      'barrel',
      'registries',
      'schema',
      'migration',
      'generated',
      'documentation',
      'navigation',
      'MEMORY',
      'note triplet',
      'rename',
      'deletion',
    ]) {
      expect(text.toLowerCase(), `the planning write inventory names ${category}`).toContain(category.toLowerCase());
    }
    expect(text).toMatch(/never guess a path/i);
    expect(text).toMatch(/discovered after freezing is a planning defect/i);
    expect(text).toMatch(/never edits outside the frozen scope/i);
  });

  it('forbids directory, wildcard, glob and placeholder write scopes', async () => {
    for (const path of [
      'templates/skills/planning/SKILL.md',
      'templates/skills/planning/references/plan.md',
      'templates/skills/plan-to-tasks/references/task.md',
    ]) {
      const text = flatten(await shipped(path));
      expect(text, `${path} rejects non-file write scopes`).toMatch(/directory[^.]{0,160}wildcard|wildcard[^.]{0,160}directory/i);
      expect(text, `${path} rejects globs`).toMatch(/glob/i);
      expect(text, `${path} rejects placeholders`).toMatch(/placeholder/i);
      expect(text.toLowerCase(), `${path} rejects related-file summaries`).toContain('related files');
    }
  });

  it('requires a pre-freeze write-scope audit in the plan template', async () => {
    const text = flatten(await shipped('templates/skills/planning/references/plan.md'));

    expect(text).toMatch(/## Write-scope audit/i);
    expect(text).toMatch(/complete exact file inventory|complete file inventory/i);
    expect(text).toMatch(/existing tests? whose expectations? (?:change|invalidates?)/i);
    expect(text).toMatch(/tracked generated (?:source|output)/i);
    expect(text).toMatch(/both endpoints of every rename/i);
    expect(text).toMatch(/every file a validation command/i);
    expect(text).toMatch(/not (?:frozen|ready)/i);
  });

  it('requires plan-to-tasks to derive task scopes only from the frozen plan inventory', async () => {
    const text = flatten(await shipped('templates/skills/plan-to-tasks/SKILL.md'));

    expect(text).toMatch(/union of task write scopes/i);
    expect(text).toMatch(/frozen plan write inventory|frozen plan's write inventory/i);
    expect(text).toMatch(/frozen-plan defect/i);
    expect(text).toMatch(/bounded support request/i);
    expect(text).toMatch(/never add it silently/i);
    expect(text).toMatch(/every plan write path is assigned/i);
    expect(text).toMatch(/no task adds a path the plan does not declare/i);
  });

  it('requires task documents to stop before an out-of-scope edit', async () => {
    const text = flatten(await shipped('templates/skills/plan-to-tasks/references/task.md'));

    expect(text).toMatch(/frozen plan write inventory/i);
    expect(text).toMatch(/required path outside it|required path absent/i);
    expect(text).toMatch(/stops? before the edit/i);
    expect(text).toMatch(/plan gap/i);
  });

  it('requires coding and writing roles to stop before an out-of-scope edit', async () => {
    const coding = flatten(await shipped('templates/skills/coding/SKILL.md'));

    expect(coding).toMatch(/before the first edit/i);
    expect(coding).toMatch(/required path outside it stops before the edit/i);
    expect(coding).toMatch(/never create or modify it/i);
    expect(coding).toMatch(/never substitute a broader directory/i);
    expect(coding).toMatch(/never treat an omitted path as authorization/i);

    for (const role of ['backend', 'frontend', 'test']) {
      const text = flatten(await shipped(`templates/agents/${role}.md`));
      expect(text, `${role} stops outside its write scope`).toMatch(/required (?:test or fixture )?path outside/i);
      expect(text, `${role} returns a support request`).toMatch(/support request/i);
    }
  });
});
