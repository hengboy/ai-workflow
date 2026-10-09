import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { frozenDocumentDigest, frozenPlanDigest } from '../../src/workflow/digest.js';
import { frozenPlan, temporary, workspacePlanFixture, type WorkspacePlanFixtureSpec } from '../helpers.js';

// Hard single-repository compatibility boundary: an ordinary plan without workspace fields and a
// root-only workspace plan keep their existing `plan validate` / `workspace status` shapes, and
// the new `workspace checkpoint` command is refused for both instead of activating workspace state.

const exec = promisify(execFile);
const TIMEOUT = 90_000;
const ROOT_ONLY_ID = '20260930-workspace-root-only';

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], { maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function runCliStdin(args: string[], input: string): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function parseJson<T>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

async function checkpointRefusal(planDirectory: string, repository: string): Promise<string> {
  const event = {
    event: 'start',
    purpose: 'tasks',
    source_root: '/tmp',
    repository,
    worktree: '/tmp/worktree',
    branch: 'ai-workflow/example',
    target_branch: 'main',
    base_commit: 'a'.repeat(40),
  };
  const result = await runCliStdin(['workspace', 'checkpoint', '--plan', planDirectory, '--repo', repository], JSON.stringify(event));
  expect(result.code, outputOf(result)).toBe(1);
  const parsed = parseJson<{ valid: boolean; errors: string[] }>(result);
  expect(parsed.valid, outputOf(result)).toBe(false);
  expect(Array.isArray(parsed.errors), outputOf(result)).toBe(true);
  return parsed.errors.join('\n');
}

function rootOnlySpec(): WorkspacePlanFixtureSpec {
  const workspace = { name: 'workspace', path: '.', dependsOn: [] };
  return {
    planId: ROOT_ONLY_ID,
    requirements: ['REQ-001'],
    acceptanceCriteria: ['AC-001'],
    workspaceRepos: [workspace],
    tasks: [{ id: 'task-001-root', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/root.ts'] }],
    phases: [['task-001-root']],
    manifest: {
      planId: ROOT_ONLY_ID,
      role: 'workspace',
      repositories: [{ ...workspace, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] }],
    },
  };
}

describe('single-repository compatibility', () => {
  it('keeps an ordinary plan plan validate output byte-identical with no workspace fields', async () => {
    const root = await temporary('ai-workflow-single-ordinary-');
    const directory = await frozenPlan(root, true);
    const specSource = await readFile(join(directory, 'spec.md'), 'utf8');
    const planSource = await readFile(join(directory, 'plan.md'), 'utf8');
    const expected = `${JSON.stringify({
      valid: true,
      plan_id: '20260831-example',
      digests: {
        spec: frozenDocumentDigest(specSource),
        plan: frozenDocumentDigest(planSource),
        combined: frozenPlanDigest(specSource, planSource),
      },
      execution_order: [['task-001-example']],
    }, null, 2)}\n`;

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    expect(result.stdout).toBe(expected);
    expect(result.stdout).not.toContain('repos');
    expect(result.stdout).not.toContain('workspace_finalization');
  });

  it('refuses workspace checkpoint for an ordinary non-workspace plan', async () => {
    const root = await temporary('ai-workflow-single-ordinary-checkpoint-');
    const directory = await frozenPlan(root, true);

    const errors = await checkpointRefusal(directory, 'app');

    expect(errors.length).toBeGreaterThan(0);
  });

  it('keeps a root-only workspace plan plan validate output shape', async () => {
    const root = await temporary('ai-workflow-single-root-only-');
    const directory = await workspacePlanFixture(root, rootOnlySpec());

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['digests', 'execution_order', 'plan_id', 'repos', 'valid']);
    expect(JSON.stringify(parsed)).not.toContain('workspace_finalization');
  });

  it('keeps a root-only workspace status shape without an execution key', async () => {
    const root = await temporary('ai-workflow-single-root-only-status-');
    const directory = await workspacePlanFixture(root, rootOnlySpec());

    const result = await runCli(['workspace', 'status', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const parsed = parseJson<{ valid: boolean; order: string[]; repositories: unknown[]; workspace_root_entry: { name: string } }>(result);
    expect(parsed.valid).toBe(true);
    expect(Object.hasOwn(parsed, 'execution')).toBe(false);
    expect(parsed.order).toEqual(['workspace']);
    expect(parsed.repositories).toEqual([]);
    expect(parsed.workspace_root_entry.name).toBe('workspace');
  });

  it('refuses workspace checkpoint for a root-only workspace plan', async () => {
    const root = await temporary('ai-workflow-single-root-only-checkpoint-');
    const directory = await workspacePlanFixture(root, rootOnlySpec());

    const errors = await checkpointRefusal(directory, 'workspace');

    expect(errors.length).toBeGreaterThan(0);
  });
});
