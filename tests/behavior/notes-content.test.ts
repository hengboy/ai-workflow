import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { packagePath } from '../../src/utils/schema.js';

// REQ-001..REQ-004 / AC-001..AC-008: note creation is governed by lasting decision
// rationale that code, tests and existing documentation cannot adequately explain, and
// active records are kept, archived or deleted by future-guidance value. These are
// structural content checks over the shipped templates; they do not prove that a
// recorded rationale is truthful or sufficient, which semantic review establishes.
const WORKFLOW_ARTIFACTS = [
  'templates/skills/planning/SKILL.md',
  'templates/skills/plan-to-tasks/SKILL.md',
  'templates/skills/coding/SKILL.md',
  'templates/agents/file-explorer.md',
  'templates/agents/documentation-maintainer.md',
  'templates/agents/spec-review.md',
  'templates/agents/standards-review.md',
  'templates/agents/git-operator.md',
];

const NOTES_GOVERNANCE_CONSUMERS = [
  'templates/skills/planning/SKILL.md',
  'templates/skills/plan-to-tasks/SKILL.md',
  'templates/skills/coding/SKILL.md',
  'templates/agents/documentation-maintainer.md',
  'templates/agents/standards-review.md',
];

const PROJECT_CONTRACT = '.ai-workflow/AGENTS.md';
const NOTES_README = '.ai-workflow/notes/README.md';

// An unconditional universal creation trigger requires a note for every non-mechanical
// change, decision, plan or task and contradicts the lasting-rationale criterion. The
// patterns cover every spelling the shipped consumers carry today.
const UNIVERSAL_CREATION_TRIGGERS: readonly RegExp[] = [
  /Every non-mechanical (?:change|decision) adds or updates a relevant note/i,
  /Every non-mechanical (?:change|decision|plan|task)[^.\n]{0,80}(?:note|triplet)/i,
  /\bnon-mechanical (?:change|decision|plan|task)\b[^.\n]{0,60}\b(?:includes?|requires?|needs?|adds?|updates?)\b[^.\n]{0,40}\bnote\b/i,
];

const OLD_UNIVERSAL_SENTENCE =
  'Every non-mechanical change adds or updates at least one relevant note triplet in the same change.';

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

// Extract a single level-two section so a rule is asserted where it is authored.
function levelTwoSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

// the self-containment governance has one source, the notes README,
// and its generated local mirror must stay byte-identical to the shipped template.
const NOTES_README_MIRRORS = [
  'templates/project/notes/README.md',
  '.ai-workflow/notes/README.md',
];

// concrete transient plan-internal identifier patterns a
// note body must not carry. The placeholder vocabulary (`task-NNN-slug`, `REQ-###`)
// carries no digits and so is deliberately not matched.
const TRANSIENT_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  // task-NNN with digits; the placeholder `task-NNN-slug` stays allowed.
  /\btask-\d+/i,
  // a numbered task, step or phase in English.
  /\btasks?\s+\d+/i,
  /\bsteps?\s+\d+/i,
  /\bphases?\s+\d+/i,
  // a numbered step or phase in Chinese (步骤 1 / 阶段 2).
  /步骤\s*\d+/,
  /阶段\s*\d+/,
  // REQ-### or AC-### with digits; the placeholders `REQ-###` / `AC-###` stay allowed.
  /\b(?:REQ|AC)-\d+/,
  // an eight-digit-date plan directory name such as `20261017-...`.
  /\b20\d{6}-/,
];

