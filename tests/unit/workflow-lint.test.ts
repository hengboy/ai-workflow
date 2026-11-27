import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { lintPlan } from '../../src/workflow/lint.js';
import { changedPaths, renderExecutionOrderYaml, snapshotTree, temporary, writePlanTriplet } from '../helpers.js';

/**
 * Stable advisory warning codes and their owning documents exercised here:
 * - `requirement-without-acceptance-criterion` -> spec.md
 * - `acceptance-criterion-missing-given-when-then` -> spec.md
 * - `missing-non-goals` -> spec.md
 * - `missing-boundary` -> spec.md
 * - `missing-counterexample` -> spec.md
 * - `missing-verification-layer` -> spec.md
 * - `task-missing-test-command` -> tasks/<task>.md
 * - `task-write-scope-too-wide` -> tasks/<task>.md
 * - `task-over-split` -> plan.md
 * - `plan-schedule-serial` -> plan.md
 * - `parallel-tasks-without-integration-verify` -> plan.md
 */
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

interface TaskFixture {
  id: string;
  requirements: string[];
  acceptanceCriteria: string[];
  writeScope: string[];
  testCommands?: string[];
  surface?: string;
  dependsOn?: string[];
}

interface FixtureOptions {
  requirements?: string[];
  acceptanceCriteria?: string[];
  coverage?: string[][];
  nonGoals?: string[] | undefined;
  givenWhenThen?: boolean;
  boundaries?: string[] | undefined;
  counterexamples?: string[] | undefined;
  verification?: string[][] | undefined;
  tasks?: TaskFixture[];
  /** `undefined` renders one phase with all tasks; `null` writes no execution-order.yaml. */
  phases?: string[][] | null;
  /** Raw YAML written verbatim in place of a rendered schedule. */
  rawSchedule?: string;
}

interface WrittenFixture {
  directory: string;
  specPath: string;
  planPath: string;
  taskPaths: Record<string, string>;
}

const CREATED_AT = '2026-11-14T00:00:00.000Z';

function specBody(options: FixtureOptions): string {
  const requirements = options.requirements ?? ['REQ-001'];
  const acceptanceCriteria = options.acceptanceCriteria ?? ['AC-001'];
  const scenario = options.givenWhenThen === false
    ? 'This criterion is stated as prose without a scenario.'
    : ['- Given a frozen plan', '- When plan lint runs', '- Then it reports advisory warnings'].join('\n');
  const lines = ['# Specification', '', '## Goal', '', 'Fixture goal.', ''];
  if (options.nonGoals !== undefined) lines.push('## Non-goals', '', ...options.nonGoals.map((goal) => `- ${goal}`), '');
  lines.push('## Requirements', '');
  for (const id of requirements) lines.push(`### ${id}: requirement`, '', 'Requirement prose.', '');
  lines.push('## Acceptance criteria', '');
  for (const id of acceptanceCriteria) lines.push(`### ${id}: acceptance criterion`, '', scenario, '');
  if (options.boundaries !== undefined || options.counterexamples !== undefined) {
    lines.push('## Error boundaries and counterexamples', '');
    for (const boundary of options.boundaries ?? []) lines.push(`- Boundary: ${boundary}`);
    for (const counterexample of options.counterexamples ?? []) lines.push(`- Counterexample: ${counterexample}`);
    lines.push('');
  }
  if (options.verification !== undefined) {
    lines.push('## Verification layers and RED criteria', '', '| Requirement | Acceptance criteria | Layer | RED evidence before implementation |', '| --- | --- | --- | --- |');
    for (const row of options.verification) lines.push(`| ${row.join(' | ')} |`);
    lines.push('');
  }
  return lines.join('\n');
}

function planBody(options: FixtureOptions): string {
  const requirements = options.requirements ?? ['REQ-001'];
  const acceptanceCriteria = options.acceptanceCriteria ?? ['AC-001'];
  const coverage = options.coverage ?? requirements.flatMap((id, index) => (acceptanceCriteria[index] === undefined ? [] : [[id, acceptanceCriteria[index] as string]]));
  return [
    '# Implementation Plan',
    '',
    '## Requirement coverage',
    '',
    '| Requirement | Acceptance criteria | Implementation step |',
    '| --- | --- | --- |',
    ...coverage.map(([requirement, acceptance]) => `| ${requirement} | ${acceptance} | Step 1 |`),
    '',
  ].join('\n');
}

