import { describe, expect, it } from 'vitest';
import { access, readFile, readdir } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Static shipped-content evidence for the planning decision-quality change:
// the planning framing/impact/alternatives rules, the direct defect cause rule,
// the Standards Review maintainability lens and the durable alignment. Test
// names carry REQ/AC labels linking each assertion to what it verifies.

describe('REQ-001/AC-001 planning problem framing', () => {
  it('AC-001: the planning skill ships a Problem framing and impact section before the clarification loop', async () => {
    const planning = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    const framing = planning.indexOf('\n## Problem framing and impact\n');
    const clarification = planning.indexOf('\n## Clarification loop\n');

    expect(framing, 'the skill contains the exact level-two heading ## Problem framing and impact').toBeGreaterThanOrEqual(0);
    expect(clarification, 'the skill keeps the clarification loop heading').toBeGreaterThanOrEqual(0);
    expect(framing, 'the framing section precedes the clarification loop').toBeLessThan(clarification);
  });

  it('AC-001: the framing section requires the stated request, the underlying outcome and the outcome/means/symptom classification', async () => {
    const planning = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    const section = sectionOf(planning, '## Problem framing and impact');

    expect(section, 'the framing section exists').not.toBe('');
    expect(section, 'the section requires the stated request').toMatch(/stated request/i);
    expect(section, 'the section requires the underlying outcome').toMatch(/underlying outcome/i);
    expect(section, 'the section classifies the request as outcome, means or symptom').toMatch(
      /(outcome[^.]{0,200}symptom|symptom[^.]{0,200}outcome)/i,
    );
    expect(section, 'the classification names the means case').toMatch(/means/i);
  });

  it('AC-001: the framing section requires at most one bounded non-blocking challenge that never blocks the user’s decision', async () => {
    const planning = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    const section = sectionOf(planning, '## Problem framing and impact');

    expect(section, 'the challenge is at most one and bounded').toMatch(/at most one/i);
    expect(section, 'the challenge is named').toMatch(/challenge/i);
    expect(section, 'the challenge is non-blocking').toMatch(/non-blocking|does not block/i);
    expect(section, 'a declined challenge continues the user’s original request').toMatch(/declin/i);
    expect(section, 'the user’s decision is honored when declined').toMatch(
      /(original request|user's decision|non-adoption)/i,
    );
  });

  it('AC-001: the spec template ships an exact Problem framing heading with stated-request, outcome, classification and challenge slots', async () => {
    const specTemplate = await readFile(packagePath('templates', 'skills', 'planning', 'references', 'spec.md'), 'utf8');
    const section = sectionOf(specTemplate, '## Problem framing');

    expect(section, 'the spec template contains the exact heading ## Problem framing').not.toBe('');
    expect(section, 'the slot for the stated request').toMatch(/stated request/i);
    expect(section, 'the slot for the underlying outcome').toMatch(/underlying outcome/i);
    expect(section, 'the slot for the request classification').toMatch(/classif/i);
    expect(section, 'the slot for the bounded challenge').toMatch(/challenge/i);
  });

  it('AC-002: the Spec Review Planning review mode checklist requires the draft framing, impact and alternatives as review inputs', async () => {
    const specReview = await readFile(packagePath('templates', 'agents', 'spec-review.md'), 'utf8');
    const planningMode = sectionOf(specReview, '## Planning review mode');

    expect(planningMode, 'the Planning review mode section exists').not.toBe('');
    expect(planningMode, 'the checklist requires the draft’s problem framing').toMatch(/problem framing/i);
    expect(planningMode, 'the checklist requires direct and second-order impact').toMatch(/second-order/i);
    expect(planningMode, 'the checklist requires the impact review input').toMatch(/impact/i);
    expect(planningMode, 'the checklist requires the alternatives or strongest objection').toMatch(
      /(strongest objection|alternatives)/i,
    );
  });
});

describe('REQ-002/AC-003 planning impact', () => {
  it('AC-003: the plan template ships an Impact and blast radius section with an impact table', async () => {
    const planTemplate = await readFile(packagePath('templates', 'skills', 'planning', 'references', 'plan.md'), 'utf8');
    const raw = rawSectionOf(planTemplate, '## Impact and blast radius');
    const section = sectionOf(planTemplate, '## Impact and blast radius');

    expect(raw, 'the plan template contains the exact heading ## Impact and blast radius').not.toBe('');
    expect(raw, 'the section carries a markdown table').toMatch(/^\|[^\n]+\|[ \t]*$/m);
    expect(raw, 'the impact table has a separator row').toMatch(/^\|(?:[\s:|-]+)\|[ \t]*$/m);
    expect(section, 'the table covers affected modules and callers').toMatch(/affected modules/i);
    expect(section, 'the table covers callers').toMatch(/callers/i);
    expect(section, 'the table covers user-visible behavior').toMatch(/user-visible behavior/i);
    expect(section, 'the table covers compatibility').toMatch(/compatibility/i);
    expect(section, 'the table covers operational and maintenance cost').toMatch(/operational/i);
    expect(section, 'the table covers maintenance cost').toMatch(/maintenance cost/i);
    expect(section, 'the table covers reversibility').toMatch(/reversibility/i);
    expect(section, 'the table covers evidence').toMatch(/evidence/i);
  });

  it('AC-003: the plan template requires the full impact table for cross-module, public-interface or migration changes and permits proportional impact for bounded changes', async () => {
    const planTemplate = await readFile(packagePath('templates', 'skills', 'planning', 'references', 'plan.md'), 'utf8');
    const section = sectionOf(planTemplate, '## Impact and blast radius');

    expect(section, 'the full-table rule names the cross-module case').toMatch(/cross-module/i);
    expect(section, 'the full-table rule names the public-interface case').toMatch(/public[- ]interface/i);
    expect(section, 'the full-table rule names the migration case').toMatch(/migration/i);
    expect(section, 'the full-table rule is stated').toMatch(/(full|complete) impact table/i);
    expect(section, 'a bounded planned change may state impact proportionally').toMatch(/proportional/i);
    expect(section, 'the proportional case is bounded').toMatch(/bounded/i);
  });

  it('AC-003: the planning skill requires direct and second-order impact with the same evidence and proportionality rule', async () => {
    const planning = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    const section = sectionOf(planning, '## Problem framing and impact');

    expect(section, 'the framing section exists').not.toBe('');
    expect(section, 'the skill requires direct and second-order impact').toMatch(/second-order/i);
    expect(section, 'the impact record carries evidence').toMatch(/evidence/i);
    expect(section, 'the skill keeps the proportionality rule').toMatch(/proportional/i);
  });
});

describe('REQ-003/AC-004 planning alternatives', () => {
  it('AC-004: the plan template ships a Problem framing and alternatives section requiring the leading approach, strongest objection, answering evidence and considered alternatives', async () => {
    const planTemplate = await readFile(packagePath('templates', 'skills', 'planning', 'references', 'plan.md'), 'utf8');
    const section = sectionOf(planTemplate, '## Problem framing and alternatives');

    expect(section, 'the plan template contains the exact heading ## Problem framing and alternatives').not.toBe('');
    expect(section, 'the section requires the leading approach').toMatch(/leading approach/i);
    expect(section, 'the section requires the strongest objection').toMatch(/strongest objection/i);
    expect(section, 'the section requires the evidence that answers the objection').toMatch(/evidence that answers/i);
    expect(section, 'the section requires the alternative that survives').toMatch(/alternative that survives/i);
    expect(section, 'the section requires every materially different alternative considered').toMatch(
      /every materially different alternative/i,
    );
  });

  it('AC-004: the alternatives section requires an explicit no-material-alternative statement and forbids inventing one', async () => {
    const planTemplate = await readFile(packagePath('templates', 'skills', 'planning', 'references', 'plan.md'), 'utf8');
    const section = sectionOf(planTemplate, '## Problem framing and alternatives');

    expect(section, 'the section states the explicit no-material-alternative case').toMatch(
      /no (material|materially different) alternative/i,
    );
    expect(section, 'the section forbids inventing an alternative').toMatch(/invent/i);
  });

  it('AC-004: the planning skill repeats the strongest-objection/alternatives rule and the explicit none case', async () => {
    const planning = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    const section = sectionOf(planning, '## Problem framing and impact');

    expect(section, 'the framing section exists').not.toBe('');
    expect(section, 'the skill repeats the strongest objection').toMatch(/strongest objection/i);
    expect(section, 'the skill repeats the alternatives rule').toMatch(/alternative/i);
    expect(section, 'the skill repeats the explicit no-material-alternative case').toMatch(
      /no (material|materially different) alternative|no-material-alternative/i,
    );
  });
});

describe('REQ-004/AC-005 direct defect cause', () => {
  it('AC-005: the coding skill direct defect procedure requires a stable public-interface regression test, the triggering condition and cause, and a cause-level fix', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    const procedure = sectionOf(coding, '## Procedure');

    expect(procedure, 'the Procedure section exists').not.toBe('');
    expect(procedure, 'the procedure requires a stable public-interface regression test').toMatch(
      /public-interface regression test/i,
    );
    expect(procedure, 'the procedure requires the triggering condition').toMatch(/triggering condition/i);
    expect(procedure, 'the procedure requires the cause').toMatch(/cause/i);
    expect(procedure, 'the procedure requires a fix of the cause rather than the symptom').toMatch(
      /(cause[^.]{0,120}symptom|symptom[^.]{0,120}cause)/i,
    );
    expect(procedure, 'the procedure requires retention of the regression test').toMatch(/retain/i);
  });

  it('AC-005: the direct path still dispatches neither review axis and adds no new review gate', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');

    expect(coding, 'the direct path keeps the no dual-axis review rule').toMatch(/without the dual-axis review/i);
    expect(coding, 'the Direct change routing class is unchanged').toMatch(/Direct change[^\n]*bounded adjustment/i);
  });
});