// every markdown body under an active lifecycle, recursively and in a
// deterministic order.
async function markdownFilesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFilesUnder(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

describe('agent notes workflow content', () => {
  it('loads the project contract from every shipped skill and workflow role', async () => {
    for (const path of WORKFLOW_ARTIFACTS) {
      const text = await read(path);
      expect(text, `${path} loads ${PROJECT_CONTRACT}`).toContain(PROJECT_CONTRACT);
    }
  });

  it('routes note format and governance through the single-source README', async () => {
    const governance = await read('templates/project/notes/README.md');
    expect(governance, 'README is the single source').toMatch(/single source/i);
    expect(governance, 'delivered records use Decision').toContain('Decision');
    expect(governance, 'delivered records use Consequences').toContain('Consequences');
    expect(governance, 'status-only transitions are rejected').toMatch(/only Status|Status[^.]{0,80}insufficient/i);
    expect(governance, 'supersession is governed').toMatch(/supersession/i);
    expect(governance, 'archiving is governed').toMatch(/archive policy/i);

    for (const path of NOTES_GOVERNANCE_CONSUMERS) {
      const text = await read(path);
      expect(text, `${path} points at ${NOTES_README}`).toContain(NOTES_README);
    }

    // Notes governance is a generic workflow obligation owned by the generated contract; the
    // project-owned MEMORY scaffolding no longer restates it.
    const contractText = await read('templates/project/AGENTS.md');
    expect(contractText, `templates/project/AGENTS.md points at ${NOTES_README}`).toContain(NOTES_README);
  });

  it('requires every workflow skill and role to explicitly load all four fixed contexts', async () => {
    const FIXED_CONTEXT = [
      '.ai-workflow/AGENTS.md',
      'MEMORY.md',
      '.ai-workflow/index/navigation.json',
      '.ai-workflow/index/navigation.md',
    ];
    for (const path of WORKFLOW_ARTIFACTS) {
      const text = await read(path);
      for (const fixed of FIXED_CONTEXT) {
        expect(text, `${path} explicitly loads ${fixed}`).toContain(fixed);
      }
    }
  });

  it('documents the bilingual note triplet in the governance source and its consumers', async () => {
    const governance = await read('templates/project/notes/README.md');
    expect(governance, 'the governance source describes the Chinese body').toContain('.zh.md');
    expect(governance, 'the governance source describes the consistency record').toContain('.i18n.yaml');
    expect(governance, 'the consistency record stores git blob hashes').toMatch(/git blob hash/i);
    expect(governance, 'language switchers are required').toMatch(/language switcher/i);
    expect(governance, 'the pairing command records pairs').toMatch(/notes pairing/);

    const maintainer = await read('templates/agents/documentation-maintainer.md');
    expect(maintainer, 'the maintainer maintains bilingual triplets').toMatch(/bilingual triplet/i);
    expect(maintainer, 'the maintainer records confirmed pairs').toMatch(/notes pairing/);
  });

  it('no longer treats ADR as the current decision mechanism in shipped skills, roles and contracts', async () => {
    const artifacts = [
      ...WORKFLOW_ARTIFACTS,
      'templates/project/AGENTS.md',
      'templates/project/MEMORY.md',
      'templates/project/notes/README.md',
    ];
    for (const path of artifacts) {
      const text = await read(path);
      expect(text, `${path} has no retired adr command`).not.toMatch(/ai-workflow\s+adr\b/i);
      expect(text, `${path} has no retired adr storage path`).not.toMatch(/\.ai-workflow\/adr\b/);
      expect(text, `${path} has no retired adr file naming`).not.toContain('NNNN-kebab-title.md');
      expect(text, `${path} has no retired adr status value`).not.toContain('superseded-by ADR-NNNN');
      expect(text, `${path} has no ADR rule text`).not.toMatch(/\bADRs?\b/);
    }
  });

  it('specifies lasting decision rationale as the note creation criterion', async () => {
    const governance = await read('templates/project/notes/README.md');
    const maintenance = levelTwoSection(governance, '## Maintenance and lifecycle');

    expect(maintenance, 'creation is governed by lasting decision rationale').toMatch(
      /lasting\s+(?:decision\s+)?rationale/i,
    );
    expect(maintenance, 'code, tests and existing documentation cannot adequately explain it').toMatch(
      /code[^.\n]{0,80}tests?[^.\n]{0,140}(?:documentation|docs)[^.\n]{0,120}(?:cannot|can ?not|can't)[^.\n]{0,40}explain/i,
    );
    expect(governance, 'the unconditional every-non-mechanical triplet sentence is removed').not.toContain(
      OLD_UNIVERSAL_SENTENCE,
    );
  });

  it('names behavior changes, file counts and added tests as insufficient on their own', async () => {
    const governance = await read('templates/project/notes/README.md');
    const maintenance = levelTwoSection(governance, '## Maintenance and lifecycle');

    expect(maintenance, 'behavior changes, file counts and added tests alone are insufficient').toMatch(
      /behavior changes?[^.\n]{0,140}(?:file counts?|added tests?)[^.\n]{0,180}(?:insufficient|not (?:by themselves )?sufficient|do(?:es)? not (?:alone )?(?:require|justify)|are not enough)/i,
    );
  });

  it('exempts local, mechanical, UI, copy and formatting changes without lasting rationale', async () => {
    const governance = await read('templates/project/notes/README.md');
    const maintenance = levelTwoSection(governance, '## Maintenance and lifecycle');

    expect(maintenance, 'the exemption names local, mechanical, UI, copy and formatting changes').toMatch(
      /local[^.\n]{0,200}(?:UI|copy|formatting)[^.\n]{0,200}(?:exempt|not required|no note)/i,
    );
    expect(maintenance, 'the exemption applies without such lasting rationale').toMatch(
      /without[^.\n]{0,80}(?:such\s+)?(?:lasting\s+)?rationale|no lasting rationale|unless[^.\n]{0,80}rationale/i,
    );
  });

  it('requires reusing the owning note and a new note for a changed decision', async () => {
    const governance = await read('templates/project/notes/README.md');
    const maintenance = levelTwoSection(governance, '## Maintenance and lifecycle');

    expect(maintenance, 'reuse the existing note that owns the same decision').toMatch(
      /reuse[^.\n]{0,80}note|existing note that owns|owns the same decision/i,
    );
    expect(maintenance, 'shipped facts stay current in the same change').toMatch(
      /keep[^.\n]{0,120}facts[^.\n]{0,120}current|facts[^.\n]{0,80}current/i,
    );
    expect(maintenance, 'a changed recorded decision or lasting rationale requires a new note').toMatch(
      /changed[^.\n]{0,80}decision[^.\n]{0,120}new note/i,
    );
  });

  it('defines the keep, archive and delete retention outcomes in the archive policy', async () => {
    const governance = await read('templates/project/notes/README.md');
    const archive = levelTwoSection(governance, '## Archive policy');

    expect(archive, 'keep a record while guidance such as alternatives, guarantees or reintroduction remains').toMatch(
      /alternatives[^.\n]{0,120}ownership[^.\n]{0,160}(?:guarantees|data semantics|reintroduction)/i,
    );
    expect(archive, 'archive only a completed implemented decision with historical value but little guidance').toMatch(
      /little future guidance|historical (?:decision )?value/i,
    );
    expect(archive, 'delete an active implemented record limited to small UI or mechanical detail').toMatch(
      /delet\w*[^.\n]{0,140}(?:UI|purely mechanical|mechanical change)/i,
    );
    expect(archive, 'age, length and quotas never select an outcome').toMatch(
      /age[^.\n]{0,40}length[^.\n]{0,40}quotas/i,
    );
  });

  it('protects substantive decisions from size-based deletion', async () => {
    const governance = await read('templates/project/notes/README.md');
    const archive = levelTwoSection(governance, '## Archive policy');

    expect(archive, 'a small bug fix, performance change or capability decision is not deletion-eligible for size alone').toMatch(
      /bug fix[^.\n]{0,120}(?:performance|capabilit)[^.\n]{0,160}(?:does not qualify|not qualify|merely because|is small)/i,
    );
  });

  it('preserves rejected-retention, authorized-deletion and frozen-archive boundaries', async () => {
    const governance = await read('templates/project/notes/README.md');
    const archive = levelTwoSection(governance, '## Archive policy');

    expect(archive, 'a rejected record is retained only while it prevents a plausible, meaningful mistake').toMatch(
      /rejected[^.\n]{0,160}(?:prevent|plausible|meaningful mistake)/i,
    );
    expect(archive, 'an obsolete proposal is rejected instead of archived').toMatch(
      /reject obsolete proposals? instead/i,
    );
    expect(archive, 'authorized deletion removes the complete triplet and repairs inbound links').toMatch(
      /delet\w*[^.\n]{0,160}complete triplet[^.\n]{0,160}inbound links/i,
    );
    expect(archive, 'sealed archive prohibitions still apply').toMatch(
      /sealed[^.\n]{0,120}(?:do not|never)[^.\n]{0,80}(?:modify|rewrite|delete|reorder)/i,
    );
  });

  it('keeps the five consumers on the authoritative README without a universal creation trigger', async () => {
    for (const path of NOTES_GOVERNANCE_CONSUMERS) {
      const text = await read(path);
      expect(text, `${path} points at ${NOTES_README}`).toContain(NOTES_README);
      for (const trigger of UNIVERSAL_CREATION_TRIGGERS) {
        expect.soft(text, `${path} carries no universal creation trigger ${trigger.source}`).not.toMatch(trigger);
      }
    }
  });

  it('keeps each consumer note maintenance responsibility', async () => {
    const coding = await read('templates/skills/coding/SKILL.md');
    expect(coding, 'coding runs the notes validator').toMatch(/ai-workflow notes validate/i);
    expect(coding, 'coding lands the implemented transition').toMatch(/\bimplemented\b/i);

    const maintainer = await read('templates/agents/documentation-maintainer.md');
    expect(maintainer, 'maintainer owns supersession decisions').toMatch(/supersession|supersess/i);
    expect(maintainer, 'maintainer keeps complete bilingual triplets').toMatch(/bilingual triplet/i);

    const standards = await read('templates/agents/standards-review.md');
    expect(standards, 'standards review keeps its notes-rules pointer').toMatch(/notes rules/i);

    const planning = await read('templates/skills/planning/SKILL.md');
    expect(planning, 'planning keeps MEMORY alignment').toMatch(/align[^.\n]{0,40}MEMORY\.md|MEMORY\.md[^.\n]{0,80}align/i);

    const planToTasks = await read('templates/skills/plan-to-tasks/SKILL.md');
    expect(planToTasks, 'plan-to-tasks requires a note update for a decision that lands one').toMatch(
      /note update|update[^.\n]{0,40}note/i,
    );
  });

  it('maintains and validates existing notes under the README-governed criterion', async () => {
    const coding = await read('templates/skills/coding/SKILL.md');
    expect(coding, 'coding runs the notes validator').toMatch(/notes validate/i);
    expect(coding, 'coding transitions proposed work to implemented').toMatch(/\bimplemented\b/i);
    expect(coding, 'coding defers the note criterion to the authoritative README').toMatch(
      /README[^.\n]{0,160}(?:single source|governance|criteri(?:on|a)|rationale)/i,
    );

    const maintainer = await read('templates/agents/documentation-maintainer.md');
    expect(maintainer, 'maintainer owns supersession decisions').toMatch(/supersess/i);

    const standards = await read('templates/agents/standards-review.md');
    expect(standards, 'standards review checks MEMORY and its referenced notes rules').toMatch(/referenced notes|notes rules/i);
  });

  it('keeps worktree, ownership and read-only review boundaries intact', async () => {
    const coding = await read('templates/skills/coding/SKILL.md');
    expect(coding).toMatch(/project-local temporary worktree/i);
    expect(coding).toMatch(/Git Operator is the only role allowed to run Git|Git operations are allowed only through Git Operator/i);

    const maintainer = await read('templates/agents/documentation-maintainer.md');
    expect(maintainer).toMatch(/^tools: \[read, edit\]$/m);
    expect(maintainer).toMatch(/may not run Git/i);
    expect(maintainer).toMatch(/may not edit source/i);

    for (const path of ['templates/agents/spec-review.md', 'templates/agents/standards-review.md']) {
      expect(await read(path), `${path} stays read-only`).toMatch(/^tools: \[read\]$/m);
    }
  });

  it('keeps the review axes distinct: spec/plan acceptance authority versus project standards', async () => {
    const specReview = await read('templates/agents/spec-review.md');
    // REQ-007: Spec Review uses the frozen spec and plan as its acceptance authority and must
    // not promote MEMORY (project rules) into that acceptance authority.
    expect(specReview, 'Spec Review is bounded by the frozen documents').toMatch(
      /sole authorit(?:y|ies)[^.\n]*supplied spec, plan and task documents/i,
    );
    expect(specReview, 'Spec Review does not treat MEMORY as acceptance authority').toMatch(/apply MEMORY standards/i);

    const standardsReview = await read('templates/agents/standards-review.md');
    // REQ-007: Standards Review keeps project standards (MEMORY and its referenced notes rules).
    expect(standardsReview, 'Standards Review stays on MEMORY standards').toMatch(
      /against root `?MEMORY\.md`?|MEMORY\.md.*standards authority/i,
    );
    expect(standardsReview, 'Standards Review uses the spec only as input, not as a standards source').toMatch(
      /do not[^.\n]{0,60}use the spec as a standards source/i,
    );
  });

  // the README is the single governance source for the
  // self-containment rule, its durable-term guidance and the sanctioned exception, and
  // the generated local mirror must match the template byte-for-byte.
  it('governs self-contained note bodies and mirrors the notes README byte-for-byte', async () => {
    const templateReadme = await readFile(packagePath('templates/project/notes/README.md'));
    const localReadme = await readFile(packagePath('.ai-workflow/notes/README.md'));
    expect(
      localReadme.equals(templateReadme),
      'the tracked .ai-workflow/notes/README.md mirror equals templates/project/notes/README.md byte-for-byte',
    ).toBe(true);

    for (const path of NOTES_README_MIRRORS) {
      const governance = await readFile(packagePath(path), 'utf8');
      const maintenance = levelTwoSection(governance, '## Maintenance and lifecycle').replace(/\s+/g, ' ');

      expect(maintenance, `${path} states a note stays self-contained after its plan is gone`).toMatch(
        /self-contained[^.]{0,200}(?:plan is gone|after (?:its|the) plan)|understandable after (?:its|the) plan|understandable without the plan/i,
      );
      expect(maintenance, `${path} names the transient identifier set`).toMatch(
        /task IDs?[^.]{0,140}step numbers?[^.]{0,140}phase numbers?[^.]{0,220}(?:REQ|AC)[^.]{0,140}plan director/i,
      );
      expect(maintenance, `${path} anchors note bodies to durable terms, not those identifiers`).toMatch(
        /(?:never|no|not)[^.]{0,100}(?:carry|anchor|reference|use)[^.]{0,100}(?:transient|identifiers?)/i,
      );
      expect(maintenance, `${path} gives durable-term guidance naming behavior, paths, symbols, guarantees and ownership`).toMatch(
        /\bbehavior\b[^.]{0,160}\bpaths\b[^.]{0,160}\bsymbols\b[^.]{0,160}\bguarantees\b[^.]{0,160}\bownership\b/i,
      );
      expect(maintenance, `${path} names validation evidence as a durable term`).toMatch(/validation evidence/i);
      expect(maintenance, `${path} keeps the workspace cross-repository plain plan-ID exception`).toMatch(
        /workspace[^.]{0,160}plain plan-ID[^.]{0,160}(?:only|sanctioned|exception)|plain plan-ID[^.]{0,160}(?:only|sanctioned) exception/i,
      );
      expect(maintenance, `${path} cleans an existing active note by rewriting its anchor durably`).toMatch(
        /existing[^.]{0,140}note[^.]{0,180}clean[^.]{0,180}rewrit/i,
      );
      expect(maintenance, `${path} preserves decision, alternatives, consequences and evidence claims`).toMatch(
        /preserv[^.]{0,180}decision[^.]{0,220}alternatives[^.]{0,220}consequences[^.]{0,220}evidence/i,
      );
      expect(maintenance, `${path} updates both language sides and re-records the pair`).toMatch(
        /both language sides|both sides[^.]{0,140}(?:change|update)|re-record/i,
      );
      expect(maintenance, `${path} never cleans sealed archived notes`).toMatch(
        /archiv[^.]{0,180}(?:never|not)[^.]{0,100}clean|sealed[^.]{0,100}never cleaned|never clean[^.]{0,100}archiv/i,
      );
    }
  });

  // the active notes tree is scanned for concrete transient
  // plan-internal identifier patterns. The placeholder vocabulary (`task-NNN-slug`,
  // `REQ-###`) is not an identifier and stays allowed.
  it('keeps active note bodies free of concrete transient plan-internal identifiers', async () => {
    const activeRoots = ['proposed', 'implemented', 'rejected'];
    const files: string[] = [];
    for (const lifecycle of activeRoots) {
      files.push(...(await markdownFilesUnder(packagePath('.ai-workflow', 'notes', lifecycle))));
    }
    files.sort();

    for (const placeholder of ['task-NNN-slug', 'task-NNN-slug.md', 'REQ-###', 'AC-###']) {
      for (const pattern of TRANSIENT_IDENTIFIER_PATTERNS) {
        expect(pattern.test(placeholder), `the scan ignores the placeholder "${placeholder}"`).toBe(false);
      }
    }

    const offenders: string[] = [];
    for (const file of files) {
      const body = await readFile(file, 'utf8');
      for (const pattern of TRANSIENT_IDENTIFIER_PATTERNS) {
        const match = body.match(pattern);
        if (match) offenders.push(`${relative(packagePath(), file)} matches ${pattern} -> "${match[0]}"`);
      }
    }

    expect(
      offenders,
      `active note bodies must not carry concrete transient plan-internal identifiers:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
