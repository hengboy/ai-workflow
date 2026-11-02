import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Behavior boundary: the delivered project contract mirror plus the Coding instruction
// text that a native agent receives. These assertions pin the AC-002 vertical-slice
// delegation semantics. Static shipped-content evidence only.

const CONTRACT = '.ai-workflow/AGENTS.md';
const CODING = 'templates/skills/coding/SKILL.md';

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function anyMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

describe('workflow semantics: vertical TDD delegation (AC-002)', () => {
  it('permits fresh scoped RED/implementation/GREEN dispatches within one accepted task', async () => {
    const contract = flatten(await read(CONTRACT));
    const coding = flatten(await read(CODING));
    const text = `${contract} ${coding}`;

    // No per-role/per-task second-dispatch prohibition may remain.
    expect(text).not.toMatch(
      /Batch each role's work into one dispatch per step\/task\. A second dispatch to that role is allowed only as a review repair/i,
    );

    // Fresh scoped delegations are permitted across the full vertical sequence.
    expect(
      anyMatch(text, [
        /RED1[^.]{0,600}?(?:implementation1|implementation 1)[^.]{0,600}?(?:GREEN1|GREEN 1)[^.]{0,600}?(?:RED2|RED 2)[^.]{0,600}?(?:implementation2|implementation 2)[^.]{0,600}?(?:GREEN2|GREEN 2)/i,
        /fresh[^.]{0,260}?(?:scoped delegat|scoped dispatch|Test,?\s*implementation and verification)/i,
      ]),
      'fresh scoped delegations permitted across RED/implementation/GREEN slices',
    ).toBe(true);

    // Frozen task/phase order and serial scoped commits are preserved.
    expect(
      anyMatch(text, [/frozen (?:task\/)?phase order/i, /phase order/i]),
      'frozen phase order preserved',
    ).toBe(true);
    expect(
      anyMatch(text, [/serial scoped (?:task )?commits?/i, /serial scoped task commits/i]),
      'serial scoped task commits preserved',
    ).toBe(true);

    // Routine slices and verification do not consume the post-review repair/recheck budget.
    expect(
      anyMatch(text, [
        /routine slices and verification do not (?:consume|expand)[^.]{0,160}?(?:repair|recheck)/i,
        /do not (?:consume|expand)[^.]{0,160}?(?:repair|recheck)[^.]{0,160}?(?:budget|routine)/i,
      ]),
      'routine slices and verification do not consume repair/recheck budget',
    ).toBe(true);

    // Completed sessions are never resumed.
    expect(
      anyMatch(text, [/completed (?:sub-agent )?session[^.]{0,160}?(?:never|does not) (?:resume|reus)/i, /never reuses or resumes/i]),
      'completed sessions never resume',
    ).toBe(true);

    // Expected RED names the intended failure, actual nonzero exit, and later GREEN obligation.
    expect(
      anyMatch(text, [
        /expected RED[^.]{0,260}?(?:intended|observable failure)[^.]{0,260}?(?:nonzero|non-zero) exit/i,
        /expected RED[^.]{0,260}?(?:nonzero|non-zero) exit[^.]{0,260}?(?:later GREEN|GREEN obligation)/i,
      ]),
      'expected RED names intended failure, nonzero exit, and later GREEN obligation',
    ).toBe(true);
  });
});

