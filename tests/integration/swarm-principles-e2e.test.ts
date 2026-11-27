import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { changedPaths, snapshotTree, temporary, workspacePlanFixture, type WorkspacePlanFixtureSpec } from '../helpers.js';

// Clean-context end-to-end evidence for a parallel plan whose implementation phase is covered
// by a downstream surface: test task. Every assertion reads a public CLI/JSON boundary; no
// product source is imported and no network, host cost or screenshot is involved.

const TIMEOUT = 90_000;
const PLAN_ID = '20261127-swarm-e2e';
const IMPL_A = 'task-001-implement-a';
const IMPL_B = 'task-002-implement-b';
const VERIFY = 'task-003-integration-verify';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_FINAL = 'd'.repeat(40);

type Json = Record<string, any>;
interface CliResult { code: number; stdout: string; stderr: string }

function outputOf(result: CliResult): string { return `${result.stdout}\n${result.stderr}`; }

/** Drive the real CLI exactly as an operator would, with no stdin. */
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

function plan(...args: string[]): Promise<CliResult> { return runCli(['plan', ...args]); }
function execution(...args: string[]): Promise<CliResult> { return runCli(['execution', ...args]); }

function parseJson<T extends Json = Json>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

function expectSuccess(result: CliResult): Json {
  expect(result.code, outputOf(result)).toBe(0);
  return parseJson(result);
}

async function expectOk(result: CliResult): Promise<Json> {
  const body = expectSuccess(result);
  expect(body.valid, outputOf(result)).toBe(true);
  return body;
}

/** One phase-1 pair of backend tasks plus one strictly later surface:test task covering both. */
function swarmSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-001', 'REQ-002', 'REQ-003'],
    acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003'],
    tasks: [
      { id: IMPL_A, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], surface: 'backend', dependsOn: [], writeScope: ['src/a.ts'] },
      { id: IMPL_B, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], surface: 'backend', dependsOn: [], writeScope: ['src/b.ts'] },
      { id: VERIFY, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], surface: 'test', dependsOn: [IMPL_A, IMPL_B], writeScope: ['tests/integration/a-b.test.ts'] },
    ],
    phases: [[IMPL_A, IMPL_B], [VERIFY]],
  };
}

function parseEvents(text: string): Json[] {
  return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Json);
}