/** Write a real frozen plan triplet, optional task triplets and their frozen schedule. */
async function writeFixture(root: string, options: FixtureOptions = {}): Promise<WrittenFixture> {
  const planId = '20261114-lint-fixture';
  const requirements = options.requirements ?? ['REQ-001'];
  const acceptanceCriteria = options.acceptanceCriteria ?? ['AC-001'];
  const directory = join(root, '.ai-workflow/plans', planId);
  const attributes = {
    plan_id: planId,
    status: 'frozen',
    created_at: CREATED_AT,
    supersedes: null,
    requirement_count: requirements.length,
    acceptance_criteria_count: acceptanceCriteria.length,
    digest: 'sha256:placeholder',
  };
  await writePlanTriplet(directory, 'spec.md', specBody(options), specBody(options), (body) => renderFrozenMarkdown(attributes, body));
  await writePlanTriplet(directory, 'plan.md', planBody(options), planBody(options), (body) => renderFrozenMarkdown(attributes, body));
  const taskPaths: Record<string, string> = {};
  if (options.tasks !== undefined && options.tasks.length > 0) {
    await mkdir(join(directory, 'tasks'), { recursive: true });
    for (const task of options.tasks) {
      const taskAttributes: Record<string, unknown> = {
        id: task.id,
        requirements: task.requirements,
        acceptance_criteria: task.acceptanceCriteria,
        depends_on: task.dependsOn ?? [],
        surface: task.surface ?? 'backend',
        read_scope: ['MEMORY.md'],
        write_scope: task.writeScope,
      };
      if (task.testCommands !== undefined) taskAttributes.test_commands = task.testCommands;
      await writePlanTriplet(join(directory, 'tasks'), `${task.id}.md`, '# Task', '# Task', (body) => renderMarkdown(taskAttributes, body));
      taskPaths[task.id] = join(directory, 'tasks', `${task.id}.md`);
    }
    const phases = options.phases === undefined ? [options.tasks.map((task) => task.id)] : options.phases;
    if (options.rawSchedule !== undefined) {
      await writeFile(join(directory, 'tasks', 'execution-order.yaml'), options.rawSchedule);
    } else if (phases !== null) {
      await writeFile(join(directory, 'tasks', 'execution-order.yaml'), renderExecutionOrderYaml(planId, phases));
    }
  }
  return { directory, specPath: join(directory, 'spec.md'), planPath: join(directory, 'plan.md'), taskPaths };
}

function cleanOptions(overrides: FixtureOptions = {}): FixtureOptions {
  return {
    nonGoals: ['No runtime state.'],
    givenWhenThen: true,
    boundaries: ['A plan with warnings only exits zero.'],
    counterexamples: ['Lint exits nonzero only because warnings exist.'],
    verification: [['REQ-001', 'AC-001', 'Unit', 'plan lint is unknown']],
    coverage: [['REQ-001', 'AC-001']],
    ...overrides,
  };
}

async function lintFixture(options: FixtureOptions = {}): Promise<{ result: LintResult; fixture: WrittenFixture }> {
  const root = await temporary('ai-workflow-lint-unit-');
  const fixture = await writeFixture(root, options);
  const result = (await lintPlan(fixture.directory)) as LintResult;
  return { result, fixture };
}

