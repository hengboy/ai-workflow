import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Behavior boundary: the shipped review/repair/integration policy that `install` and
// `init` copy into hosts and projects. These assertions read the same template files a
// native agent actually receives, so they describe the published policy. They are static
// shipped-content evidence, not proof of live model behavior.

const CONTRACT = 'templates/project/AGENTS.md';
const CODING = 'templates/skills/coding/SKILL.md';
const PLANNING = 'templates/skills/planning/SKILL.md';
const WORKSPACE_REFERENCE = 'templates/skills/coding/references/workspace.md';
const SPEC_REVIEW = 'templates/agents/spec-review.md';
const STANDARDS_REVIEW = 'templates/agents/standards-review.md';
const GIT_OPERATOR = 'templates/agents/git-operator.md';

// Owners that publish the findings-closure policy in English. The generated contract is
// the generic authority; the coding skill is the closure actor; the rest are the tracked
// local mirror and the delivered README and implemented-note alignment. REQ-004/AC-004
// moves the review-closure standard out of MEMORY.md and into the contract, so MEMORY.md
// is no longer a closure owner.
const CLOSURE_OWNERS: ReadonlyArray<readonly [string, string]> = [
  ['templates/project/AGENTS.md', 'the generated project contract'],
  ['templates/skills/coding/SKILL.md', 'the coding skill'],
  ['.ai-workflow/AGENTS.md', 'the tracked project contract mirror'],
  ['README.md', 'README'],
  ['.ai-workflow/notes/implemented/process/2026-10-14-review-boundaries-and-repair.md', 'the implemented review-policy note'],
];

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

/** Whitespace-normalized text so assertions are insensitive to wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** True when at least one approved phrasing of one policy clause is present. */
function anyMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function joined(...texts: string[]): string {
  return texts.join(' ');
}

/**
 * The findings-closure region around an anchor clause, not the whole document, so an
 * unrelated mention elsewhere cannot satisfy or mask the requirement.
 */
function closureWindow(text: string, anchor: RegExp, before = 500, after = 1400): string {
  const flat = flatten(text);
  const match = anchor.exec(flat);
  if (!match) return '';
  const start = Math.max(0, match.index - before);
  const end = Math.min(flat.length, match.index + after);
  return flat.slice(start, end);
}

describe('review boundary routing (REQ-001 / AC-001, AC-002)', () => {
  it('routes Direct, Mechanical, Planning, plan-to-tasks and ordinary planned work by class and boundary', async () => {
    const contract = flatten(await read(CONTRACT));
    const coding = flatten(await read(CODING));

    expect(
      anyMatch(contract, [
        /\bDirect\b[^.]{0,320}?(?:neither|not\b|no\b|without|skip\w*)[^.]{0,160}?(?:ax(?:is|es)|reviews?|dual-axis)/i,
      ]),
      'Direct changes dispatch neither review axis',
    ).toBe(true);

    expect(
      anyMatch(contract, [
        /\bMechanical\b[^.]{0,320}?(?:neither|not\b|no\b|without|skip\w*)[^.]{0,160}?(?:ax(?:is|es)|reviews?|dual-axis)/i,
      ]),
      'Mechanical changes dispatch neither review axis',
    ).toBe(true);

    expect(
      anyMatch(contract, [
        /\bPlanning\b[^.]{0,260}?\bSpec(?: Review)?\b[^.]{0,120}?\b(?:only|alone)\b/i,
        /\bPlanning\b[^.]{0,260}?\bSpec Review\b[^.]{0,160}?\b(?:not|never|no)\b[^.]{0,100}?\bStandards Review\b/i,
      ]),
      'Planning dispatches Spec Review only',
    ).toBe(true);

    expect(
      anyMatch(contract, [
        /\bplan-to-tasks\b[^.]{0,280}?(?:neither|not\b|no\b|without|skip\w*)[^.]{0,160}?(?:ax(?:is|es)|reviews?|dual-axis)/i,
      ]),
      'plan-to-tasks dispatches neither review axis',
    ).toBe(true);

    expect(
      anyMatch(joined(contract, coding), [
        /split or unsplit[^.]{0,320}?(?:one|single)[^.]{0,140}?simultaneous[^.]{0,160}?(?:Spec|Standards|pair|batch)/i,
        /split or unsplit[^.]{0,320}?simultaneous[^.]{0,160}?(?:Spec|Standards|pair|batch)/i,
      ]),
      'ordinary planned work, split or unsplit, runs one simultaneous final pair',
    ).toBe(true);

    expect(
      anyMatch(joined(contract, coding), [
        /(?:no|never|not)\b[^.]{0,160}?(?:per-task|per task|per-phase|per phase|per-commit|per commit)[^.]{0,140}?(?:review|trigger)/i,
        /(?:per-task|per task|per-phase|per phase|per-commit|per commit)[^.]{0,140}?(?:no|never|not)\b[^.]{0,140}?(?:review|trigger)/i,
      ]),
      'there is no per-task, per-phase or per-commit review trigger',
    ).toBe(true);

    expect(
      anyMatch(joined(contract, coding), [
        /(?:after implementation|after the required checks|after implementation and required checks)[^.]{0,260}?(?:before integration|before the merge|before merging)/i,
        /(?:required checks)[^.]{0,220}?(?:before integration|before the merge|before merging)/i,
      ]),
      'the ordinary pair runs after implementation and required checks and before integration',
    ).toBe(true);

    expect(
      joined(contract, coding),
      'the undefined larger or high-risk review trigger is removed',
    ).not.toMatch(/larger or high-risk change[^.]{0,160}?dual-axis review|higher or high-risk change[^.]{0,160}?dual-axis review/i);
  });

  it('keeps per-repository delivery review and an independent finalization review while exempting a zero-task root', async () => {
    const policy = joined(
      flatten(await read(CONTRACT)),
      flatten(await read(CODING)),
      flatten(await read(WORKSPACE_REFERENCE)),
    );

    expect(
      anyMatch(policy, [/per-repository delivery review|repository delivery review/i]),
      'a workspace reviews each repository delivery',
    ).toBe(true);
    expect(
      anyMatch(policy, [/separate finalization review|independent finalization review|finalization review/i]),
      'finalization has its own review distinct from repository delivery',
    ).toBe(true);
    expect(
      anyMatch(policy, [
        /zero[- ]tasks?[^.]{0,220}?(?:no|without|implicit)[^.]{0,180}?review/i,
        /(?:without tasks|no root tasks|no tasks)[^.]{0,220}?(?:implicit|no artificial)[^.]{0,180}?review/i,
        /no artificial root[- ]delivery review/i,
      ]),
      'a zero-task root has no artificial delivery review',
    ).toBe(true);
  });
});

