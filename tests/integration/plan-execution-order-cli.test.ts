import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { renderExecutionOrderYaml, temporary, writePlanTriplet } from '../helpers.js';

// CLI boundary: `plan validate` must load `tasks/execution-order.yaml` whenever the
// plan directory holds task documents. Observable = exit code + stdout JSON.

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;
const PLAN_ID = '20260831-example';

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', [...cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function frozenAttributes(): Record<string, unknown> {
  return {
    plan_id: PLAN_ID,
    status: 'frozen',
    created_at: '2026-08-31T00:00:00.000Z',
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

const TASK_EN = ['# Task', '', '## Objective', '', 'Do the task.', ''].join('\n');
const TASK_ZH = ['# Task', '', '## Objective', '', '执行任务。', ''].join('\n');

interface TaskSpec {
  id: string;
  dependsOn?: string[];
  writeScope?: string[];
}

const DEFAULT_TASKS: TaskSpec[] = [
  { id: 'task-001-alpha' },
  { id: 'task-002-beta', dependsOn: ['task-001-alpha'] },
];

function taskAttributes(spec: TaskSpec): Record<string, unknown> {
  return {
    id: spec.id,
    requirements: ['REQ-001'],
    acceptance_criteria: ['AC-001'],
    depends_on: spec.dependsOn ?? [],
    surface: 'backend',
    read_scope: ['src/input.ts'],
    write_scope: spec.writeScope ?? [`src/${spec.id}.ts`],
    test_commands: ['pnpm test'],
  };
}

interface PlanOptions {
  /** `undefined` writes the default two-task set; `[]` writes no task documents. */
  tasks?: TaskSpec[];
  /** `undefined` writes the valid two-phase schedule; `null` writes no file; a string is written verbatim. */
  schedule?: string | null;
}

const DEFAULT_SCHEDULE = renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha'], ['task-002-beta']]);

async function buildPlan(root: string, options: PlanOptions = {}): Promise<string> {
  const directory = join(root, '.ai-workflow/plans', PLAN_ID);
  await mkdir(join(directory, 'tasks'), { recursive: true });
  await writePlanTriplet(directory, 'spec.md', SPEC_EN, SPEC_ZH, frozenRenderer);
  await writePlanTriplet(directory, 'plan.md', PLAN_EN, PLAN_ZH, frozenRenderer);
  for (const spec of options.tasks ?? DEFAULT_TASKS) {
    await writePlanTriplet(join(directory, 'tasks'), `${spec.id}.md`, TASK_EN, TASK_ZH, (body) => renderMarkdown(taskAttributes(spec), body));
  }
  const schedule = options.schedule === undefined ? DEFAULT_SCHEDULE : options.schedule;
  if (schedule !== null) await writeFile(join(directory, 'tasks', 'execution-order.yaml'), schedule);
  return directory;
}

async function validateDefect(options: PlanOptions, ...patterns: RegExp[]): Promise<void> {
  const root = await temporary('ai-workflow-order-defect-');
  const directory = await buildPlan(root, options);
  const result = await runCli(['plan', 'validate', '--plan', directory]);
  const output = outputOf(result);

  expect(result.code, `plan validate must exit nonzero (${patterns.map((pattern) => pattern.source).join(', ')})`).not.toBe(0);
  for (const pattern of patterns) expect(output).toMatch(pattern);
}

describe('plan validate execution order', () => {
  it('reports the frozen phases exactly and exits 0', async () => {
    const root = await temporary('ai-workflow-order-valid-');
    const directory = await buildPlan(root);

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; plan_id: string; execution_order: string[][] };
    expect(parsed.valid).toBe(true);
    expect(parsed.plan_id).toBe(PLAN_ID);
    expect(parsed.execution_order).toEqual([['task-001-alpha'], ['task-002-beta']]);
    expect(Object.keys(parsed).sort()).toEqual(['digests', 'execution_order', 'plan_id', 'valid']);
  });

  it('fails when the schedule file is missing and names the artifact', async () => {
    await validateDefect({ schedule: null }, /Missing execution order/i, /execution-order\.yaml/);
  });

  it('fails on a plan_id mismatch', async () => {
    await validateDefect(
      { schedule: renderExecutionOrderYaml('20260999-other', [['task-001-alpha'], ['task-002-beta']]) },
      /Execution order plan_id mismatch/i,
    );
  });

  it('fails on malformed YAML', async () => {
    await validateDefect({ schedule: 'plan_id: [unclosed\n' }, /Malformed execution order YAML/i);
  });

  it('fails on an invalid schedule shape', async () => {
    await validateDefect({ schedule: `plan_id: ${PLAN_ID}\nphases: []\n` }, /Invalid execution order shape/i);
  });

  it('fails on an unknown task id', async () => {
    await validateDefect(
      { schedule: renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha'], ['task-002-beta', 'task-999-ghost']]) },
      /Unknown task in execution order/i,
    );
  });

  it('fails on a duplicated task id', async () => {
    await validateDefect(
      { schedule: renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha'], ['task-001-alpha', 'task-002-beta']]) },
      /Duplicate task in execution order/i,
    );
  });

  it('fails on a task omitted from the schedule', async () => {
    await validateDefect({ schedule: renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha']]) }, /Task missing from execution order/i);
  });

  it('fails on a dependency in the same phase', async () => {
    await validateDefect(
      { schedule: renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha', 'task-002-beta']]) },
      /Dependency in the same phase/i,
    );
  });

  it('fails on a dependency in a later phase', async () => {
    await validateDefect(
      { schedule: renderExecutionOrderYaml(PLAN_ID, [['task-002-beta'], ['task-001-alpha']]) },
      /Dependency in a later phase/i,
    );
  });

  it('fails on overlapping write scopes inside one phase', async () => {
    await validateDefect(
      {
        tasks: [
          { id: 'task-001-alpha', writeScope: ['src/shared.ts'] },
          { id: 'task-002-beta', writeScope: ['src/shared.ts'] },
        ],
        schedule: renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha', 'task-002-beta']]),
      },
      /Overlapping write scope in phase/i,
      /src\/shared\.ts/,
    );
  });

  it('fails when one task write scope contains another inside one phase', async () => {
    await validateDefect(
      {
        tasks: [
          { id: 'task-001-alpha', writeScope: ['src/workflow'] },
          { id: 'task-002-beta', dependsOn: [], writeScope: ['src/workflow/order.ts'] },
        ],
        schedule: renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha', 'task-002-beta']]),
      },
      /Overlapping write scope in phase/i,
      /src\/workflow\/order\.ts/,
    );
  });

  it('does not read or require the schedule for a plan with no task documents', async () => {
    const root = await temporary('ai-workflow-order-notasks-');
    const directory = await buildPlan(root, { tasks: [], schedule: 'plan_id: [unclosed\n' });

    const result = await runCli(['plan', 'validate', '--plan', directory]);

    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['digests', 'plan_id', 'valid']);
    expect(parsed).not.toHaveProperty('execution_order');
  });
});
