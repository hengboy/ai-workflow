import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

describe('v2 coding guidance', () => {
  it('describes the current coding contract and delegated execution boundary', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    for (const term of [
      'test-driven',
      'An unsplit plan is executed serially',
      'A split plan is executed serially',
      'delegate that test work to the',
      'one temporary worktree',
      'Do not generate workflow manifests or run records',
      'Git operations are allowed only through Git Operator or the prescribed',
    ]) {
      expect(coding).toContain(term);
    }
  });

  it('requires delegated serial execution and test-agent-authored tests', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    const testAgent = await readFile(packagePath('templates', 'agents', 'test.md'), 'utf8');
    expect(coding).toContain('An unsplit plan is executed serially');
    expect(coding).toContain('A split plan is executed serially');
    expect(coding).toContain('A small bug fix or small request is delegated as one complete unit');
    expect(coding).toContain('delegate that test work to the');
    expect(coding).toContain('delegate the complete authorized validation to the `test` sub-agent');
    expect(coding).toContain('Do not dispatch the dual-axis reviews while this validation is pending or failing');
    expect(coding.indexOf('wait for a passing result')).toBeLessThan(coding.indexOf('run exactly one Spec Review'));
    expect(testAgent).toMatch(/write or update scoped behavior tests/i);
    expect(testAgent).toContain('public interface plus observable boundary');
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
});