describe('planning review before final approval (REQ-002 / AC-003)', () => {
  it('drafts in memory, reviews, repairs and rechecks before the final confirmation preview', async () => {
    const planning = flatten(await read(PLANNING));

    expect(planning, 'the draft is reviewed before the final confirmation').toMatch(
      /Spec Review[^.]{0,320}?(?:before|prior to)[^.]{0,220}?(?:confirmation|final approval|final confirmation|approval)/i,
    );
    expect(planning, 'an in-scope error is repaired automatically').toMatch(
      /automatic\w*[^.]{0,220}?repair|repair[^.]{0,220}?automatic/i,
    );
    expect(planning, 'at most one affected-finding recheck is permitted').toMatch(
      /targeted recheck/i,
    );
    expect(planning, 'no planning artifact is written before approval').toMatch(
      /(?:before|until)[^.]{0,160}?approval[^.]{0,260}?(?:plan directory|spec\.md|digest|task)/i,
    );
  });

  it('starts a new planning boundary after a material change instead of reusing stale review evidence', async () => {
    const planning = flatten(await read(PLANNING));
    expect(
      anyMatch(planning, [
        /material[^.]{0,220}?change[^.]{0,280}?(?:new planning boundary|new boundary|new plan id)/i,
        /(?:new planning boundary|new boundary|new plan id)[^.]{0,220}?material/i,
      ]),
      'a material change after review establishes a new planning boundary and plan ID',
    ).toBe(true);
  });
});

