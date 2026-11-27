import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Static delivered-content evidence for the Swarm-principles verification-task and
// boundary-event rules. These tests read the shipped templates and the tracked contract
// mirror as public artifacts; they assert durable rule text, not whole-file snapshots.

const PLANNING_SKILL = 'templates/skills/planning/SKILL.md';
const PLAN_REFERENCE = 'templates/skills/planning/references/plan.md';
const SPLIT_SKILL = 'templates/skills/plan-to-tasks/SKILL.md';
const TASK_REFERENCE = 'templates/skills/plan-to-tasks/references/task.md';
const ORDER_REFERENCE = 'templates/skills/plan-to-tasks/references/execution-order.md';
const CODING_SKILL = 'templates/skills/coding/SKILL.md';
const CONTRACT_TEMPLATE = 'templates/project/AGENTS.md';
const CONTRACT_MIRROR = '.ai-workflow/AGENTS.md';

const UPDATED_TEMPLATES = [
  PLANNING_SKILL,
  PLAN_REFERENCE,
  SPLIT_SKILL,
  TASK_REFERENCE,
  ORDER_REFERENCE,
  CODING_SKILL,
  CONTRACT_TEMPLATE,
  CONTRACT_MIRROR,
] as const;

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

/** Whitespace-normalized so multi-word rules survive source wrapping. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function anyMatch(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Requires one bounded window around an anchor to satisfy every check, so a rule
 * stated in one place cannot be completed by unrelated text elsewhere in the file.
 */