describe('downstream cross-task verification end-to-end', () => {
  it('drives a parallel plan with a downstream surface:test task through validation, telemetry and analytics', async () => {
    const root = await temporary('ai-workflow-swarm-e2e-');
    const planDirectory = await workspacePlanFixture(root, swarmSpec());

    // Static reporting is read-only, deterministic and reports the frozen DAG exactly.
    const queryBefore = await snapshotTree(root);
    const validateFirst = await plan('validate', '--plan', planDirectory);
    const validation = await expectOk(validateFirst);
    expect(validation.plan_id).toBe(PLAN_ID);
    expect(validation.execution_order).toEqual([[IMPL_A, IMPL_B], [VERIFY]]);
    expect(validation.metrics).toMatchObject({
      task_count: 3, phase_count: 2, critical_path_length: 2,
      parallel_width: 2, critical_path_ratio: 0.6667, estimated_parallel_speedup: 1.5,
    });
    expect(validation.metrics.parallel_width, 'plan validate parallel_width').toBe(2);
    expect(validation.metrics.critical_path_ratio, 'plan validate critical_path_ratio').toBe(0.6667);
    expect(validation.metrics.estimated_parallel_speedup, 'plan validate estimated_parallel_speedup').toBe(1.5);

    const lintFirst = await plan('lint', '--plan', planDirectory);
    const lint = await expectOk(lintFirst);
    expect(lint.plan_id).toBe(PLAN_ID);
    const codes = (lint.warnings as Json[]).map((warning) => warning.code);
    expect(codes, 'plan lint omits plan-schedule-serial').not.toContain('plan-schedule-serial');
    expect(codes, 'plan lint omits parallel-tasks-without-integration-verify').not.toContain('parallel-tasks-without-integration-verify');

    const reportFirst = await plan('report', '--plan', planDirectory);
    const report = expectSuccess(reportFirst);
    expect(report.plan_id).toBe(PLAN_ID);
    expect(report.task_count).toBe(3);
    expect(report.phase_count).toBe(2);
    expect(report.critical_path_length).toBe(2);
    expect(report.parallel_width, 'plan report parallel_width').toBe(2);
    expect(report.critical_path_ratio, 'plan report critical_path_ratio').toBe(0.6667);
    expect(report.estimated_parallel_speedup, 'plan report estimated_parallel_speedup').toBe(1.5);

    for (const [label, first, args] of [
      ['validate', validateFirst, ['validate', '--plan', planDirectory]],
      ['lint', lintFirst, ['lint', '--plan', planDirectory]],
      ['report', reportFirst, ['report', '--plan', planDirectory]],
    ] as const) {
      const repeat = await plan(...args);
      expect(repeat.code, `${label} repeats with exit 0\n${outputOf(repeat)}`).toBe(0);
      expect(repeat.stdout, `${label} repeats byte-identically`).toBe(first.stdout);
    }
    expect(changedPaths(queryBefore, await snapshotTree(root)), 'plan queries write no path').toEqual([]);

    // One run, all three tasks, then the boundary events that make analytics observable.
    const started = await expectOk(await execution('start', '--plan', planDirectory));
    expect(started.status).toBe('RUNNING');
    expect(started.plan_id).toBe(PLAN_ID);
    const runId = started.run_id as string;

    const firstTask = await expectOk(await execution('task', IMPL_A, '--plan', planDirectory, '--commit', SHA_A));
    expect(firstTask.task_id).toBe(IMPL_A);
    expect(firstTask.status).toBe('RUNNING');
    expect(firstTask.opened_phase).toEqual([]);
    const secondTask = await expectOk(await execution('task', IMPL_B, '--plan', planDirectory, '--commit', SHA_B));
    expect(secondTask.task_id).toBe(IMPL_B);
    expect(secondTask.opened_phase).toEqual([VERIFY]);
    const verifyTask = await expectOk(await execution('task', VERIFY, '--plan', planDirectory, '--commit', SHA_C));
    expect(verifyTask.task_id).toBe(VERIFY);
    expect(verifyTask.status).toBe('RUNNING');

    await expectOk(await execution('event', 'validation.completed', '--plan', planDirectory, '--result', 'failed', '--boundary', 'integration'));
    await expectOk(await execution('event', 'validation.completed', '--plan', planDirectory, '--result', 'passed', '--boundary', 'integration'));
    await expectOk(await execution('event', 'review.started', '--plan', planDirectory));
    await expectOk(await execution('event', 'review.completed', '--plan', planDirectory, '--result', 'PASS'));
    await expectOk(await execution('event', 'repair.completed', '--plan', planDirectory, '--result', 'applied'));

    const events = parseEvents(await readFile(join(planDirectory, 'execution', 'events.jsonl'), 'utf8'));
    const types = events.map((event) => event.type ?? event.event ?? '');
    expect(types.filter((type) => type === 'validation.completed')).toHaveLength(2);
    expect(types.filter((type) => type === 'repair.completed')).toHaveLength(1);
    expect(types.indexOf('review.completed')).toBeGreaterThan(types.indexOf('review.started'));
    expect(events.every((event) => event.run_id === runId && event.plan_id === PLAN_ID)).toBe(true);

    const completed = await expectOk(await execution('complete', '--plan', planDirectory, '--commit', SHA_FINAL));
    expect(completed.status).toBe('COMPLETED');
    expect(completed.run_id).toBe(runId);
    expect(completed.recovered).toBe(false);
    expect(completed.commit).toBe(SHA_FINAL);

    const analyticsBefore = await snapshotTree(root);
    const analyticsFirst = await execution('analytics', '--plan', planDirectory);
    const metric = (await expectOk(analyticsFirst)).runs[0];
    expect(metric.plan_id).toBe(PLAN_ID);
    expect(metric.run_id).toBe(runId);
    expect(metric.phase_wall_clock, 'numeric phase 1 and phase 2 wall clocks').toEqual([
      { phase: 1, duration_seconds: expect.any(Number) },
      { phase: 2, duration_seconds: expect.any(Number) },
    ]);
    expect(typeof metric.review_duration_seconds, 'review_duration_seconds is numeric').toBe('number');
    expect(metric.repair_rounds, 'repair_rounds').toBe(1);
    expect(metric.integration_failure_rate, 'integration_failure_rate').toBe(0.5);
    expect(metric.cost_per_accepted_task, 'no host cost recorded').toBe('N/A');

    const analyticsRepeat = await execution('analytics', '--plan', planDirectory);
    expect(analyticsRepeat.code, outputOf(analyticsRepeat)).toBe(0);
    expect(analyticsRepeat.stdout, 'analytics repeats byte-identically').toBe(analyticsFirst.stdout);
    const projectAnalytics = await expectOk(await execution('analytics', '--project', root));
    expect(projectAnalytics.scope).toBe('project');
    expect(projectAnalytics.runs[0]).toEqual(metric);
    expect(changedPaths(analyticsBefore, await snapshotTree(root)), 'analytics writes no path').toEqual([]);
  }, TIMEOUT);
});
