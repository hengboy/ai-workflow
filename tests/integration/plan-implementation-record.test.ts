import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { temporary, writePlanTriplet } from '../helpers.js';

// CLI boundary: `plan validate` / `plan pairing` must ignore an `implementation.yaml`
// that sits inside a frozen plan directory. Observable = exit code + stdout JSON.

const exec = promisify(execFile);
const PLAN_ID = '20260922-implementation-record';

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function frozenAttributes(): Record<string, unknown> {
  return {
    plan_id: PLAN_ID,
    status: 'frozen',
    created_at: '2026-09-22T00:00:00.000Z',
    supersedes: null,
    requirement_count: 1,
    acceptance_criteria_count: 1,
    digest: 'sha256:placeholder',
  };
}

const frozenRenderer = (body: string): string => renderFrozenMarkdown(frozenAttributes(), body);

const SPEC_EN = [
  '# Specification',
  '',
  '## Goal',
  '',
  'Goal prose.',
  '',
  '## Requirements',
  '',
  '### REQ-001: Example requirement',
  '',
  'Requirement prose.',
  '',
  '## Acceptance criteria',
  '',
  '### AC-001: Example acceptance',
  '',
  'Acceptance prose.',
  '',
].join('\n');

const SPEC_ZH = [
  '# Specification',
  '',
  '## Goal',
  '',
  '目标正文。',
  '',
  '## Requirements',
  '',
  '### REQ-001: Example requirement',
  '',
  '需求正文。',
  '',
  '## Acceptance criteria',
  '',
  '### AC-001: Example acceptance',
  '',
  '验收正文。',
  '',
].join('\n');

const PLAN_EN = [
  '# Implementation Plan',
  '',
  '## Requirement coverage',
  '',
  '| Requirement | Acceptance criteria | Implementation step |',
  '| --- | --- | --- |',
  '| REQ-001 | AC-001 | Step 1 |',
  '',
  '## Implementation sequence',
  '',
  '1. Implement REQ-001 and verify AC-001.',
  '',
].join('\n');

const PLAN_ZH = [
  '# Implementation Plan',
  '',
  '## Requirement coverage',
  '',
  '| Requirement | Acceptance criteria | Implementation step |',
  '| --- | --- | --- |',
  '| REQ-001 | AC-001 | 第一步 |',
  '',
  '## Implementation sequence',
  '',
  '1. 实现 REQ-001 并验证 AC-001。',
  '',
].join('\n');

async function frozenPlanDirectory(root: string): Promise<string> {
  const directory = join(root, '.ai-workflow/plans', PLAN_ID);
  await mkdir(directory, { recursive: true });
  await writePlanTriplet(directory, 'spec.md', SPEC_EN, SPEC_ZH, frozenRenderer);
  await writePlanTriplet(directory, 'plan.md', PLAN_EN, PLAN_ZH, frozenRenderer);
  return directory;
}

async function writeRecord(directory: string, lines: string[]): Promise<string> {
  const path = join(directory, 'implementation.yaml');
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
}

const START_RECORD = [
  `plan_id: "${PLAN_ID}"`,
  'status: in-progress',
  'started_at: "2026-09-22T06:16:13Z"',
];

const COMPLETED_RECORD = [
  `plan_id: "${PLAN_ID}"`,
  'status: completed',
  'started_at: "2026-09-22T06:16:13Z"',
  'completed_at: "2026-09-22T07:20:00Z"',
  'commit: "0123456789abcdef0123456789abcdef01234567"',
];

describe('plan CLI compatibility with the implementation record', () => {
  it('plan validate succeeds with an unchanged output shape when implementation.yaml is present', async () => {
    const root = await temporary('ai-workflow-record-validate-');
    const directory = await frozenPlanDirectory(root);
    await writeRecord(directory, START_RECORD);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; plan_id: string; digests: Record<string, string> };
    expect(Object.keys(parsed).sort()).toEqual(['digests', 'plan_id', 'valid']);
    expect(Object.keys(parsed.digests).sort()).toEqual(['combined', 'plan', 'spec']);
    expect(parsed.valid).toBe(true);
    expect(parsed.plan_id).toBe(PLAN_ID);
    for (const digest of Object.values(parsed.digests)) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces byte-identical plan validate output with and without the record', async () => {
    const root = await temporary('ai-workflow-record-identical-');
    const directory = await frozenPlanDirectory(root);

    const before = await runCli(['plan', 'validate', '--plan', directory]);
    expect(before.code).toBe(0);

    await writeRecord(directory, START_RECORD);
    const after = await runCli(['plan', 'validate', '--plan', directory]);

    expect(after.code).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  it('plan pairing reports no orphan or missing-sidecar error when implementation.yaml is present', async () => {
    const root = await temporary('ai-workflow-record-pairing-');
    const directory = await frozenPlanDirectory(root);
    const recordPath = await writeRecord(directory, START_RECORD);
    const recordBefore = await readFile(recordPath);

    const result = await runCli(['plan', 'pairing', '--plan', directory]);

    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; errors: string[] };
    expect(parsed).toEqual({ valid: true, errors: [] });
    expect(parsed.errors.join('\n')).not.toMatch(/implementation\.yaml/i);
    expect(parsed.errors.join('\n')).not.toMatch(/orphan|missing/i);
    expect(await readFile(recordPath)).toEqual(recordBefore);
  });

  it('plan pairing --list enumerates only the planning triplets and ignores the record', async () => {
    const root = await temporary('ai-workflow-record-list-');
    const directory = await frozenPlanDirectory(root);
    await writeRecord(directory, START_RECORD);

    const result = await runCli(['plan', 'pairing', '--plan', directory, '--list']);

    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { entries: { path: string; state: string }[] };
    expect(parsed.entries.map((entry) => entry.path).sort()).toEqual(['plan.md', 'spec.md']);
    expect(parsed.entries.every((entry) => entry.state === 'ok')).toBe(true);
    expect(parsed.entries.some((entry) => entry.path.includes('implementation'))).toBe(false);
  });

  it.each([
    ['in-progress', START_RECORD],
    ['completed', COMPLETED_RECORD],
  ])('keeps validate and pairing clean for a %s record', async (_label, record) => {
    const root = await temporary('ai-workflow-record-state-');
    const directory = await frozenPlanDirectory(root);
    await writeRecord(directory, record);

    const validated = await runCli(['plan', 'validate', '--plan', directory]);
    const paired = await runCli(['plan', 'pairing', '--plan', directory]);

    expect(validated.code, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout).valid).toBe(true);
    expect(paired.code, paired.stderr).toBe(0);
    expect(JSON.parse(paired.stdout)).toEqual({ valid: true, errors: [] });
  });
});