describe('lintPlan', () => {
  it('reports a requirement without an acceptance criterion against spec.md', async () => {
    const { result, fixture } = await lintFixture(cleanOptions({
      requirements: ['REQ-001', 'REQ-002'],
      acceptanceCriteria: ['AC-001'],
      coverage: [['REQ-001', 'AC-001']],
      verification: [['REQ-001', 'AC-001', 'Unit', 'plan lint is unknown']],
    }));

    expect(result.valid).toBe(true);
    expect(result.plan_id).toBe('20261114-lint-fixture');
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'requirement-without-acceptance-criterion', path: fixture.specPath }));
  });

  it('reports an acceptance criterion without Given/When/Then against spec.md', async () => {
    const { result, fixture } = await lintFixture(cleanOptions({ givenWhenThen: false }));

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'acceptance-criterion-missing-given-when-then', path: fixture.specPath }));
  });

  it('reports missing non-goals content against spec.md', async () => {
    const { result, fixture } = await lintFixture(cleanOptions({ nonGoals: undefined }));

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'missing-non-goals', path: fixture.specPath }));
  });

  it('reports missing boundary and counterexample content against spec.md', async () => {
    const { result, fixture } = await lintFixture(cleanOptions({ boundaries: undefined, counterexamples: undefined }));

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'missing-boundary', path: fixture.specPath }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'missing-counterexample', path: fixture.specPath }));
  });

  it('reports missing verification-layer coverage against spec.md', async () => {
    const { result, fixture } = await lintFixture(cleanOptions({ verification: undefined }));

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'missing-verification-layer', path: fixture.specPath }));
  });

  it('reports a task without test commands against the exact task document', async () => {
    const { result, fixture } = await lintFixture(cleanOptions({
      tasks: [{ id: 'task-001-no-command', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/task-001.ts'] }],
    }));

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'task-missing-test-command', path: fixture.taskPaths['task-001-no-command'] }));
  });

  it('reports an over-wide task write scope against the exact task document', async () => {
    const { result, fixture } = await lintFixture(cleanOptions({
      tasks: [{
        id: 'task-001-wide-scope',
        requirements: ['REQ-001'],
        acceptanceCriteria: ['AC-001'],
        writeScope: ['src', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
        testCommands: ['pnpm test'],
      }],
    }));

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'task-write-scope-too-wide', path: fixture.taskPaths['task-001-wide-scope'] }));
  });

  it('reports an over-split plan against plan.md', async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      return {
        id: `task-${number}-fragment`,
        requirements: ['REQ-001'],
        acceptanceCriteria: ['AC-001'],
        writeScope: [`src/fragment-${number}.ts`],
        testCommands: ['pnpm test'],
      };
    });
    const { result, fixture } = await lintFixture(cleanOptions({ tasks }));

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'task-over-split', path: fixture.planPath }));
  });

  it('returns the stable success shape with no warnings for a complete plan and writes no file', async () => {
    const root = await temporary('ai-workflow-lint-unit-success-');
    const fixture = await writeFixture(root, cleanOptions());
    const before = await snapshotTree(root);

    const result = (await lintPlan(fixture.directory)) as LintResult;

    expect(result).toEqual({ valid: true, plan_id: '20261114-lint-fixture', warnings: [] });
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  });

  it('rejects a directory that is not a frozen plan with its exact path', async () => {
    const root = await temporary('ai-workflow-lint-unit-invalid-');
    const directory = join(root, 'not-a-frozen-plan');
    await mkdir(directory, { recursive: true });

    const failure = await lintPlan(directory).then(() => undefined, (error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain(directory);
    expect(failure?.message).toMatch(/spec\.md|plan\.md|frozen plan/i);
  });
});


