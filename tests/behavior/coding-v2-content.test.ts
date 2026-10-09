import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

describe('v2 coding guidance', () => {
  it('describes the current coding contract and delegated execution boundary', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    for (const term of [
      'test-driven',
      'An unsplit plan is executed serially',
      'delegate that test work to the',
      'temporary worktree',
      'Do not generate workflow manifests or run records',
      'Git operations are allowed only through Git Operator',
    ]) {
      expect(coding).toContain(term);
    }
  });

  it('requires delegated serial execution and test-agent-authored tests', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    const testAgent = await readFile(packagePath('templates', 'agents', 'test.md'), 'utf8');
    expect(coding).toContain('An unsplit plan is executed serially');
    expect(coding).toContain('A small bug fix or small request is delegated as one complete unit');
    expect(coding).toContain('delegate that test work to the');
    expect(coding).toContain('relevant validation');
    expect(coding).toContain('delegate Spec Review and Standards Review simultaneously in one parallel batch');
    expect(coding).toContain('review-side exception to serial dispatch');
    expect(testAgent).toMatch(/write or update scoped behavior tests/i);
    expect(testAgent).toContain('public interface plus observable boundary');
  });

  it('schedules a split plan by phases from the frozen execution order', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(coding).toContain('tasks/execution-order.yaml');
    expect(coding).toContain('only schedule');
    expect(coding).toContain('an ordered list of non-empty parallel phases');
    expect(coding).toContain('process phases in file order');
    expect(coding).toContain('dispatch every task of the current phase concurrently');
    expect(coding).toContain('test work before implementation');
    expect(coding).toContain('wait for the whole phase');
    expect(coding).toContain("commit each task's write scope through Git Operator one commit at a time");
    expect(coding).toContain('inside the single worktree');
    expect(coding).toContain("serialize that phase's dispatch");
    expect(coding).toContain('without changing the frozen order');
    expect(coding).toContain('missing or invalid order stops the run before execution');
    expect(coding).toContain('never recompute phases from');
    expect(coding).toContain('depends_on');
    expect(coding).toContain('never fall back to serial execution');
  });

  it('routes an unsplit plan by each step\'s Responsible role when no task files exist', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(coding).toMatch(/unsplit plan.{0,180}(?:Responsible role|responsible role).{0,180}(?:delegate|route|dispatch)/i);
    expect(coding).toMatch(/when no task files exist.{0,220}(?:Responsible role|responsible role)/i);
    expect(coding).not.toMatch(/unsplit plan.{0,180}surface/i);
  });

  it('requires a mandatory project-local temporary worktree before implementation', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(coding).toMatch(/create one project-local temporary worktree/i);
    expect(coding).toContain('.worktrees');
    expect(coding).not.toMatch(/consider a temporary worktree/i);
  });

  it('requires the primary orchestrator to directly dispatch Git Operator and never Task Worker', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    // AC-003 / REQ-002: the primary orchestrator directly dispatches Git Operator, not through a coordinator.
    expect(coding).toMatch(/directly\s+dispatch(?:es|ing)?\s+Git\s+Operator|primary orchestrator\s+directly\s+dispatches\s+Git\s+Operator/i);
    // REQ-002: coding guidance must never instruct delegation to Task Worker.
    expect(coding).not.toMatch(/delegate\s+(?:to\s+)?(?:the\s+)?`?task[- ]worker`?|dispatch\s+(?:to\s+)?(?:the\s+)?`?task[- ]worker`?/i);
    // REQ-003: Git remains Git Operator-only.
    expect(coding).toMatch(/Git operations? (?:are allowed )?only through Git Operator|Git Operator is the only role allowed to run Git/i);
  });

  it('loads the project contract and notes governance for landing changes', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    expect(coding).toContain('.ai-workflow/AGENTS.md');
    expect(coding).toContain('.ai-workflow/notes/README.md');
    expect(coding).toMatch(/notes validate/i);
    expect(coding).toMatch(/\bimplemented\b/i);
  });

  it('retires ADR as a current mechanism from the coding contract', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    expect(coding).not.toMatch(/\bADRs?\b/);
    expect(coding).not.toMatch(/ai-workflow\s+adr\b|\.ai-workflow\/adr\b/i);
  });
});

