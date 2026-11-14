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
}

interface FixtureOptions {
  requirements?: string[];
  acceptanceCriteria?: string[];
  coverage?: string[][];
  nonGoals?: string[];
  givenWhenThen?: boolean;
  boundaries?: string[];
  counterexamples?: string[];
  verification?: string[][];
  tasks?: TaskFixture[];
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
        depends_on: [],
        surface: 'backend',
        read_scope: ['MEMORY.md'],
        write_scope: task.writeScope,
      };
      if (task.testCommands !== undefined) taskAttributes.test_commands = task.testCommands;
      await writePlanTriplet(join(directory, 'tasks'), `${task.id}.md`, '# Task', '# Task', (body) => renderMarkdown(taskAttributes, body));
      taskPaths[task.id] = join(directory, 'tasks', `${task.id}.md`);
    }
    await writeFile(join(directory, 'tasks', 'execution-order.yaml'), renderExecutionOrderYaml(planId, [options.tasks.map((task) => task.id)]));
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