describe('REQ-005/AC-006 standards review maintainability', () => {
  it('AC-006: the Standards Review mission and review checklist require a maintainability lens', async () => {
    const standards = await readFile(packagePath('templates', 'agents', 'standards-review.md'), 'utf8');
    const mission = sectionOf(standards, '## Mission and authority');
    const checklist = sectionOf(standards, '## Review checklist');

    expect(mission, 'the mission section exists').not.toBe('');
    expect(mission, 'the mission requires the maintainability lens').toMatch(/maintainab/i);
    expect(checklist, 'the review checklist exists').not.toBe('');
    expect(checklist, 'the checklist requires the maintainability lens').toMatch(/maintainab/i);
  });

  it('AC-006: the redundancy and key-comment dimension carries the maintainability lens with its four coverage cases', async () => {
    const standards = await readFile(packagePath('templates', 'agents', 'standards-review.md'), 'utf8');
    const dimension = sectionOf(standards, '### Redundancy and key comments');

    expect(dimension, 'the redundancy and key-comment dimension exists').not.toBe('');
    expect(dimension, 'the dimension covers maintainability').toMatch(/maintainab/i);
    expect(dimension, 'the dimension covers confusing naming').toMatch(/naming/i);
    expect(dimension, 'the dimension covers an abstraction that hides data flow').toMatch(/abstraction/i);
    expect(dimension, 'the abstraction hides the data flow').toMatch(/data flow/i);
    expect(dimension, 'the dimension covers unclear ownership').toMatch(/ownership/i);
    expect(dimension, 'the dimension covers context load').toMatch(/context load/i);
    expect(dimension, 'the context load forces reconstructing non-obvious intent').toMatch(/reconstruct/i);
    expect(dimension, 'the intent is non-obvious').toMatch(/non-obvious intent/i);
  });

  it('AC-006: a maintainability finding names the exact path or symbol and the concrete context cost, stays advisory unless it causes a defect, and rejects cost-free naming or formatting preferences', async () => {
    const standards = await readFile(packagePath('templates', 'agents', 'standards-review.md'), 'utf8');
    const dimension = sectionOf(standards, '### Redundancy and key comments');
    const finding = sectionOf(standards, '## Finding format');

    expect(dimension, 'a finding names the exact path or symbol').toMatch(/exact path or symbol/i);
    expect(dimension, 'a finding names the concrete context cost').toMatch(/context cost/i);
    expect(dimension, 'the finding is advisory unless it causes a defect').toMatch(/advisory unless it causes a defect/i);
    expect(dimension, 'a naming or formatting preference without the cost is not a finding').toMatch(
      /naming or formatting preference/i,
    );
    expect(dimension, 'such a preference is not a finding').toMatch(/not a finding/i);
    expect(finding, 'the finding format section exists').not.toBe('');
    expect(finding, 'the finding format requires the exact path or symbol').toMatch(/exact path or symbol/i);
    expect(finding, 'the finding format requires the concrete context cost').toMatch(/context cost/i);
    expect(finding, 'the finding format keeps the advisory severity').toMatch(/advisory/i);
  });

  it('AC-006: the existing three dimensions and severity semantics remain', async () => {
    const standards = await readFile(packagePath('templates', 'agents', 'standards-review.md'), 'utf8');

    expect(standards, 'the logic and boundary dimension remains').toMatch(/### Logic and boundary correctness/);
    expect(standards, 'the security risk dimension remains').toMatch(/### Security risk/);
    expect(standards, 'the redundancy and key-comment dimension remains').toMatch(/### Redundancy and key comments/);
    expect(standards, 'the error severity stays limited to merge-blocking violations').toMatch(
      /error only for a merge-blocking/i,
    );
    expect(standards, 'non-defect findings stay advisory').toMatch(/advisory unless it causes a defect/i);
  });
});

describe('REQ-006/AC-007 durable alignment', () => {
  it('AC-007: the project contract template carries the planning decision-quality and maintainability clauses and the tracked mirror is byte-identical', async () => {
    const template = await readFile(packagePath('templates', 'project', 'AGENTS.md'), 'utf8');
    const mirror = await readFile(packagePath('.ai-workflow', 'AGENTS.md'));
    const templateBytes = await readFile(packagePath('templates', 'project', 'AGENTS.md'));

    expect(template, 'the contract template carries the planning framing clause').toMatch(/problem framing/i);
    expect(template, 'the contract template carries the maintainability clause').toMatch(/maintainab/i);
    expect(
      mirror.equals(templateBytes),
      'the tracked contract mirror is byte-identical to templates/project/AGENTS.md',
    ).toBe(true);
  });

  it('AC-007: MEMORY.md records the current planning and review standards and README.md describes the user-facing behavior', async () => {
    const memory = await readFile(packagePath('MEMORY.md'), 'utf8');
    const readme = await readFile(packagePath('README.md'), 'utf8');

    expect(memory, 'MEMORY.md records the planning decision-quality standard').toMatch(/problem framing/i);
    expect(memory, 'MEMORY.md records the maintainability review standard').toMatch(/maintainab/i);
    expect(readme, 'README.md describes the planning decision-quality behavior').toMatch(/problem framing/i);
    expect(readme, 'README.md describes the maintainability review behavior').toMatch(/maintainab/i);
  });

  it('AC-007: the implemented note triplet exists', async () => {
    for (const suffix of ['.md', '.zh.md', '.i18n.yaml']) {
      const path = `.ai-workflow/notes/implemented/process/2026-11-17-planning-decision-quality${suffix}`;
      expect(await fileExists(path), `${path} exists`).toBe(true);
    }
  });

  it('AC-007: navigation.json indexes the planning-decision-quality feature with its paths, tests and responsibility', async () => {
    const raw = await readFile(packagePath('.ai-workflow', 'index', 'navigation.json'), 'utf8');
    const index = JSON.parse(raw) as {
      features?: Array<{
        id?: string;
        module_root?: string;
        owner_role?: string;
        entries?: string[];
        related_files?: string[];
        tests?: string[];
        responsibility?: string;
      }>;
    };
    const feature = index.features?.find((entry) => entry.id === 'planning-decision-quality');

    expect(feature, 'navigation.json contains the planning-decision-quality feature').toBeDefined();
    if (!feature) throw new Error('planning-decision-quality feature missing from navigation.json');

    expect(feature.module_root, 'the feature lives at the root module').toBe('root');
    expect(feature.owner_role, 'the feature is shared').toBe('shared');

    const surface = new Set<string>([
      ...(feature.entries ?? []),
      ...(feature.related_files ?? []),
      ...(feature.tests ?? []),
    ]);
    const expectedPaths = [
      'templates/skills/planning/SKILL.md',
      'templates/skills/planning/references/spec.md',
      'templates/skills/planning/references/plan.md',
      'templates/agents/spec-review.md',
      'templates/skills/coding/SKILL.md',
      'templates/agents/standards-review.md',
      'templates/project/AGENTS.md',
      '.ai-workflow/AGENTS.md',
      'MEMORY.md',
      'README.md',
      '.ai-workflow/notes/implemented/process/2026-11-17-planning-decision-quality.md',
      'tests/behavior/planning-decision-quality.test.ts',
    ];
    for (const path of expectedPaths) {
      expect(surface.has(path), `the feature indexes ${path}`).toBe(true);
    }

    const responsibility = (feature.responsibility ?? '').toLowerCase();
    expect(responsibility, 'the responsibility names planning framing').toMatch(/framing/);
    expect(responsibility, 'the responsibility names the impact rule').toMatch(/impact/);
    expect(responsibility, 'the responsibility names the alternatives rule').toMatch(/alternative/);
    expect(responsibility, 'the responsibility names the defect cause rule').toMatch(/defect/);
    expect(responsibility, 'the responsibility names the cause rule').toMatch(/cause/);
    expect(responsibility, 'the responsibility names maintainability').toMatch(/maintainab/);
  });

  it('AC-007: no new skill or role is installed and the change-class routing and dual-axis review trigger stay unchanged', async () => {
    const skillDirs = (await readdir(packagePath('templates', 'skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(skillDirs, 'the installed skill directory set is unchanged').toEqual([
      'coding',
      'git-message',
      'plan-to-tasks',
      'planning',
      'setup-ai-workflow',
      'switch-profile',
      'sync-ai-workflow',
    ]);

    const roleFiles = (await readdir(packagePath('templates', 'agents')))
      .filter((name) => name.endsWith('.md'))
      .sort();
    expect(roleFiles, 'the installed role file set is unchanged').toEqual([
      'backend.md',
      'documentation-maintainer.md',
      'file-explorer.md',
      'frontend.md',
      'git-operator.md',
      'researcher.md',
      'spec-review.md',
      'standards-review.md',
      'test.md',
    ]);

    const contract = await readFile(packagePath('templates', 'project', 'AGENTS.md'), 'utf8');
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    expect(contract, 'the contract keeps the change-class routing heading').toMatch(/## Change routing/);
    expect(contract, 'the contract keeps the Direct change class').toMatch(/Direct change[^\n]*bounded adjustment/i);
    expect(contract, 'the contract keeps the dual-axis dispatch trigger unchanged').toMatch(
      /Direct or Mechanical change dispatches neither axis/i,
    );
    expect(contract, 'the contract keeps the simultaneous Spec Review and Standards Review batch').toMatch(
      /simultaneous Spec Review and Standards Review/i,
    );
    expect(coding, 'the coding skill keeps the change-class routing heading').toMatch(/## Change routing/);
    expect(coding, 'the coding skill keeps the no dual-axis review rule for direct and mechanical changes').toMatch(
      /without the dual-axis review/i,
    );
    expect(coding, 'the coding skill keeps the simultaneous one-batch review dispatch').toMatch(
      /simultaneously in one parallel batch/i,
    );
  });
});

async function fileExists(relativePath: string): Promise<boolean> {
  try {
    await access(packagePath(...relativePath.split('/')));
    return true;
  } catch {
    return false;
  }
}

/**
 * The raw, unnormalized text of one level-two or level-three section, so the
 * table shape can be asserted line by line.
 */
function rawSectionOf(text: string, heading: string): string {
  const src = `\n${text}`;
  const marker = `\n${heading}\n`;
  const start = src.indexOf(marker);
  if (start === -1) return '';
  const body = src.slice(start + marker.length);
  const next = body.search(/\n#{2,6} /);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * The whitespace-normalized text of one level-two or level-three section, so a
 * contract rule is asserted where it is authored.
 */
function sectionOf(text: string, heading: string): string {
  return rawSectionOf(text, heading).replace(/\s+/g, ' ').trim();
}
