import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executionAnalytics } from '../../src/execution/report.js';
import {
  changedPaths,
  frozenPlan,
  snapshotTree,
  temporary,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
} from '../helpers.js';

// Public boundary under test: the read-only executionAnalytics result derived only from stored
// run.json, events.jsonl and frozen plan tasks. Expected values are independent literals; no
// production formula is reimplemented here. The five efficiency fields are the observable gap.

const T1 = 'task-001-phase-one';
const T2 = 'task-002-phase-two';
const T3 = 'task-003-phase-three';
const T4 = 'task-004-phase-four';

const T0 = Date.parse('2026-11-27T00:00:00.000Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

type Json = Record<string, any>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function newRoot(prefix = 'ai-workflow-exec-report-'): Promise<string> {
  const root = await temporary(prefix);
  roots.push(root);
  return root;
}

function baseRun(planId: string, overrides: Json = {}): Json {
  return {
    run_id: 'run-analytics',
    plan_id: planId,
    plan_digest: `sha256:${'a'.repeat(64)}`,
    status: 'COMPLETED',
    plan_created_at: at(0),
    created_at: at(0),
    updated_at: at(400),
    failure_count: 0,
    started_at: at(0),
    completed_at: at(400),
    ...overrides,
  };
}

function boundaryEvent(index: number, planId: string, type: string, seconds: number, payload?: Json): Json {
  return {
    event_id: `event-${index}`,
    run_id: 'run-analytics',
    plan_id: planId,
    type,
    timestamp: at(seconds),
    ...(payload === undefined ? {} : { payload }),
  };
}

async function storeFixture(planDirectory: string, run: Json, events: Json[]): Promise<void> {
  const directory = join(planDirectory, 'execution');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(
    join(directory, 'events.jsonl'),
    events.length === 0 ? '' : `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
}

function ordinarySpec(planId: string, tasks: string[], phases: string[][]): WorkspacePlanFixtureSpec {
  return {
    planId,
    requirements: tasks.map((task) => `REQ-${task}`),
    acceptanceCriteria: tasks.map((task) => `AC-${task}`),
    tasks: tasks.map((task) => ({
      id: task,
      requirements: [`REQ-${task}`],
      acceptanceCriteria: [`AC-${task}`],
      writeScope: [`src/${task}.ts`],
    })),
    phases,
  };
}

describe('REQ-004 AC-008 complete runtime analytics', () => {
  it('reports exact five-field values from stored data across plan and project scope with zero writes', async () => {
    const root = await newRoot();
    const planId = '20261127-analytics-complete';
    const planDirectory = await workspacePlanFixture(root, ordinarySpec(planId, [T1, T2], [[T1], [T2]]));
    await storeFixture(
      planDirectory,
      baseRun(planId, {
        tasks: {
          [T1]: { status: 'completed', started_at: at(0), completed_at: at(30) },
          [T2]: { status: 'completed', started_at: at(100), completed_at: at(145) },
        },
        agent: { invocation_id: 'inv-1', host: 'test-host', session_id: 'session-1', cost: 12 },
      }),
      [
        boundaryEvent(1, planId, 'review.started', 200),
        boundaryEvent(2, planId, 'review.completed', 210),
        boundaryEvent(3, planId, 'repair.completed', 215),
        boundaryEvent(4, planId, 'review.started', 300),
        boundaryEvent(5, planId, 'review.completed', 330),
        boundaryEvent(6, planId, 'validation.completed', 340, { result: 'failed' }),
        boundaryEvent(7, planId, 'validation.completed', 350, { result: 'passed' }),
      ],
    );

    const before = await snapshotTree(planDirectory);
    const first = await executionAnalytics({ plan: planDirectory });
    expect(changedPaths(before, await snapshotTree(planDirectory))).toEqual([]);
    expect(first.valid).toBe(true);
    expect(first.scope).toBe('plan');
    expect(first.runs).toHaveLength(1);
    const metric = first.runs[0]!;
    expect(metric.phase_wall_clock).toEqual([
      { phase: 1, duration_seconds: 30 },
      { phase: 2, duration_seconds: 45 },
    ]);
    expect(metric.review_duration_seconds).toBe(40);
    expect(metric.repair_rounds).toBe(1);
    expect(metric.integration_failure_rate).toBe(0.5);
    expect(metric.cost_per_accepted_task).toBe(6);

    const repeat = await executionAnalytics({ plan: planDirectory });
    expect(repeat).toEqual(first);

    const project = await executionAnalytics({ project: root });
    expect(project.valid).toBe(true);
    expect(project.scope).toBe('project');
    expect(project.runs).toHaveLength(1);
    expect(project.runs[0]).toEqual(metric);
    expect(await executionAnalytics({ project: root })).toEqual(project);
  });
});

describe('REQ-004 AC-009 N/A fallback on legacy or unsplit runs', () => {
  const expected = {
    phase_wall_clock: 'N/A',
    review_duration_seconds: 'N/A',
    repair_rounds: 0,
    integration_failure_rate: 'N/A',
    cost_per_accepted_task: 'N/A',
  };

  it('reports N/A and zero for an unsplit run with no tasks and no boundary events', async () => {
    const root = await newRoot();
    const planDirectory = await frozenPlan(root, false);
    await storeFixture(planDirectory, baseRun('20260831-example'), []);
    const result = await executionAnalytics({ plan: planDirectory });
    expect(result.valid).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject(expected);
  });

  it('reports N/A and zero for a legacy split run lacking the new events and model cost', async () => {
    const root = await newRoot();
    const planId = '20261127-analytics-legacy';
    const planDirectory = await workspacePlanFixture(root, ordinarySpec(planId, [T1, T2], [[T1], [T2]]));
    await storeFixture(planDirectory, baseRun(planId), [boundaryEvent(1, planId, 'workflow.completed', 20)]);
    const result = await executionAnalytics({ plan: planDirectory });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject(expected);
  });
});

describe('REQ-004 AC-010 edge boundaries and workspace slice filtering', () => {
  it('handles partial phases, consecutive starts, orphan and skewed reviews, and result classification', async () => {
    const root = await newRoot();
    const planId = '20261127-analytics-edges';
    const planDirectory = await workspacePlanFixture(
      root,
      ordinarySpec(planId, [T1, T2, T3, T4], [[T1], [T2, T3], [T4]]),
    );
    await storeFixture(
      planDirectory,
      baseRun(planId, {
        tasks: {
          [T1]: { status: 'completed', started_at: at(0), completed_at: at(10) },
          [T2]: { status: 'completed', started_at: at(100), completed_at: at(130) },
          [T3]: { status: 'pending' },
          [T4]: { status: 'pending' },
        },
      }),
      [
        boundaryEvent(1, planId, 'review.started', 10),
        boundaryEvent(2, planId, 'review.started', 20),
        boundaryEvent(3, planId, 'review.completed', 25),
        boundaryEvent(4, planId, 'review.completed', 30),
        boundaryEvent(5, planId, 'review.started', 50),
        boundaryEvent(6, planId, 'review.completed', 40),
        boundaryEvent(7, planId, 'validation.completed', 60, { result: '  FAILED  ' }),
        boundaryEvent(8, planId, 'validation.completed', 61, { result: 'skipped' }),
        boundaryEvent(9, planId, 'validation.completed', 62, { result: 'Passed' }),
      ],
    );

    const metric = (await executionAnalytics({ plan: planDirectory })).runs[0]!;
    expect(metric.phase_wall_clock).toEqual([
      { phase: 1, duration_seconds: 10 },
      { phase: 2, duration_seconds: 'N/A' },
      { phase: 3, duration_seconds: 'N/A' },
    ]);
    expect(metric.review_duration_seconds).toBe(5);
    expect(metric.integration_failure_rate).toBe(0.5);
    expect(metric.repair_rounds).toBe(0);
    expect(metric.cost_per_accepted_task).toBe('N/A');
  });

  it('emits only repository-matching phases for a workspace slice run', async () => {
    const root = await newRoot();
    const planId = '20261127-analytics-workspace';
    const planDirectory = await workspacePlanFixture(root, {
      planId,
      requirements: ['REQ-1', 'REQ-2'],
      acceptanceCriteria: ['AC-1', 'AC-2'],
      tasks: [
        { id: 'task-app', repo: 'app', requirements: ['REQ-1'], acceptanceCriteria: ['AC-1'], writeScope: ['src/app.ts'] },
        { id: 'task-lib', repo: 'lib', requirements: ['REQ-2'], acceptanceCriteria: ['AC-2'], writeScope: ['src/lib.ts'] },
      ],
      phases: [['task-app'], ['task-lib']],
    });
    await storeFixture(
      planDirectory,
      baseRun(planId, {
        repository: 'app',
        tasks: { 'task-app': { status: 'completed', started_at: at(0), completed_at: at(20) } },
      }),
      [],
    );
    const metric = (await executionAnalytics({ plan: planDirectory })).runs[0]!;
    expect(metric.phase_wall_clock).toEqual([{ phase: 1, duration_seconds: 20 }]);
  });

  it('reports N/A when no phase task matches the run repository', async () => {
    const root = await newRoot();
    const planId = '20261127-analytics-empty-repo';
    const planDirectory = await workspacePlanFixture(root, {
      planId,
      requirements: ['REQ-1'],
      acceptanceCriteria: ['AC-1'],
      tasks: [{ id: 'task-app', repo: 'app', requirements: ['REQ-1'], acceptanceCriteria: ['AC-1'], writeScope: ['src/app.ts'] }],
      phases: [['task-app']],
    });
    await storeFixture(planDirectory, baseRun(planId, { repository: 'empty-repo', tasks: {} }), []);
    const metric = (await executionAnalytics({ plan: planDirectory })).runs[0]!;
    expect(metric.phase_wall_clock).toBe('N/A');
  });
});
