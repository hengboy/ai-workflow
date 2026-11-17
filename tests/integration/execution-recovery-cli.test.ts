import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  changedPaths,
  snapshotTree,
  temporary,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
} from '../helpers.js';

// CLI boundary: `ai-workflow execution resume` is the explicit recovery entry point. These
// tests drive the real CLI process, create realistic runs through the other execution commands,
// then apply bounded direct edits for stale/corrupt/contradictory state. Expected RED: the
// resume command is not wired and the recovery module does not exist yet.

const TIMEOUT = 90_000;
const HOST = hostname();
const DEAD_PID = 2_000_000_000;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const T1 = 'task-001-first';
const T2 = 'task-002-second';

const REASON = {
  digest: 'Execution run plan digest does not match the frozen plan',
  repository: 'Execution run repository does not match the requested repository',
  ambiguous: 'Multiple execution runs found; select one with --plan',
  terminalCompleted: 'Execution run is already COMPLETED',
  terminalCancelled: 'Execution run was CANCELLED',
} as const;

interface CliResult { code: number; stdout: string; stderr: string }
type Json = Record<string, any>;

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

async function runCli(args: string[]): Promise<CliResult> {
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
    child.stdin.end();
  });
}

function execution(...args: string[]): Promise<CliResult> {
  return runCli(['execution', ...args]);
}

function parseJson<T extends Json = Json>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

async function expectOk(result: CliResult): Promise<Json> {
  expect(result.code, outputOf(result)).toBe(0);
  const body = parseJson(result);
  expect(body.valid).toBe(true);
  return body;
}

async function expectInvalid(result: CliResult, decision: 'manual' | 'refused', reason: string): Promise<Json> {
  expect(result.code, outputOf(result)).toBe(1);
  const body = parseJson(result);
  expect(body.valid).toBe(false);
  expect(body.decision, outputOf(result)).toBe(decision);
  expect(body.reason, outputOf(result)).toBe(reason);
  return body;
}

