import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { packagePath } from '../../src/utils/schema.js';

const PLANNING_SKILL = ['templates', 'skills', 'planning', 'SKILL.md'];
const PLANNING_PLAN_REFERENCE = ['templates', 'skills', 'planning', 'references', 'plan.md'];
const PLAN_TO_TASKS_SKILL = ['templates', 'skills', 'plan-to-tasks', 'SKILL.md'];
const TASK_REFERENCE = ['templates', 'skills', 'plan-to-tasks', 'references', 'task.md'];
const EXECUTION_ORDER_REFERENCE = ['templates', 'skills', 'plan-to-tasks', 'references', 'execution-order.md'];

/** Read a shipped template without importing it, so a missing file is an assertion, not a crash. */
async function readShipped(parts: string[]): Promise<string | null> {
  try {
    return await readFile(packagePath(...parts), 'utf8');
  } catch {
    return null;
  }
}

/** Extract one `## Heading` section up to the next level-two heading. */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Parse every ```yaml fenced block, skipping blocks that are not valid YAML. */
function parsedYamlFences(text: string): unknown[] {
  return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? '')
    .flatMap((block) => {
      try {
        return [parse(block)];
      } catch {
        return [];
      }
    });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extract the frontmatter body between the first `---` pair. */
function frontmatter(text: string): string {
  return text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
}

/** Assert every required fragment appears in the scoped text, naming the missing fragment. */
function expectFragments(haystack: string, fragments: readonly string[], scope: string): void {
  for (const fragment of fragments) {
    expect(haystack, `${scope} must contain "${fragment}"`).toContain(fragment);
  }
}

describe('planning declares and freezes a workspace plan (REQ-002 / AC-003, AC-004)', () => {
  it('ships a Workspace planning section covering detection, participation and child context', async () => {
    const text = await readShipped(PLANNING_SKILL);
    expect(text, 'the planning skill is shipped').not.toBeNull();
    const workspace = section(text ?? '', '## Workspace planning');
    expect(workspace, 'the Workspace planning section exists').not.toBe('');

    expectFragments(
      workspace,
      [
        '.gitmodules',
        'workspace root',
        'participating repositories',
        'dependency order',
        'clarification',
        'own project contract',
        'MEMORY.md',
        "navigation through that repository's root"
      ],
      'the Workspace planning section'
    );
  });

  it('ships the workspace_repos declaration and the per-repository delivery boundary', async () => {
    const workspace = section((await readShipped(PLANNING_SKILL)) ?? '', '## Workspace planning');
    expect(workspace, 'the Workspace planning section exists').not.toBe('');

    expectFragments(
      workspace,
      [
        'workspace_repos',
        'name',
        'section name',
        'path',
        'depends_on',
        'reserved',
        'root entry',
        'per-repository delivery boundary'
      ],
      'the Workspace planning declaration'
    );
  });

  it('stops before freezing when a participating child is not initialized', async () => {
    const workspace = section((await readShipped(PLANNING_SKILL)) ?? '', '## Workspace planning');
    expect(workspace, 'the Workspace planning section exists').not.toBe('');

    expectFragments(
      workspace,
      [
        'stops before freezing',
        'not an initialized ai-workflow project',
        'ai-workflow init <child> --upgrade'
      ],
      'the missing-child stop'
    );
  });

  it('schedules per-repository note work and hands off the distribution step', async () => {
    const workspace = section((await readShipped(PLANNING_SKILL)) ?? '', '## Workspace planning');
    expect(workspace, 'the Workspace planning section exists').not.toBe('');

    expectFragments(
      workspace,
      [
        "schedules each repository's note",
        'MEMORY.md',
        'in that repository',
        'hands off',
        'ai-workflow workspace distribute --plan <directory>'
      ],
      'the per-repository note schedule and hand-off'
    );
  });
});

describe('planning plan reference declares the workspace repositories (REQ-002 / AC-003)', () => {
  it('ships a Workspace repositories section with a workspace_repos yaml declaration', async () => {
    const text = await readShipped(PLANNING_PLAN_REFERENCE);
    expect(text, 'the planning plan reference is shipped').not.toBeNull();
    const workspace = section(text ?? '', '## Workspace repositories');
    expect(workspace, 'the Workspace repositories section exists').not.toBe('');

    const parsed = parsedYamlFences(workspace)
      .map(asRecord)
      .find((record) => record !== null && Array.isArray(record.workspace_repos));
    expect(parsed, 'the section shows a yaml fence carrying workspace_repos').toBeTruthy();

    const repos = (parsed as Record<string, unknown>).workspace_repos as unknown[];
    expect(Array.isArray(repos), 'workspace_repos is a list').toBe(true);
    expect(repos.length, 'workspace_repos lists at least the reserved root entry').toBeGreaterThan(0);
    for (const entry of repos) {
      const record = asRecord(entry);
      expect(record, 'every workspace_repos entry is an object').not.toBeNull();
      expect(typeof record?.name, 'every entry carries name').toBe('string');
      expect(typeof record?.path, 'every entry carries path').toBe('string');
      expect(Array.isArray(record?.depends_on), 'every entry carries depends_on').toBe(true);
    }

    const roots = repos.map(asRecord).filter((record) => record?.name === 'workspace');
    expect(roots, 'exactly one reserved workspace root entry is declared').toHaveLength(1);
    expect(roots[0]?.path, 'the reserved root entry uses path "."').toBe('.');
    expect(roots[0]?.depends_on, 'the reserved root entry depends on nothing').toEqual([]);
  });

  it('states the reserved root entry and the per-repository delivery boundary in prose', async () => {
    const workspace = section((await readShipped(PLANNING_PLAN_REFERENCE)) ?? '', '## Workspace repositories');
    expect(workspace, 'the Workspace repositories section exists').not.toBe('');

    expectFragments(workspace, ['reserved', 'root entry', 'per-repository delivery boundary', 'section name'], 'the plan reference prose');
  });
});

describe('plan-to-tasks splits a workspace plan (REQ-004 / AC-007, AC-023)', () => {
  it('ships a Workspace split section covering repo assignment and repository order', async () => {
    const text = await readShipped(PLAN_TO_TASKS_SKILL);
    expect(text, 'the plan-to-tasks skill is shipped').not.toBeNull();
    const workspace = section(text ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');

    expectFragments(
      workspace,
      [
        'repo',
        'to every task',
        "derives each repository's phases from the declared order",
        'repository-internal task DAG',
        'repository phases',
        'critical path'
      ],
      'the workspace repo assignment and phases'
    );
  });

  it('ships the workspace.yaml write point and the reserved root entry tasks', async () => {
    const workspace = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');

    expectFragments(
      workspace,
      [
        'workspace.yaml',
        'reserved',
        'root entry',
        'its tasks',
        'after the task triplets and their pair records',
        'before the final',
        'ai-workflow plan validate --plan <directory>',
        'workspace_repos',
        'unchanged'
      ],
      'the workspace manifest write point'
    );
  });

  it('shows the workspace manifest shape in a yaml fence', async () => {
    const workspace = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');

    const parsed = parsedYamlFences(workspace)
      .map(asRecord)
      .find((record) => record !== null && record.role === 'workspace' && Array.isArray(record.repositories));
    expect(parsed, 'the section shows a workspace-role yaml fence').toBeTruthy();
    expect(typeof (parsed as Record<string, unknown>).plan_id, 'the manifest carries plan_id').toBe('string');

    const repositories = (parsed as Record<string, unknown>).repositories as unknown[];
    expect(Array.isArray(repositories), 'repositories is a list').toBe(true);
    expect(repositories.length, 'repositories lists at least one entry').toBeGreaterThan(0);
    for (const entry of repositories) {
      const record = asRecord(entry);
      expect(record, 'every repository entry is an object').not.toBeNull();
      expect(typeof record?.name, 'every entry carries name').toBe('string');
      expect(typeof record?.path, 'every entry carries path').toBe('string');
      expect(Array.isArray(record?.depends_on), 'every entry carries depends_on').toBe(true);
      expect(Array.isArray(record?.requirements), 'every entry carries requirements').toBe(true);
      expect(Array.isArray(record?.acceptance_criteria), 'every entry carries acceptance_criteria').toBe(true);
    }
  });
});

describe('plan-to-tasks task reference scopes a task to its repository (REQ-004 / AC-007)', () => {
  it('carries a repo key in the frontmatter yaml fence', async () => {
    const text = await readShipped(TASK_REFERENCE);
    expect(text, 'the task reference is shipped').not.toBeNull();
    const block = frontmatter(text ?? '');
    expect(block, 'the task reference has a frontmatter yaml fence').not.toBe('');

    const parsed = asRecord(parse(block));
    expect(parsed, 'the frontmatter parses as a mapping').not.toBeNull();
    expect(parsed, 'the task frontmatter carries a repo key').toHaveProperty('repo');
  });

  it('ships a Repository scope section with the repo rules', async () => {
    const repository = section((await readShipped(TASK_REFERENCE)) ?? '', '## Repository scope');
    expect(repository, 'the Repository scope section exists').not.toBe('');

    expectFragments(
      repository,
      [
        'required exactly when the plan declares repositories',
        'forbidden otherwise',
        'repository-relative',
        'cross-repository',
        'depends_on'
      ],
      'the Repository scope section'
    );
  });
});

describe('plan-to-tasks execution-order reference orders repositories (REQ-004 / AC-023)', () => {
  it('ships a Workspace repositories section with the declared-order rule', async () => {
    const text = await readShipped(EXECUTION_ORDER_REFERENCE);
    expect(text, 'the execution-order reference is shipped').not.toBeNull();
    const workspace = section(text ?? '', '## Workspace repositories');
    expect(workspace, 'the Workspace repositories section exists').not.toBe('');

    expectFragments(
      workspace,
      [
        'declared order',
        "repository's task DAG",
        'inside one repository',
        'disjoint',
        'strictly after every task of the repositories it depends on'
      ],
      'the Workspace repositories section'
    );
  });
});