describe('automatic aggregate repair (REQ-003 / AC-004, AC-005)', () => {
  it('starts one aggregate repair for both axes without a selection prompt', async () => {
    const coding = flatten(await read(CODING));

    expect(
      anyMatch(coding, [
        /(?:aggregate|both axe?s|both reviews?)[^.]{0,280}?(?:one|single)[^.]{0,140}?repair/i,
        /(?:one|single)[^.]{0,120}?aggregate[^.]{0,120}?repair/i,
      ]),
      'the primary aggregates both axes and starts one aggregate repair',
    ).toBe(true);
    expect(
      anyMatch(coding, [/automatic\w*[^.]{0,240}?repair/i]),
      'the aggregate repair is automatic',
    ).toBe(true);
    expect(coding, 'removes the routine selected-versus-all repair choice').not.toMatch(
      /Present every finding from both axes together for the user's choice|user's choice of selected repairs or repairing all findings|choice of selected repairs or repairing all findings/i,
    );
  });

  it('stops out-of-scope or unavailable-evidence work at a bounded decision instead of editing it', async () => {
    const policy = joined(flatten(await read(CONTRACT)), flatten(await read(CODING)));

    expect(
      anyMatch(policy, [
        /(?:scope expansion|out-of-scope|business|acceptance|REQ\/AC|delivered child)[^.]{0,280}?(?:bounded|decision|support|new plan)/i,
        /(?:bounded|decision|support|new plan)[^.]{0,280}?(?:scope expansion|business|acceptance|delivered child)/i,
      ]),
      'out-of-scope or business changes stop for a bounded decision',
    ).toBe(true);
    expect(
      anyMatch(policy, [
        /(?:unavailable|failing|missing)[^.]{0,200}?(?:required )?evidence[^.]{0,140}?block/i,
        /block\w*[^.]{0,200}?(?:unavailable|failing|missing)[^.]{0,140}?(?:required )?evidence/i,
      ]),
      'unavailable or failing required evidence remains blocking',
    ).toBe(true);
  });

  it('requires a reasoned disposition for retained warnings and for demonstrably unsupported or duplicate findings', async () => {
    const advisoryClause = /warnings?[^.]{0,90}?advisory[^.]{0,200}?(?:reason\w*|disposition|never masks?)/i;
    const unsupportedOrDuplicateDisposition = [
      /(?:unsupported|duplicate)[^.]{0,220}?(?:reason\w*|disposition)/i,
      /(?:reason\w*|disposition)[^.]{0,220}?(?:unsupported|duplicate)/i,
      /(?:not|never|without)[^.]{0,160}?silen(?:tly|ced?)\s+(?:drop|discard|omit)/i,
    ];

    for (const [path, label] of CLOSURE_OWNERS) {
      const text = await read(path);
      expect(text, `${label} keeps the advisory closure clause`).toMatch(advisoryClause);
      const closure = closureWindow(text, /warnings?[^.]{0,90}?advisory/i);
      expect(closure, `${label} publishes one findings-closure region`).not.toBe('');
      expect(
        anyMatch(closure, unsupportedOrDuplicateDisposition),
        `${label} requires a reasoned disposition for demonstrably unsupported or duplicate findings instead of silently dropping them`,
      ).toBe(true);
    }
  });
});

describe('one targeted recheck (REQ-004 / AC-006, AC-007)', () => {
  it('rechecks only the implicated axes, simultaneously when both are affected', async () => {
    const coding = flatten(await read(CODING));

    expect(coding, 'a boundary permits one targeted recheck batch').toMatch(
      /one targeted recheck|targeted recheck batch|targeted recheck/i,
    );
    expect(
      anyMatch(coding, [
        /only[^.]{0,200}?(?:affected|implicated)[^.]{0,140}?ax(?:is|es)/i,
        /(?:affected|implicated) ax(?:is|es)[^.]{0,180}?only/i,
      ]),
      'only the implicated axes are rechecked',
    ).toBe(true);
    expect(
      anyMatch(coding, [
        /simultaneous[^.]{0,240}?(?:both|two|both ax(?:is|es)|both affected)/i,
        /(?:both|two)[^.]{0,160}?ax(?:is|es)[^.]{0,180}?simultaneous/i,
      ]),
      'a both-axis repair rechecks both axes in one simultaneous batch',
    ).toBe(true);
  });

  it('binds original findings and fresh evidence and does not start a second full review', async () => {
    const policy = joined(
      flatten(await read(CODING)),
      flatten(await read(SPEC_REVIEW)),
      flatten(await read(STANDARDS_REVIEW)),
    );

    expect(
      anyMatch(policy, [/original finding/i]),
      'the recheck binds the original finding labels',
    ).toBe(true);
    expect(
      anyMatch(policy, [
        /(?:no|not|never)[^.]{0,200}?second full (?:repository )?review/i,
        /(?:do not|does not|never)[^.]{0,200}?(?:start|invoke|run)[^.]{0,120}?new full (?:repository )?review/i,
      ]),
      'no second full repository review is started',
    ).toBe(true);
    expect(await read(SPEC_REVIEW), 'Spec Review stays read-only').toMatch(/^tools: \[read\]$/m);
    expect(await read(STANDARDS_REVIEW), 'Standards Review stays read-only').toMatch(/^tools: \[read\]$/m);
  });
});