describe('workflow semantics: setup recovery routing (AC-003)', () => {
  it('routes first-time init versus upgrade by actual adoption state and never authorizes setup from presence or preflight', async () => {
    const setup = flatten(await readFile(`${packagePath('templates', 'skills', 'setup-ai-workflow')}/SKILL.md`, 'utf8'));
    const contract = flatten(await read(CONTRACT));
    const text = `${setup} ${contract}`;

    expect(
      anyMatch(text, [
        /ordinary (?:init|`init`)[^.]{0,220}?(?:nonexistent|absent|missing)[^.]{0,220}?(?:workflow files|prerequisites)/i,
        /no adoption uses (?:ordinary )?(?:init|`init`)[^.]{0,220}?(?:nonexistent|absent|missing)/i,
      ]),
      'ordinary init requires nonexistent workflow prerequisites',
    ).toBe(true);

    expect(
      anyMatch(text, [
        /existing adoption[^.]{0,220}?(?:prerequisites)[^.]{0,220}?(?:init --upgrade|init[^\n]*--upgrade)/i,
        /init --upgrade[^.]{0,220}?(?:prerequisites exist|existing adoption)/i,
      ]),
      'existing adoption with prerequisites uses init --upgrade',
    ).toBe(true);

    expect(
      anyMatch(text, [
        /missing prerequisites[^.]{0,260}?(?:exact[- ]path|exact path)[^.]{0,260}?(?:without overwriting|preserv)/i,
        /absent prereqs[^.]{0,260}?(?:exact[- ]path|exact path)/i,
      ]),
      'missing prerequisites produce exact-path support preserving local data',
    ).toBe(true);

    expect(text).toContain('needs_attention');
    expect(text).toMatch(/proceed:\s*true|proceed: true|proceed true/i);
    expect(anyMatch(text, [/needs_attention[^.]{0,200}?(?:warning|no .*freshness|proceed)/i])).toBe(true);
    expect(anyMatch(text, [/Exit 2[^.]{0,160}?(?:not (?:an )?execution failure|alone)/i, /exit 2 alone/i])).toBe(true);

    expect(
      anyMatch(text, [
        /(?:presence|preflight)[^.]{0,200}?(?:does not|never|no)[^.]{0,200}?(?:authoriz|grant)[^.]{0,200}?(?:init|setup)/i,
        /(?:init|setup)[^.]{0,200}?(?:never)[^.]{0,200}?(?:authoriz|grant)[^.]{0,200}?(?:preflight|presence)/i,
      ]),
      'presence or preflight grants no init authority',
    ).toBe(true);
  });
});

