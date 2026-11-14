import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { changedPaths, snapshotTree, temporary, writePlanTriplet } from '../helpers.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', [...cli, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

interface LintWarning {
  code: string;
  path: string;
  message: string;
}

interface LintResult {
  valid: true;
  plan_id: string;
  warnings: LintWarning[];
}

const PLAN_ID = '20261114-lint-cli-fixture';
const CREATED_AT = '2026-11-14T00:00:00.000Z';

/**
 * Write a valid frozen plan whose REQ-002 has no acceptance criterion and whose AC-001 is
 * stated without Given/When/Then.
 */
async function writeWarningPlan(root: string): Promise<{ directory: string; specPath: string }> {
  const directory = join(root, '.ai-workflow/plans', PLAN_ID);
  const attributes = {
    plan_id: PLAN_ID,
    status: 'frozen',
    created_at: CREATED_AT,
    supersedes: null,
    requirement_count: 2,
    acceptance_criteria_count: 1,
    digest: 'sha256:placeholder',
  };
  const spec = [
    '# Specification',
    '',
    '## Goal',
    '',
    'Fixture goal.',
    '',
    '## Non-goals',
    '',
    '- No runtime state.',
    '',
    '## Requirements',
    '',
    '### REQ-001: covered requirement',
    '',
    'Requirement prose.',
    '',
    '### REQ-002: uncovered requirement',
    '',
    'Requirement prose.',
    '',
    '## Acceptance criteria',
    '',
    '### AC-001: covered acceptance criterion',
    '',
    'This criterion is stated as prose without a scenario.',
    '',
    '## Error boundaries and counterexamples',
    '',
    '- Boundary: A plan with warnings only exits zero.',
    '',
    '- Counterexample: Lint exits nonzero only because warnings exist.',
    '',
    '## Verification layers and RED criteria',
    '',
    '| Requirement | Acceptance criteria | Layer | RED evidence before implementation |',
    '| --- | --- | --- | --- |',
    '| REQ-001 | AC-001 | Unit | plan lint is unknown |',
    '',
  ].join('\n');
  const plan = [
    '# Implementation Plan',
    '',
    '## Requirement coverage',
    '',
    '| Requirement | Acceptance criteria | Implementation step |',
    '| --- | --- | --- |',
    '| REQ-001 | AC-001 | Step 1 |',
    '',
  ].join('\n');
  await writePlanTriplet(directory, 'spec.md', spec, spec, (body) => renderFrozenMarkdown(attributes, body));
  await writePlanTriplet(directory, 'plan.md', plan, plan, (body) => renderFrozenMarkdown(attributes, body));
  return { directory, specPath: join(directory, 'spec.md') };
}

describe('ai-workflow plan lint', () => {
  it('exits 0, prints stable warning codes with exact paths and writes no file', async () => {
    const root = await temporary('ai-workflow-lint-cli-warnings-');
    const { directory, specPath } = await writeWarningPlan(root);
    const before = await snapshotTree(root);

    const result = await runCli(['plan', 'lint', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const report = JSON.parse(result.stdout) as LintResult;
    expect(report.valid).toBe(true);
    expect(report.plan_id).toBe(PLAN_ID);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'requirement-without-acceptance-criterion', path: specPath }));
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'acceptance-criterion-missing-given-when-then', path: specPath }));
    expect(report.warnings.every((warning) => warning.message.length > 0 && warning.path.startsWith('/'))).toBe(true);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  });

  it('exits nonzero with the exact path and no success result for a directory that is not a frozen plan', async () => {
    const root = await temporary('ai-workflow-lint-cli-invalid-');
    const directory = join(root, 'not-a-frozen-plan');
    await mkdir(directory, { recursive: true });

    const result = await runCli(['plan', 'lint', '--plan', directory]);

    expect(result.code, outputOf(result)).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(directory);
    expect(result.stderr).toMatch(/spec\.md|plan\.md|frozen plan/i);
  });
});
