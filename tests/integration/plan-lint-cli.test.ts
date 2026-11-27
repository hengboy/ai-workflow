import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { changedPaths, renderExecutionOrderYaml, snapshotTree, temporary, writePlanTriplet } from '../helpers.js';

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


const SCHEDULE_PLAN_ID = '20261127-lint-schedule-cli';
const SCHEDULE_ATTRIBUTES = {
  plan_id: SCHEDULE_PLAN_ID,
  status: 'frozen',
  created_at: '2026-11-27T00:00:00.000Z',
  supersedes: null,
  requirement_count: 1,
  acceptance_criteria_count: 1,
  digest: 'sha256:placeholder',
};
const frozenSchedule = (body: string): string => renderFrozenMarkdown(SCHEDULE_ATTRIBUTES, body);

const SCHEDULE_SPEC = [
  '# Specification', '', '## Goal', '', 'Goal prose.', '',
  '## Non-goals', '', '- No runtime state.', '',
  '## Requirements', '', '### REQ-001: fixture requirement', '', 'Requirement prose.', '',
  '## Acceptance criteria', '', '### AC-001: fixture acceptance', '',
  '- Given a frozen plan', '- When lint runs', '- Then warnings stay advisory.', '',
  '## Error boundaries and counterexamples', '',
  '- Boundary: warnings still exit zero.', '- Counterexample: warnings never block.', '',
  '## Verification layers and RED criteria', '',
  '| Requirement | Acceptance criteria | Layer | RED evidence before implementation |',
  '| --- | --- | --- | --- |',
  '| REQ-001 | AC-001 | Unit | schedule warning missing |', '',
].join('\n');

const SCHEDULE_PLAN_DOC = [
  '# Implementation Plan', '', '## Requirement coverage', '',
  '| Requirement | Acceptance criteria | Implementation step |',
  '| --- | --- | --- |',
  '| REQ-001 | AC-001 | Step 1 |', '',
].join('\n');

interface ScheduleTaskSpec {
  id: string;
  surface?: string;
  dependsOn?: string[];
  writeScope?: string[];
}

interface SchedulePlanSpec {
  tasks: ScheduleTaskSpec[];
  /** `undefined` renders one phase with all tasks; `null` writes no execution-order.yaml. */
  phases?: string[][] | null;
  rawSchedule?: string;
}

async function writeSchedulePlan(root: string, spec: SchedulePlanSpec): Promise<{ directory: string; planPath: string }> {
  const directory = join(root, '.ai-workflow/plans', SCHEDULE_PLAN_ID);
  await mkdir(join(directory, 'tasks'), { recursive: true });
  await writePlanTriplet(directory, 'spec.md', SCHEDULE_SPEC, SCHEDULE_SPEC, frozenSchedule);
  await writePlanTriplet(directory, 'plan.md', SCHEDULE_PLAN_DOC, SCHEDULE_PLAN_DOC, frozenSchedule);
  for (const task of spec.tasks) {
    const attributes = {
      id: task.id,
      requirements: ['REQ-001'],
      acceptance_criteria: ['AC-001'],
      depends_on: task.dependsOn ?? [],
      surface: task.surface ?? 'backend',
      read_scope: ['MEMORY.md'],
      write_scope: task.writeScope ?? [`src/${task.id}.ts`],
      test_commands: ['pnpm test'],
    };
    await writePlanTriplet(join(directory, 'tasks'), `${task.id}.md`, '# Task', '# Task', (body) => renderMarkdown(attributes, body));
  }
  const phases = spec.phases === undefined ? [spec.tasks.map((task) => task.id)] : spec.phases;
  if (spec.rawSchedule !== undefined) await writeFile(join(directory, 'tasks', 'execution-order.yaml'), spec.rawSchedule);
  else if (phases !== null) await writeFile(join(directory, 'tasks', 'execution-order.yaml'), renderExecutionOrderYaml(SCHEDULE_PLAN_ID, phases));
  return { directory, planPath: join(directory, 'plan.md') };
}

function cliLinearTasks(): ScheduleTaskSpec[] {
  return [
    { id: 'task-001-first' },
    { id: 'task-002-second', dependsOn: ['task-001-first'] },
    { id: 'task-003-third', dependsOn: ['task-002-second'] },
  ];
}

