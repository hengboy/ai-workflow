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
        const value: unknown = parse(block);
        return [value];
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

/** Whitespace-normalized text so multi-word fragments match across source wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
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
    const skill = (await readShipped(PLANNING_SKILL)) ?? '';
    const workspace = section(skill, '## Workspace planning');
    expect(workspace, 'the Workspace planning section exists').not.toBe('');
    expect(workspace, 'workspace fields use the mandatory plan template').toContain('using the mandatory plan template');
    expect(section(skill, '## Document contract'), 'the plan template is read before drafting').toMatch(
      /Before drafting, read [^\n]*\[the implementation plan template\]\(references\/plan\.md\)/,
    );
    const repositories = section((await readShipped(PLANNING_PLAN_REFERENCE)) ?? '', '## Workspace repositories');

    expectFragments(
      repositories,
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

  it('schedules per-repository note work and owns the chained split in the Completion checklist', async () => {
    const skill = (await readShipped(PLANNING_SKILL)) ?? '';
    const workspace = section(skill, '## Workspace planning');
    expect(workspace, 'the Workspace planning section exists').not.toBe('');

    expectFragments(
      workspace,
      [
        "schedules each repository's note",
        'MEMORY.md',
        'in that repository'
      ],
      'the per-repository note schedule and hand-off'
    );
    expect(workspace, 'workspace planning routes the handoff to its owner').toContain('the Completion checklist owns the split and session handoff');
    const completion = flatten(section(skill, '## Completion checklist'));
    expect(completion, 'the Completion checklist automatically chains plan-to-tasks after the freeze').toMatch(
      /automatic\w*[^.]{0,160}plan-to-tasks[^.]{0,160}preparation procedure/i,
    );
    expect(completion, 'the chain runs in this planning session before the handoff').toMatch(
      /(?:this|the same) session/i,
    );
    expect(completion, 'the completion states the freeze gate before the handoff').toMatch(
      /frozen only after[^.]{0,240}(?:slice|repository|distribution)/i,
    );
    expect(completion, 'the completion reports every participant slice state').toContain('slice state');
    expect(completion, 'the chained split still distributes every participating slice').toContain(
      'ai-workflow workspace distribute --plan <directory>',
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
    expect(section(text ?? '', '## Decomposition rules'), 'repository phases load their authority before computation').toContain(
      'Read [the execution-order reference](references/execution-order.md) before computing phases or previewing the graph',
    );
    const order = section((await readShipped(EXECUTION_ORDER_REFERENCE)) ?? '', '## Workspace repositories');
    expect(order, 'repository phase derivation still follows the declared order').toContain("derives each repository's phases from the declared order");

    expectFragments(
      workspace,
      [
        'repo',
        'to every task',
        'repository-internal task DAG',
        'repository phases',
        'critical path'
      ],
      'the workspace repo assignment and phases'
    );
  });

  it('ships the workspace.yaml write point and the reserved root entry tasks', async () => {
    const skill = (await readShipped(PLAN_TO_TASKS_SKILL)) ?? '';
    const workspace = section(skill, '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');
    expect(workspace, 'workspace splitting follows the shared manifest write step').toContain("Write `workspace.yaml` at the Task file contract's manifest step");
    const writeOrder = section(skill, '## Task file contract');
    expectFragments(writeOrder, ['workspace.yaml', 'after the task triplets and their pair records', 'before the final', 'ai-workflow plan validate --plan <directory>'], 'the manifest write order');

    expectFragments(
      workspace,
      [
        'workspace.yaml',
        'reserved',
        'root entry',
        'its tasks',
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

describe('planning owns the workspace split handoff and exempts a root-only plan (REQ-004 / AC-007)', () => {
  it('requires splitting a cross-repository workspace plan before implementation and never hands distribution to a separate split session', async () => {
    const text = await readShipped(PLANNING_SKILL);
    expect(text, 'the planning skill is shipped').not.toBeNull();
    const workspace = section(text ?? '', '## Workspace planning');
    expect(workspace, 'the Workspace planning section exists').not.toBe('');
    expect(workspace, 'Planning retains its no-slice boundary').toContain('never distributes or writes a slice');
    expect(workspace, 'the completion checklist owns the workspace handoff').toContain('the Completion checklist owns the split and session handoff');
    expect(workspace, 'the Workspace planning section names the automatic plan-to-tasks chain').toMatch(
      /automatic\w*[^.]{0,160}plan-to-tasks[^.]{0,160}(?:preparation|split|procedure)/i,
    );
    const completion = flatten(section(text ?? '', '## Completion checklist'));

    expectFragments(
      completion,
      [
        'at least one non-root participating repository',
        'plan-to-tasks',
        'before implementation'
      ],
      'the planning workspace split handoff'
    );
    expect(
      flatten(workspace),
      'Planning no longer hands distribution to a separate split session',
    ).not.toContain('split session owns distribution');
    expect(completion, 'the completion handoff also excludes a separate split session').not.toContain('split session owns distribution');
  });

  it('exempts a workspace plan that declares only the reserved workspace root entry', async () => {
    const skill = (await readShipped(PLANNING_SKILL)) ?? '';
    const workspace = section(skill, '## Workspace planning');
    expect(workspace, 'the Workspace planning section exists').not.toBe('');
    expect(workspace, 'the completion checklist owns root-only routing').toContain('the Completion checklist owns the split and session handoff');

    expectFragments(
      flatten(section(skill, '## Completion checklist')),
      ['workspace_repos', 'reserved workspace root entry', 'implemented unsplit'],
      'the planning root-only workspace exemption'
    );
  });
});

describe('planning completion chains the split and routes to a new coding session (REQ-001, REQ-004 / AC-001, AC-005)', () => {
  it('chains the split before a new session at the workspace root that implements the frozen plan', async () => {
    const text = await readShipped(PLANNING_SKILL);
    expect(text, 'the planning skill is shipped').not.toBeNull();
    const completion = section(text ?? '', '## Completion checklist');
    expect(completion, 'the Completion checklist section exists').not.toBe('');
    const flat = flatten(completion);

    expectFragments(
      flat,
      [
        'at least one non-root participating repository',
        'plan-to-tasks',
        'preparation procedure',
        'plan validate',
        'name',
        'path',
        'depends_on',
        'slice state',
        'new session',
        '<workspace-root>',
        'invoke the coding skill',
        'frozen plan directory'
      ],
      'the workspace planning completion handoff'
    );
    expect(flat, 'the chain runs in the same planning session before the handoff').toMatch(
      /(?:this|the same) session/i,
    );
    expect(flat, 'the task set freezes only after every participating repository received its slice').toMatch(
      /frozen only after[^.]{0,240}(?:slice|repository|distribution)/i,
    );
    expect(flat, 'the completion requires the workspace status gate with every slice present').toMatch(
      /(?:workspace status[^.]{0,200}valid|valid[^.]{0,160}workspace status)/i,
    );
    expect(flat, 'the superseded do-not-invoke-coding instruction is removed').not.toMatch(/do not invoke coding/i);
    expect(
      flat,
      'Planning no longer routes the new session to plan-to-tasks as its skill',
    ).not.toMatch(/invoke plan-to-tasks with the absolute frozen plan directory/i);
  });

  it('gives no implementation prompt on a declined approval or a refused distribution', async () => {
    const completion = flatten(section((await readShipped(PLANNING_SKILL)) ?? '', '## Completion checklist'));
    expect(completion, 'the Completion checklist section exists').not.toBe('');

    expect(completion, 'a declined approval produces no implementation prompt').toMatch(
      /declin\w*[^.]{0,400}(?:no implementation|without an? implementation|not frozen|repairable)/i,
    );
    expect(completion, 'a refused distribution produces no implementation prompt').toMatch(
      /refus\w*[^.]{0,400}(?:no implementation|without an? implementation|not frozen|repairable)/i,
    );
    expect(completion, 'no implementation state begins while the task set is unfrozen').toMatch(
      /unfrozen|not frozen|no implementation (?:prompt|state)/i,
    );
  });

  it('preserves the root-only or ordinary route to a coding session', async () => {
    const completion = section((await readShipped(PLANNING_SKILL)) ?? '', '## Completion checklist');
    expect(completion, 'the Completion checklist section exists').not.toBe('');

    expectFragments(
      flatten(completion),
      ['root-only', 'invoke the coding skill'],
      'the root-only planning completion handoff'
    );
  });
});

describe('planning plan reference documents workspace_finalization as separate coverage (REQ-007 / AC-009)', () => {
  it('declares root-owned frozen finalization coverage disjoint from the task DAG', async () => {
    const text = await readShipped(PLANNING_PLAN_REFERENCE);
    expect(text, 'the planning plan reference is shipped').not.toBeNull();
    const reference = flatten(text ?? '');

    expectFragments(
      reference,
      [
        'workspace_finalization',
        'requirements',
        'acceptance_criteria',
        'read_scope',
        'write_scope',
        'test_commands',
        'disjoint',
        'never becomes a task',
        'never joins the execution order',
        'not sliced',
        'union'
      ],
      'the workspace finalization coverage'
    );
  });
});