describe('workflow semantics: state matrix and review outcomes (AC-001/AC-004/AC-005)', () => {
  it('defines delegated execution statuses and separates done from non-PASS review conclusions', async () => {
    const contract = flatten(await read(CONTRACT));
    expect(anyMatch(contract, [/delegated (?:execution )?(?:status|done|blocked|failed)/i, /done.*blocked.*failed/i]), 'delegated statuses defined').toBe(true);
    // Review PASS permitted with reasoned advisory dispositions; done may coexist with non-PASS.
    expect(anyMatch(contract, [/PASS[^.]{0,200}?(?:advisory|advisories) visible/i, /advisory[^.]{0,200}?(?:reasoned disposition|disposition)/i]), 'PASS with advisories visible').toBe(true);
    expect(anyMatch(contract, [/completed review[^.]{0,200}?(?:done)[^.]{0,200}?(?:non-PASS|non-pass)/i, /done[^.]{0,200}?(?:non-PASS|non-pass conclusion)/i]), 'done with non-PASS conclusion').toBe(true);
    // Missing required inputs are blocked; execution failure is failed.
    expect(anyMatch(contract, [/missing (?:required )?(?:inputs?|evidence)[^.]{0,160}?blocked/i]), 'missing inputs blocked').toBe(true);
    expect(anyMatch(contract, [/execution (?:failure|failed)[^.]{0,160}?failed/i, /failed[^.]{0,160}?(?:execution failure)/i]), 'execution failure is failed').toBe(true);
  });

  it('distinguishes expected RED, required GREEN, and execution/infrastructure failure', async () => {
    const contract = flatten(await read(CONTRACT));
    expect(anyMatch(contract, [/expected RED[^.]{0,200}?(?:nonzero|non-zero) exit/i]), 'expected RED nonzero exit').toBe(true);
    expect(anyMatch(contract, [/required GREEN[^.]{0,200}?(?:fail|failure|blocks?)/i, /GREEN[^.]{0,200}?(?:required)[^.]{0,200}?(?:fail|failure)/i]), 'required GREEN failure blocks').toBe(true);
    expect(anyMatch(contract, [/infrastructure (?:inability|failure)[^.]{0,160}?blocked/i, /blocked[^.]{0,160}?infrastructure/i]), 'infrastructure inability is blocked').toBe(true);
    expect(anyMatch(contract, [/unexpected (?:execution|test) failure[^.]{0,160}?failed/i, /failed[^.]{0,160}?unexpected/i]), 'unexpected failure is failed').toBe(true);
  });

  it('defines two implementation statuses and checkpoint/readiness without equating success to acceptance', async () => {
    const contract = flatten(await read(CONTRACT));
    expect(anyMatch(contract, [/in-progress[^.]{0,120}?completed/i, /completed[^.]{0,120}?in-progress/i]), 'two implementation statuses').toBe(true);
    expect(anyMatch(contract, [/reviewed_commit[^.]{0,200}?(?:accepted closure|purpose)/i]), 'reviewed_commit follows accepted closure').toBe(true);
    expect(anyMatch(contract, [/checkpoint (?:success|readiness)[^.]{0,200}?(?:not|neither|alone)[^.]{0,200}?(?:acceptance|review|runtime)/i, /(?:alone|only)[^.]{0,200}?(?:prove|proves)[^.]{0,200}?(?:checkpoint|readiness)/i]), 'checkpoint alone not acceptance').toBe(true);
    expect(anyMatch(contract, [/status success[^.]{0,200}?(?:not|never)[^.]{0,200}?acceptance/i, /success[^.]{0,200}?(?:not acceptance)/i]), 'status success not acceptance').toBe(true);
  });

  it('publishes the five state counterexamples', async () => {
    const contract = flatten(await read(CONTRACT));
    const counterexamples = [
      /done[^.]{0,120}?(?:non-PASS|non-pass)/i,
      /PASS[^.]{0,120}?(?:failed required test|failed test)/i,
      /expected RED[^.]{0,120}?(?:nonzero|non-zero)/i,
      /valid[^.]{0,80}?(?:true)[^.]{0,120}?(?:missing slice)/i,
      /exit (?:code )?0[^.]{0,120}?(?:deny)/i,
    ];
    for (const pattern of counterexamples) {
      expect(pattern.test(contract), `counterexample ${pattern}`).toBe(true);
    }
  });



  it('enumerates SyncReport and locator vocabulary from authorized source references', async () => {
    const contract = flatten(await read(CONTRACT));
    const syncValues = ['synchronized','unverified','needs_attention','pending','conflict','failed'];
    const locatorValues = ['hit','miss','missing_index','stale','invalid','ambiguous','blocked'];
    for (const value of syncValues) {
      expect(contract.includes(value), `sync value ${value}`).toBe(true);
    }
    for (const value of locatorValues) {
      expect(contract.includes(value), `locator value ${value}`).toBe(true);
    }
  });

  it('defines gate allow/deny/skip and handled sync-hook exit behavior', async () => {
    const contract = flatten(await read(CONTRACT));
    expect(anyMatch(contract, [/allow[^.]{0,80}?deny[^.]{0,80}?skip/i]), 'gate values').toBe(true);
    expect(anyMatch(contract, [/sync-hook[^.]{0,160}?(?:exit 0|exits 0)/i, /handled[^.]{0,160}?(?:exit 0)/i]), 'sync-hook exit 0').toBe(true);
    expect(anyMatch(contract, [/manual[^.]{0,120}?warning[^.]{0,120}?(?:exit 2)/i, /exit 2[^.]{0,120}?warning/i]), 'manual warning exit 2').toBe(true);
  });
});

