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