describe('blockers and execution status (REQ-003, REQ-005 / AC-008)', () => {
  it('never lets execution Status substitute for an acceptance Verdict', async () => {
    const policy = joined(
      flatten(await read(CONTRACT)),
      flatten(await read(CODING)),
      flatten(await read(SPEC_REVIEW)),
      flatten(await read(STANDARDS_REVIEW)),
    );
    expect(
      anyMatch(policy, [
        /Status[^.]{0,240}?(?:execution|completed)[^.]{0,200}?(?:never|not|no|cannot)[^.]{0,160}?Verdict/i,
        /Status[^.]{0,200}?(?:never|not|no|cannot)[^.]{0,160}?(?:substitute|replace|stand in)[^.]{0,140}?Verdict/i,
      ]),
      'execution Status never substitutes for a Verdict PASS',
    ).toBe(true);
  });

  it('keeps acceptance, standard and evidence gaps as blockers while warnings stay advisory', async () => {
    const policy = joined(flatten(await read(CONTRACT)), flatten(await read(CODING)));

    expect(
      anyMatch(policy, [
        /(?:unfulfilled|unmet|unsatisfied|missing|failing|unavailable)[^.]{0,200}?(?:AC|acceptance|standard|evidence)[^.]{0,160}?block/i,
        /block\w*[^.]{0,200}?(?:unfulfilled|unmet|AC|acceptance|standard|evidence)/i,
      ]),
      'acceptance, standard or evidence gaps are blockers',
    ).toBe(true);
    expect(
      anyMatch(policy, [
        /warning[s]?[^.]{0,240}?\b(?:advisory|reason|not hide|cannot hide|never hide|do not hide)/i,
      ]),
      'warnings are advisory and carry reasons',
    ).toBe(true);
    expect(policy, 'a warning cannot hide or downgrade a blocker').not.toMatch(
      /warnings?[^.]{0,140}?(?:may|can|should)[^.]{0,100}?(?:hide|replace|downgrade)[^.]{0,100}?blocker/i,
    );
  });
});

describe('integration source-HEAD gate (REQ-005 / AC-009)', () => {
  it('compares the accepted clean source HEAD and refuses drift before a distinct delivery merge', async () => {
    const policy = joined(flatten(await read(GIT_OPERATOR)), flatten(await read(CODING)));

    expect(
      anyMatch(policy, [
        /accepted[^.]{0,180}?(?:source )?HEAD[^.]{0,240}?(?:compare|match|drift|refus)/i,
        /(?:compare|match|refus\w*)[^.]{0,180}?accepted[^.]{0,120}?HEAD/i,
      ]),
      'Git Operator compares the accepted clean source HEAD before merge',
    ).toBe(true);
    expect(
      anyMatch(policy, [
        /drift[^.]{0,200}?refus|refus\w*[^.]{0,200}?drift|(?:different|mismatch\w*)[^.]{0,160}?HEAD[^.]{0,180}?refus/i,
      ]),
      'a drifted or unaccepted source HEAD refuses before merge',
    ).toBe(true);
    expect(
      anyMatch(policy, [
        /(?:delivery|merge)[^.]{0,180}?(?:SHA|commit)[^.]{0,200}?(?:separate|distinct|need not|different|independent)/i,
        /(?:separate|distinct|independent)[^.]{0,200}?(?:delivery|merge)[^.]{0,120}?(?:SHA|commit)/i,
      ]),
      'the delivery merge SHA is recorded independently of the source HEAD',
    ).toBe(true);
  });

  it('records the workspace reviewed commit only after closure', async () => {
    const policy = joined(flatten(await read(CODING)), flatten(await read(WORKSPACE_REFERENCE)));
    expect(
      anyMatch(policy, [
        /reviewed_commit[^.]{0,320}?(?:only after|after)[^.]{0,200}?(?:closure|repair|recheck)/i,
        /(?:only after|after)[^.]{0,200}?(?:closure|repair|recheck)[^.]{0,240}?reviewed_commit/i,
      ]),
      'reviewed_commit is recorded only after repairs, rechecks and closure are accepted',
    ).toBe(true);
  });
});

describe('MEMORY no longer restates the review-closure policy (REQ-004 / AC-004)', () => {
  it('drops the findings-closure advisory and disposition clauses from MEMORY.md', async () => {
    const memory = flatten(await read('MEMORY.md'));

    expect(memory, 'MEMORY.md no longer owns the advisory-closure clause').not.toMatch(
      /warnings?[^.]{0,90}?advisory/i,
    );
    expect(memory, 'MEMORY.md no longer owns the review-closure policy statement').not.toMatch(
      /Review activation and closure follow the change class/i,
    );
  });
});