function cliPhaseTasks(): { tasks: ScheduleTaskSpec[]; phases: string[][] } {
  const backend = ['task-001-backend-a', 'task-002-backend-b'];
  const frontend = ['task-003-frontend-a', 'task-004-frontend-b'];
  const tasks: ScheduleTaskSpec[] = [
    ...backend.map((id) => ({ id, surface: 'backend' })),
    ...frontend.map((id) => ({ id, surface: 'frontend' })),
  ];
  return { tasks, phases: [backend, frontend] };
}

describe('ai-workflow plan lint schedule warnings', () => {
  function scheduleWarnings(report: LintResult, code: string): LintWarning[] {
    return report.warnings.filter((warning) => warning.code === code);
  }

  async function lintScheduleCli(options: SchedulePlanSpec): Promise<{ result: CliResult; report: LintResult; planPath: string; before: Map<string, string>; after: Map<string, string> }> {
    const root = await temporary('ai-workflow-lint-cli-schedule-');
    const { directory, planPath } = await writeSchedulePlan(root, options);
    const before = await snapshotTree(root);
    const result = await runCli(['plan', 'lint', '--plan', directory]);
    const report = result.stdout.trim()
      ? JSON.parse(result.stdout) as LintResult
      : { valid: true, plan_id: '', warnings: [] } as LintResult;
    return { result, report, planPath, before, after: await snapshotTree(root) };
  }

  it('AC-003 exits 0 with exactly one plan-schedule-serial and writes no file', async () => {
    const tasks = cliLinearTasks();
    const { result, report, planPath, before, after } = await lintScheduleCli({ tasks, phases: tasks.map((task) => [task.id]) });

    expect(result.code, outputOf(result)).toBe(0);
    expect(report.valid).toBe(true);
    const warnings = scheduleWarnings(report, 'plan-schedule-serial');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe(planPath);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('AC-004 exits 0 with one deduplicated warning naming both uncovered phases', async () => {
    const { tasks, phases } = cliPhaseTasks();
    const { result, report, planPath, before, after } = await lintScheduleCli({ tasks, phases });

    expect(result.code, outputOf(result)).toBe(0);
    const warnings = scheduleWarnings(report, 'parallel-tasks-without-integration-verify');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe(planPath);
    expect(warnings[0]?.message).toMatch(/\b1\b/);
    expect(warnings[0]?.message).toMatch(/\b2\b/);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('AC-004 emits no warning when later test tasks cover both parallel phases', async () => {
    const { tasks, phases } = cliPhaseTasks();
    const backendVerify: ScheduleTaskSpec = {
      id: 'task-005-verify-backend', surface: 'test', writeScope: ['tests/task-005-verify-backend.test.ts'],
      dependsOn: ['task-001-backend-a', 'task-002-backend-b'],
    };
    const frontendVerify: ScheduleTaskSpec = {
      id: 'task-006-verify-frontend', surface: 'test', writeScope: ['tests/task-006-verify-frontend.test.ts'],
      dependsOn: ['task-003-frontend-a', 'task-004-frontend-b'],
    };
    const { result, report } = await lintScheduleCli({ tasks: [...tasks, backendVerify, frontendVerify], phases: [...phases, [backendVerify.id], [frontendVerify.id]] });

    expect(result.code, outputOf(result)).toBe(0);
    expect(scheduleWarnings(report, 'parallel-tasks-without-integration-verify')).toHaveLength(0);
  });

  it('AC-005 exits 0 with one plan-schedule-serial when execution-order.yaml is missing', async () => {
    const tasks = cliLinearTasks();
    const { result, report, before, after } = await lintScheduleCli({ tasks, phases: null });

    expect(result.code, outputOf(result)).toBe(0);
    expect(report.valid).toBe(true);
    expect(scheduleWarnings(report, 'plan-schedule-serial')).toHaveLength(1);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('AC-005 exits 0 with no schedule warnings on a depends_on cycle', async () => {
    const tasks = cliLinearTasks();
    tasks[0] = { ...tasks[0] as ScheduleTaskSpec, dependsOn: ['task-003-third'] };
    const { result, report, before, after } = await lintScheduleCli({ tasks, phases: null });

    expect(result.code, outputOf(result)).toBe(0);
    expect(report.valid).toBe(true);
    expect(scheduleWarnings(report, 'plan-schedule-serial')).toHaveLength(0);
    expect(scheduleWarnings(report, 'parallel-tasks-without-integration-verify')).toHaveLength(0);
    expect(changedPaths(before, after)).toEqual([]);
  });
});