function splitSpec(planId: string): WorkspacePlanFixtureSpec {
  return {
    planId,
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    tasks: [
      { id: T1, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/first.ts'] },
      { id: T2, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/second.ts'] },
    ],
    phases: [[T1], [T2]],
  };
}

const roots: string[] = [];
async function newRoot(): Promise<string> {
  const root = await temporary('ai-workflow-recovery-cli-');
  roots.push(root);
  return root;
}

async function splitFixture(planId = '20261117-resume-cli'): Promise<{ root: string; planDirectory: string }> {
  const root = await newRoot();
  const planDirectory = await workspacePlanFixture(root, splitSpec(planId));
  return { root, planDirectory };
}

async function startSplit(planId?: string): Promise<{ root: string; planDirectory: string; runId: string }> {
  const fixture = await splitFixture(planId);
  const body = await expectOk(await execution('start', '--plan', fixture.planDirectory, '--repository', 'app'));
  expect(body.status).toBe('RUNNING');
  return { ...fixture, runId: body.run_id };
}

async function completeTask(planDirectory: string, taskId: string, sha = SHA_A): Promise<void> {
  await expectOk(await execution('task', taskId, '--plan', planDirectory, '--commit', sha));
}

async function makeStaleLock(planDirectory: string): Promise<void> {
  const path = join(planDirectory, 'execution', 'lock.json');
  const lock = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify({ ...lock, pid: DEAD_PID, host: HOST }, null, 2)}\n`);
}

async function readRun(planDirectory: string): Promise<Json> {
  return JSON.parse(await readFile(join(planDirectory, 'execution', 'run.json'), 'utf8')) as Json;
}

async function writeRun(planDirectory: string, run: Json): Promise<void> {
  await writeFile(join(planDirectory, 'execution', 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
}

describe('execution resume CLI success (REQ-010 / AC-018)', () => {
  it('resumes a stale-lock run with the original run id and complete task lists', async () => {
    const fixture = await startSplit();
    await completeTask(fixture.planDirectory, T1);
    const before = await readRun(fixture.planDirectory);
    await makeStaleLock(fixture.planDirectory);

    const result = await execution('resume', '--plan', fixture.planDirectory, '--repository', 'app');
    const body = await expectOk(result);

    expect(body.decision).toBe('resume');
    expect(body.valid).toBe(true);
    expect(body.run_id).toBe(fixture.runId);
    expect(body.run_id).toBe(before.run_id);
    expect(body.plan_id).toBe(before.plan_id);
    expect(body.plan_directory).toBe(fixture.planDirectory);
    expect(body.status).toBe('RUNNING');
    expect(body.completed_tasks).toEqual([T1]);
    expect(body.pending_tasks).toEqual([T2]);
    expect(body.pending_tasks).not.toContain(T1);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(Object.keys(body).some((key) => /restor|reconnect|reattach/i.test(key))).toBe(false);
  }, TIMEOUT);

  it('prints a deterministic packet on repeated resumes of a paused run', async () => {
    const fixture = await startSplit();
    await completeTask(fixture.planDirectory, T1);
    await expectOk(await execution('pause', '--plan', fixture.planDirectory));

    const first = await expectOk(await execution('resume', '--plan', fixture.planDirectory, '--repository', 'app'));
    const second = await expectOk(await execution('resume', '--plan', fixture.planDirectory, '--repository', 'app'));
    const stable = (packet: Json): Json => ({
      valid: packet.valid,
      decision: packet.decision,
      plan_id: packet.plan_id,
      plan_directory: packet.plan_directory,
      run_id: packet.run_id,
      status: packet.status,
      completed_tasks: packet.completed_tasks,
      pending_tasks: packet.pending_tasks,
    });
    expect(stable(second)).toEqual(stable(first));
    expect(first.run_id).toBe(fixture.runId);
  }, TIMEOUT);

  it('resolves a single run without --plan from --project', async () => {
    const fixture = await startSplit('20261117-resume-single');
    await expectOk(await execution('pause', '--plan', fixture.planDirectory));

    const body = await expectOk(await execution('resume', '--project', fixture.root, '--repository', 'app'));
    expect(body.decision).toBe('resume');
    expect(body.run_id).toBe(fixture.runId);
    expect(body.plan_directory).toBe(fixture.planDirectory);
  }, TIMEOUT);
});

describe('execution resume CLI manual and refused paths (REQ-011 / AC-019)', () => {
  it('exits 1 with a manual packet for a changed plan digest and writes no new file', async () => {
    const fixture = await startSplit();
    const run = await readRun(fixture.planDirectory);
    await writeRun(fixture.planDirectory, { ...run, plan_digest: 'sha256:changed' });
    const before = await snapshotTree(fixture.root);

    await expectInvalid(await execution('resume', '--plan', fixture.planDirectory), 'manual', REASON.digest);
    expect(changedPaths(before, await snapshotTree(fixture.root)), 'a manual refusal writes no file').toEqual([]);
  }, TIMEOUT);

  it('exits 1 with a manual packet for a repository mismatch', async () => {
    const fixture = await startSplit();
    await expectInvalid(
      await execution('resume', '--plan', fixture.planDirectory, '--repository', 'other-repo'),
      'manual',
      REASON.repository,
    );
  }, TIMEOUT);

  it('exits 1 with a refused packet for a COMPLETED run', async () => {
    const fixture = await startSplit();
    await expectOk(await execution('complete', '--plan', fixture.planDirectory, '--commit', SHA_A));
    const body = await expectInvalid(await execution('resume', '--plan', fixture.planDirectory), 'refused', REASON.terminalCompleted);
    expect(body.run_id).toBe(fixture.runId);
  }, TIMEOUT);

  it('exits 1 with a refused packet for a CANCELLED run', async () => {
    const fixture = await startSplit();
    await expectOk(await execution('cancel', '--plan', fixture.planDirectory));
    await expectInvalid(await execution('resume', '--plan', fixture.planDirectory), 'refused', REASON.terminalCancelled);
  }, TIMEOUT);

  it('exits 1 with the ambiguity reason for two runs without --plan', async () => {
    const root = await newRoot();
    const first = await workspacePlanFixture(root, splitSpec('20261117-resume-a'));
    const second = await workspacePlanFixture(root, splitSpec('20261117-resume-b'));
    await expectOk(await execution('start', '--plan', first, '--repository', 'app'));
    await expectOk(await execution('start', '--plan', second, '--repository', 'app'));

    await expectInvalid(await execution('resume', '--project', root), 'manual', REASON.ambiguous);
  }, TIMEOUT);
});