function expectNear(
  text: string,
  anchors: readonly RegExp[],
  checks: ReadonlyArray<readonly [string, RegExp]>,
  label: string,
  before = 600,
  after = 3400,
): void {
  const normalized = flat(text);
  const matches = anchors.flatMap((anchor) => {
    const global = new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`);
    return [...normalized.matchAll(global)];
  });
  expect(matches.length, `${label}: the subject rule is anchored`).toBeGreaterThan(0);
  const missingByWindow = matches.map((match) => {
    const index = match.index ?? 0;
    const window = normalized.slice(Math.max(0, index - before), Math.min(normalized.length, index + after));
    return checks.filter(([, pattern]) => !pattern.test(window)).map(([description]) => description);
  });
  const closest = missingByWindow.reduce((left, right) => (left.length <= right.length ? left : right));
  expect(
    closest,
    `${label}: one nearby section must state ${checks.map(([description]) => description).join(', ')}`,
  ).toEqual([]);
}

const PARALLEL_ANCHORS = [/cross[- ]task integration/i, /integration boundary/i, /parallel implementation/i];
const VERIFICATION_ANCHORS = [/surface:\s*test/i, /integration verification task/i, /downstream[^.]{0,100}\btest\b/i];

describe('planning downstream verification step (REQ-005 / AC-011)', () => {
  it('requires a downstream test step with exact integration-test write paths when parallel steps share an integration boundary', async () => {
    expectNear(await read(PLANNING_SKILL), PARALLEL_ANCHORS, [
      ['parallel implementation steps', /\bparallel\b[^.]{0,180}(?:steps?|tasks?|implement)|(?:steps?|tasks?|implement)[^.]{0,180}\bparallel\b/i],
      ['a downstream test verification step', /(?:downstream|later|after|follow)[^.]{0,180}\btest\b[^.]{0,160}(?:verif|step|task)|\bsurface:\s*test\b[^.]{0,160}(?:verif|step|task)/i],
      ['exact integration-test write paths', /exact[^.]{0,180}(?:integration[- ]?test|test)[^.]{0,180}(?:path|inventor|write)|(?:integration[- ]?test|test)[^.]{0,180}exact[^.]{0,180}(?:path|inventor|write)/i],
      ['the frozen write inventory', /frozen[^.]{0,120}write inventory|write inventory[^.]{0,120}frozen|inventory[^.]{0,120}(?:integration[- ]?test|test path)/i],
    ], 'planning skill downstream test rule', 700, 3800);
  });

  it('records the integration-test paths in the plan template write inventory for the verification step', async () => {
    expectNear(await read(PLAN_REFERENCE), PARALLEL_ANCHORS, [
      ['parallel implementation steps', /\bparallel\b[^.]{0,180}(?:steps?|tasks?|implement)|(?:steps?|tasks?|implement)[^.]{0,180}\bparallel\b/i],
      ['a downstream test verification step', /(?:downstream|later|after|follow)[^.]{0,180}\btest\b[^.]{0,160}(?:verif|step|task)|\bsurface:\s*test\b[^.]{0,160}(?:verif|step|task)/i],
      ['exact integration-test write paths', /exact[^.]{0,180}(?:integration[- ]?test|test)[^.]{0,180}(?:path|inventor|write)|(?:integration[- ]?test|test)[^.]{0,180}exact[^.]{0,180}(?:path|inventor|write)/i],
      ['a write-path list for that step', /write (?:scope|paths?|inventory)[^.]{0,200}(?:test|integration)|(?:test|integration)[^.]{0,200}write (?:scope|paths?|inventory)/i],
    ], 'plan template downstream test rule', 600, 3600);
  });
});

describe('plan-to-tasks downstream surface: test tasks (REQ-005 / AC-011)', () => {
  it('derives a later-phase surface: test task from depends_on naming upstream parallel implementation tasks', async () => {
    for (const path of [SPLIT_SKILL, ORDER_REFERENCE]) {
      expectNear(await read(path), VERIFICATION_ANCHORS, [
        ['a downstream surface: test integration task', /(?:downstream|later|strictly later)[^.]{0,180}(?:\bsurface:\s*test\b|\btest\b[^.]{0,100}(?:verif|integrat))|(?:\bsurface:\s*test\b|\btest\b[^.]{0,100}(?:verif|integrat))[^.]{0,180}(?:downstream|later)/i],
        ['depends_on naming the upstream parallel implementation tasks', /depends_on[^.]{0,220}(?:parallel|upstream|implement)|(?:parallel|upstream|implement)[^.]{0,220}depends_on/i],
        ['phase derivation placing the task strictly later', /(?:strictly )?later phase|phase[^.]{0,140}(?:one greater|strictly later|after)|(?:deriv|depth)[^.]{0,180}later/i],
      ], `${path} downstream test phase rule`, 700, 3400);
    }
  });

  it('derives the verification write_scope only from frozen plan test paths and never edits product code', async () => {
    for (const path of [SPLIT_SKILL, TASK_REFERENCE]) {
      expectNear(await read(path), VERIFICATION_ANCHORS, [
        ['write_scope from frozen plan test paths', /write_scope[^.]{0,200}(?:frozen|test path|test file|integration test)|(?:frozen|test path|test file|integration test)[^.]{0,200}write_scope/i],
        ['test-only scope', /(?:only|strictly|exclusively)[^.]{0,140}\btest\b[^.]{0,140}(?:path|file|scope)|test[- ]only[^.]{0,100}(?:write|scope)/i],
        ['no product code edits', /(?:never|not|no)[^.]{0,180}(?:product|production|source)[^.]{0,100}(?:code|file|edit)|(?:product|production)[^.]{0,100}(?:code|file)[^.]{0,180}(?:never|not|no)/i],
      ], `${path} downstream test write-scope rule`, 700, 3400);
    }
  });

  it('requires test_commands that verify the cross-task integration', async () => {
    for (const path of [SPLIT_SKILL, TASK_REFERENCE]) {
      expectNear(await read(path), VERIFICATION_ANCHORS, [
        ['test_commands', /test_commands/i],
        ['cross-task integration', /cross[- ]task[^.]{0,160}integrat|integrat[^.]{0,160}cross[- ]task/i],
        ['verification evidence', /verif|prove|evidence/i],
      ], `${path} downstream test command rule`, 700, 3200);
    }
  });
});

describe('program-owned boundary telemetry (REQ-005 / AC-011)', () => {
  it('includes ai-workflow execution event in the telemetry command set beside implementation.yaml authority', async () => {
    for (const path of [CODING_SKILL, CONTRACT_TEMPLATE, CONTRACT_MIRROR]) {
      expectNear(await read(path), [/ai-workflow execution event/i], [
        ['the program-owned telemetry boundary', /program-owned[^.]{0,180}(?:telemetry|overlay|execution)|telemetry[^.]{0,180}program-owned/i],
        ['implementation.yaml remains authoritative', /implementation\.yaml[^.]{0,200}authoritative|authoritative[^.]{0,200}implementation\.yaml/i],
        ['review and delivery gates stay unchanged', /(?:review|deliver)[^.]{0,120}(?:gate|unchanged|not alter|never)|(?:unchanged|no change|never[^.]{0,40}alter)[^.]{0,140}(?:review|deliver)/i],
      ], `${path} execution event telemetry rule`, 900, 1800);
    }
  });

  it('keeps the tracked contract mirror byte-identical to its template', async () => {
    const template = await readFile(packagePath(CONTRACT_TEMPLATE));
    const mirror = await readFile(packagePath(CONTRACT_MIRROR));
    expect(mirror.equals(template), '.ai-workflow/AGENTS.md mirrors templates/project/AGENTS.md byte-for-byte').toBe(true);
  });
});

describe('mandatory tone and preserved structural rules (REQ-005 / AC-011)', () => {
  it('uses zero forbidden soft hedges in the updated template text', async () => {
    const forbidden = /\b(?:should|consider|try to|when it improves|if possible)\b/i;
    for (const path of UPDATED_TEMPLATES) {
      expect(flat(await read(path)), `${path} uses the mandatory tone with no soft hedge`).not.toMatch(forbidden);
    }
  });

  it('keeps the single worktree, serial commits, final dual-axis review and no new gate', async () => {
    const union = flat((await Promise.all(
      [SPLIT_SKILL, ORDER_REFERENCE, CODING_SKILL, CONTRACT_TEMPLATE, CONTRACT_MIRROR].map(read),
    )).join(' '));
    expect(anyMatch(union, [/\bsingle worktree\b/i, /one worktree/i]), 'one worktree remains').toBe(true);
    expect(anyMatch(union, [/\bserial(?:ly)?\b/i, /one commit at a time/i]), 'commits remain serial').toBe(true);
    expect(anyMatch(union, [/dual[- ]axis review/i, /Spec Review and Standards Review/i]), 'the final dual-axis review remains').toBe(true);
    expect(anyMatch(union, [
      /no per[- ]task, per[- ]phase or per[- ]commit (?:review )?trigger/i,
      /no per[- ]phase[^.]{0,40}review gate/i,
    ]), 'no per-phase review gate is added').toBe(true);
    expect(anyMatch(union, [/no coordinator role exists/i, /no new role/i]), 'no new role is added').toBe(true);
    expect(union, 'no Board gate is introduced').not.toMatch(/\b(?:shared )?Board\b|per[- ]phase review gate/i);
  });

  it('keeps plan-derived task write scopes intact', async () => {
    for (const path of [SPLIT_SKILL, TASK_REFERENCE]) {
      const text = flat(await read(path));
      expect(anyMatch(text, [
        /write_scope[^.]{0,180}(?:only|exact)[^.]{0,180}frozen plan/i,
        /frozen plan[^.]{0,180}write_scope/i,
      ]), `${path} derives write_scope from the frozen plan`).toBe(true);
      expect(anyMatch(text, [
        /no path absent from the frozen plan/i,
        /never (?:widen|add)[^.]{0,120}(?:directory|path)/i,
      ]), `${path} adds no plan-absent path`).toBe(true);
    }
  });
});