describe('lintPlan advisory schedule warnings', () => {
  function warningsOf(result: LintResult, code: string): LintWarning[] {
    return result.warnings.filter((warning) => warning.code === code);
  }

  function linearTasks(): TaskFixture[] {
    return [
      { id: 'task-001-first', dependsOn: [] },
      { id: 'task-002-second', dependsOn: ['task-001-first'] },
      { id: 'task-003-third', dependsOn: ['task-002-second'] },
    ].map((task) => ({
      id: task.id,
      dependsOn: task.dependsOn,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      writeScope: [`src/${task.id}.ts`],
      testCommands: ['pnpm test'],
    }));
  }

  function phaseTasks(): { tasks: TaskFixture[]; phases: string[][] } {
    const backend = ['task-001-backend-a', 'task-002-backend-b'];
    const frontend = ['task-003-frontend-a', 'task-004-frontend-b'];
    const tasks = [...backend, ...frontend].map((id) => ({
      id,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      writeScope: [`src/${id}.ts`],
      testCommands: ['pnpm test'],
      surface: backend.includes(id) ? 'backend' : 'frontend',
    }));
    return { tasks, phases: [backend, frontend] };
  }

  function verifyTask(id: string, dependsOn: string[]): TaskFixture {
    return {
      id,
      dependsOn,
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      writeScope: [`tests/${id}.test.ts`],
      testCommands: ['pnpm test'],
      surface: 'test',
    };
  }

  async function lintSchedule(options: FixtureOptions): Promise<{ result: LintResult; fixture: WrittenFixture; before: Map<string, string>; after: Map<string, string> }> {
    const root = await temporary('ai-workflow-lint-schedule-');
    const fixture = await writeFixture(root, cleanOptions(options));
    const before = await snapshotTree(root);
    const result = (await lintPlan(fixture.directory)) as LintResult;
    return { result, fixture, before, after: await snapshotTree(root) };
  }

  it('AC-003 emits exactly one plan-schedule-serial for three linear tasks and writes no file', async () => {
    const tasks = linearTasks();
    const { result, fixture, before, after } = await lintSchedule({ tasks, phases: tasks.map((task) => [task.id]) });

    expect(result.valid).toBe(true);
    const warnings = warningsOf(result, 'plan-schedule-serial');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(expect.objectContaining({ path: fixture.planPath }));
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('AC-004 emits one deduplicated warning naming both uncovered parallel implementation phases', async () => {
    const { tasks, phases } = phaseTasks();
    const { result, fixture, before, after } = await lintSchedule({ tasks, phases });

    expect(result.valid).toBe(true);
    const warnings = warningsOf(result, 'parallel-tasks-without-integration-verify');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(expect.objectContaining({ path: fixture.planPath }));
    expect(warnings[0]?.message).toMatch(/\b1\b/);
    expect(warnings[0]?.message).toMatch(/\b2\b/);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('AC-004 does not accept one test task depending on one task from each parallel phase', async () => {
    const { tasks, phases } = phaseTasks();
    const cross = verifyTask('task-005-cross', ['task-001-backend-a', 'task-003-frontend-a']);
    const { result } = await lintSchedule({ tasks: [...tasks, cross], phases: [...phases, [cross.id]] });

    const warnings = warningsOf(result, 'parallel-tasks-without-integration-verify');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/\b1\b/);
    expect(warnings[0]?.message).toMatch(/\b2\b/);
  });

  it('AC-004 emits no warning when later test tasks cover each parallel implementation phase', async () => {
    const { tasks, phases } = phaseTasks();
    const backendVerify = verifyTask('task-005-verify-backend', ['task-001-backend-a', 'task-002-backend-b']);
    const frontendVerify = verifyTask('task-006-verify-frontend', ['task-003-frontend-a', 'task-004-frontend-b']);
    const { result } = await lintSchedule({ tasks: [...tasks, backendVerify, frontendVerify], phases: [...phases, [backendVerify.id], [frontendVerify.id]] });

    expect(warningsOf(result, 'parallel-tasks-without-integration-verify')).toHaveLength(0);
  });

  it('AC-005 falls back to depends_on grouping when execution-order.yaml is missing', async () => {
    const tasks = linearTasks();
    const { result, before, after } = await lintSchedule({ tasks, phases: null });

    expect(result.valid).toBe(true);
    expect(warningsOf(result, 'plan-schedule-serial')).toHaveLength(1);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('AC-005 falls back to depends_on grouping when execution-order.yaml is malformed', async () => {
    const tasks = linearTasks();
    const { result, before, after } = await lintSchedule({ tasks, rawSchedule: 'phases: [unterminated\n' });

    expect(result.valid).toBe(true);
    expect(warningsOf(result, 'plan-schedule-serial')).toHaveLength(1);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('AC-005 skips schedule warnings without throwing on a depends_on cycle', async () => {
    const tasks = linearTasks();
    tasks[0] = { ...tasks[0] as TaskFixture, dependsOn: ['task-003-third'] };
    const { result, before, after } = await lintSchedule({ tasks, phases: null });

    expect(result.valid).toBe(true);
    expect(warningsOf(result, 'plan-schedule-serial')).toHaveLength(0);
    expect(warningsOf(result, 'parallel-tasks-without-integration-verify')).toHaveLength(0);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('AC-005 ignores dangling dependency IDs while grouping by depends_on', async () => {
    const tasks = linearTasks();
    tasks[1] = { ...tasks[1] as TaskFixture, dependsOn: ['task-001-first', 'task-099-missing'] };
    const { result } = await lintSchedule({ tasks, phases: null });

    expect(result.valid).toBe(true);
    expect(warningsOf(result, 'plan-schedule-serial')).toHaveLength(1);
  });

  it('does not emit plan-schedule-serial for a two-task linear plan', async () => {
    const tasks = linearTasks().slice(0, 2);
    const { result } = await lintSchedule({ tasks, phases: tasks.map((task) => [task.id]) });

    expect(warningsOf(result, 'plan-schedule-serial')).toHaveLength(0);
  });

  it('does not emit a verification warning for parallel documentation and research tasks', async () => {
    const tasks: TaskFixture[] = [
      { id: 'task-001-doc', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['docs/one.md'], testCommands: ['pnpm test'], surface: 'documentation' },
      { id: 'task-002-research', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['docs/two.md'], testCommands: ['pnpm test'], surface: 'research' },
    ];
    const { result } = await lintSchedule({ tasks, phases: [tasks.map((task) => task.id)] });

    expect(warningsOf(result, 'parallel-tasks-without-integration-verify')).toHaveLength(0);
  });
});