/** Whitespace-normalized coding skill text so fragments match across source wrapping. */
async function codingSkillFlattened(): Promise<string> {
  return (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
}

/**
 * REQ-003..REQ-008: the shipped parent workspace execution route. Activation requires a
 * frozen plan declaring at least one participating non-root repository matched to the
 * current root's `.gitmodules`; ordinary and root-only routes stay as they are.
 */
describe('parent workspace execution route', () => {
  it('activates only for a child-participating frozen plan matched to .gitmodules and distributes before implementation state', async () => {
    const coding = await codingSkillFlattened();

    expect(coding).toContain('.gitmodules');
    expect(coding).toMatch(/at least one participating non-root repository|at least one non-root participating repository/i);
    expect(coding).toMatch(/frozen plan/i);
    expect(coding).toContain('ai-workflow workspace distribute --plan <directory>');
    expect(coding).toMatch(/before any implementation state/i);
  });

  it('keeps the primary parent session as the only dispatcher with no nested coordinator, child host process or sibling session', async () => {
    const coding = await codingSkillFlattened();

    expect(coding).toMatch(/primary parent session/i);
    expect(coding).toMatch(/directly dispatches native leaf agents/i);
    expect(coding).toMatch(/no nested coordinator/i);
    expect(coding).toMatch(/no child host process/i);
    expect(coding).toMatch(/no sibling session/i);
  });

  it('creates one run-owned worktree per active repository and never treats the parent worktree as a child container', async () => {
    const coding = await codingSkillFlattened();

    expect(coding).toContain('<source-root>/.worktrees/<planId>');
    expect(coding).toContain('ai-workflow/<planId>');
    expect(coding).toMatch(/one run-owned worktree per active repository/i);
    expect(coding).toMatch(/parent worktree is not a container for child implementation/i);
  });

  it('keeps the parent execution order as the only global schedule with a whole-phase barrier before serial task commits', async () => {
    const coding = await codingSkillFlattened();

    expect(coding).toContain('tasks/execution-order.yaml');
    expect(coding).toMatch(/only global (?:task )?schedule/i);
    expect(coding).toMatch(/whole phase/i);
    expect(coding).toMatch(/awaited and verified/i);
    expect(coding).toMatch(/serial task commits|serially/i);
  });

  it('delivers a repository at its last task phase before dependent repositories advance', async () => {
    const coding = await codingSkillFlattened();

    expect(coding).toMatch(/last task phase/i);
    expect(coding).toMatch(/review\/delivery gate|review and delivery gate|delivery gate/i);
    expect(coding).toMatch(/before dependent repositories advance|dependent repositories? (?:advance|are dispatched)/i);
  });

  it('requires absolute packet paths, scopes, commands, output paths and upstream delivery evidence', async () => {
    const coding = await codingSkillFlattened();

    for (const fragment of [
      'absolute parent plan',
      'source repository',
      'local slice plan',
      'coding worktree',
      'phase/task',
      'REQ/AC',
      'permitted commands',
      'output paths',
      'upstream delivery evidence',
      'explicit workdir',
      'native permission denial is a blocker',
    ]) {
      expect(coding, `the parent packet contract must state "${fragment}"`).toContain(fragment);
    }
    expect(coding).toMatch(/relative and resolved[^.]{0,24}read\/write scope/i);
  });

  it('separates per-repository delivery review from a distinct finalization review and checkpoints only after Git evidence', async () => {
    const coding = await codingSkillFlattened();

    expect(coding).toMatch(/per-repository delivery review|repository delivery review/i);
    expect(coding).toMatch(/separate finalization review|finalization review/i);
    expect(coding).toContain('ai-workflow workspace checkpoint --plan <directory> --repo <name>');
    expect(coding).toMatch(/only after[^.]{0,40}Git evidence|after Git evidence/i);
  });

  it('resumes only at clean checkpointed phase or verified delivery boundaries and stops on partial-phase residue', async () => {
    const coding = await codingSkillFlattened();
    const lowered = coding.toLowerCase();

    expect(coding).toMatch(/clean, fully checkpointed phase boundar/i);
    expect(coding).toMatch(/verified repository delivery boundar/i);
    for (const fragment of ['dirty partial-phase', 'commit-without-checkpoint', 'unknown future-phase progress', 'uncertain review results', 'bounded support']) {
      expect(lowered, `the recovery rule must name "${fragment}"`).toContain(fragment);
    }
    expect(coding).toMatch(/instead of redispatch|rather than redispatch|not redispatch/i);
  });

  it('links the detailed parent workspace reference file', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    expect(coding).toContain('references/workspace.md');
  });
});