// AC-006: contract completeness may grow without any historical or replacement quota.
describe('workflow semantics: no contract quota (AC-006)', () => {
  it('removes the historical 60%/35107 and any replacement fixed quota from the common contract', async () => {
    const contract = flatten(await read(CONTRACT));
    const mirror = flatten(await readFile(packagePath('.ai-workflow/AGENTS.md'), 'utf8'));
    // No historical or replacement fixed quota may remain as an acceptance gate.
    expect(contract).not.toMatch(/60%\s*(?:of|against)/i);
    expect(contract).not.toMatch(/35107/);
    expect(contract).not.toMatch(/(?:at most|max(?:imum)?|no more than)\s*\d[\d,]*\s*(?:code points?|characters?|bytes?|lines?)/i);
    // Mirror equality is retained.
    expect(mirror).toBe(contract);
    // Report-body targets remain distinct from contract length.
    expect(contract).toMatch(/report[- ]body targets?[^.]{0,160}(?:distinct|separate)/i);
  });

  it('marks historical note measurements as superseded rather than current gates', async () => {
    const note = await readFile(
      packagePath('.ai-workflow/notes/implemented/process/2026-11-02-workflow-semantics-context.md'),
      'utf8',
    ).catch(() => '');
    expect(note, 'new bilingual durable decision note exists').not.toBe('');
    expect(note, 'partial supersession of four notes is recorded').toMatch(/partial supersession|partially supersede/i);
    for (const name of [
      'prompt-context-transport',
      'orchestrator-context-boundaries',
      'fresh-subagent-sessions',
      'skill-prompt-deduplication',
    ]) {
      expect(note, `${name} is partially superseded`).toMatch(new RegExp(name));
    }
    for (const name of [
      'review-boundaries-and-repair',
      'standards-code-review',
      'workspace-session-handoff',
    ]) {
      expect(note, `${name} has a no-supersession disposition`).toMatch(new RegExp(name));
    }
    expect(note).toMatch(/no[- ]supersession/i);
  });

  it('expresses delivered semantics in current MEMORY and navigation', async () => {
    const memory = flatten(await readFile(packagePath('MEMORY.md'), 'utf8'));
    const nav = flatten(await readFile(packagePath('.ai-workflow/index/navigation.md'), 'utf8'));
    expect(memory, 'MEMORY records current delivered semantics').toMatch(/workflow-semantics-context|delivered semantics/i);
    expect(nav, 'navigation expresses delivered semantics').toMatch(/workflow-semantics-context|delivered semantics/i);
  });
});
describe('workflow semantics: role-scoped context acquisition (AC-007/AC-008)', () => {
  it('publishes the role loading matrix and rejects universal eager navigation self-read', async () => {
    const contract = flatten(await read(CONTRACT));
    for (const role of ['Primary orchestration', 'File Explorer', 'Backend', 'Standards Review', 'Spec Review', 'Authorized index maintenance']) {
      expect(contract, `role matrix names ${role}`).toContain(role);
    }
    expect(anyMatch(contract, [/Full applicable contract[^.]{0,120}?MEMORY/i]), 'primary loads full contract + MEMORY').toBe(true);
    expect(anyMatch(contract, [/no generic navigation bundle/i]), 'standards review has no generic nav bundle').toBe(true);
    expect(anyMatch(contract, [/no MEMORY\/navigation bundle|no MEMORY and navigation bundle/i]), 'spec review has no MEMORY/navigation bundle').toBe(true);
    expect(contract).not.toMatch(/every (?:new )?session[^.]{0,160}?(?:read|load)[^.]{0,160}?(?:both navigation files|navigation\.(?:json|md))/i);
    expect(anyMatch(contract, [/no (?:generic )?requirement to eagerly read both navigation files/i, /not.*eagerly read both navigation/i]), 'no universal eager nav read').toBe(true);
  });

  it('defines locator provenance, reuse invalidation, complete injection and shell-less lookup', async () => {
    const contract = flatten(await read(CONTRACT));
    expect(anyMatch(contract, [/provenance/i]), 'locator provenance is defined').toBe(true);
    expect(anyMatch(contract, [/invalidat/i]), 'reuse invalidation is defined').toBe(true);
    expect(anyMatch(contract, [/fresh (?:session|role)[^.]{0,120}?(?:never counts|does not count)[^.]{0,120}?(?:parent's read|parent read)/i, /parent's read/i]), 'fresh session does not count parent read').toBe(true);
    expect(anyMatch(contract, [/complete current authorized injection/i]), 'complete injection accepted').toBe(true);
    expect(anyMatch(contract, [/shell[^.]{0,160}?(?:primary|requests? the primary|arrange lookup)/i]), 'shell-less role asks primary').toBe(true);
    expect(anyMatch(contract, [/old task scope[^.]{0,160}?(?:navigation|valid)/i]), 'old task scope navigation stays valid').toBe(true);
    expect(anyMatch(contract, [/permission[^.]{0,120}?(?:not|is not|!=)[^.]{0,120}?(?:mandatory read list|eager)/i, /mandatory read list/i]), 'permission is not mandatory read list').toBe(true);
  });
});
