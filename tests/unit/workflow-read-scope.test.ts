import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateWorkflow } from '../../src/workflow/generate.js';
import { validateWorkflow } from '../../src/workflow/validate.js';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { frozenPlan, temporary } from '../helpers.js';

const fixedContext = ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'];

async function projectWithBoundTask(readScope = [...fixedContext, 'src/workflow/input.ts'], locatorReadOrder = ['src/workflow/input.ts']): Promise<string> {
  const project = await temporary('ai-workflow-workflow-scope-');
  const plan = await frozenPlan(project, false);
  const index: NavigationIndex = {
    version: 1,
    module_roots: [{ id: 'workflow', path: 'src/workflow', owner_role: 'frontend', responsibility: 'workflow', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [{
      id: 'task-input', name: 'task input', aliases: [], module_root: 'workflow', entries: ['src/workflow/input.ts'], symbols: [], related_files: [], tests: locatorReadOrder.filter((path) => path.startsWith('tests/')), depends_on: [], relations: [], owner_role: 'frontend', responsibility: 'workflow input', read_scope: locatorReadOrder, shared_entry: false
    }]
  };
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'MEMORY.md'), '# Memory\n');
  await writeFile(join(project, 'src/workflow/input.ts'), 'export const input = true;\n');
  await mkdir(join(project, 'tests/workflow'), { recursive: true });
  await writeFile(join(project, 'tests/workflow/input.test.ts'), 'export {};\n');
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));
  await writeFile(join(plan, 'tasks/task-001-example.md'), renderMarkdown({
    id: 'task-001-example', requirements: ['REQ-001'], acceptance_criteria: ['AC-001'], depends_on: [], surface: 'backend',
    feature: 'task-input', locator_read_order: locatorReadOrder, read_scope: readScope, write_scope: ['src/workflow/output.ts'], test_commands: ['pnpm test']
  }, '# Task'));
  return plan;
}

describe('workflow task read scope', () => {
  it('rejects a task that requests a directory read scope', async () => {
    const plan = await projectWithBoundTask(['src/workflow/']);

    await expect(generateWorkflow(plan, 'codex')).rejects.toThrow(/broad directory read_scope path: src\/workflow/);
  });

  it('propagates fixed context and exact locator files to every task node', async () => {
    const plan = await projectWithBoundTask();

    const workflow = await generateWorkflow(plan, 'codex');
    const nodes = workflow.nodes.filter((node) => node.task_id === 'task-001-example');

    expect(nodes).toHaveLength(6);
    for (const node of nodes) {
      expect(node.read_scope).toEqual(expect.arrayContaining([...fixedContext, 'src/workflow/input.ts']));
      expect(node.read_scope).not.toContain('src/workflow/');
    }
  });

  it('allows an exact test file returned by the verified locator', async () => {
    const locatorReadOrder = ['src/workflow/input.ts', 'tests/workflow/input.test.ts'];
    const workflow = await generateWorkflow(await projectWithBoundTask([...fixedContext, ...locatorReadOrder], locatorReadOrder), 'codex');

    for (const node of workflow.nodes.filter((candidate) => candidate.task_id === 'task-001-example')) {
      expect(node.read_scope).toEqual(expect.arrayContaining([...fixedContext, ...locatorReadOrder]));
    }
  });

  it('rejects a task whose recorded locator output differs from its feature', async () => {
    const plan = await projectWithBoundTask([...fixedContext, 'src/workflow/input.ts']);
    const path = join(plan, 'tasks/task-001-example.md');
    const source = await (await import('node:fs/promises')).readFile(path, 'utf8');
    await writeFile(path, source.replaceAll('src/workflow/input.ts', 'src/workflow/other.ts'));

    await expect(generateWorkflow(plan, 'codex')).rejects.toThrow(/locator_read_order does not match feature task-input/);
  });

  it('reports an exact path that the locator did not authorize', async () => {
    const plan = await projectWithBoundTask([...fixedContext, 'src/workflow/unlisted.ts']);

    await expect(generateWorkflow(plan, 'codex')).rejects.toThrow(/unauthorized read_scope path: src\/workflow\/unlisted\.ts/);
  });

  it('reports project roots and wildcards as invalid task read scope paths', async () => {
    await expect(generateWorkflow(await projectWithBoundTask(['.']), 'codex')).rejects.toThrow(/project root is not allowed/);
    await expect(generateWorkflow(await projectWithBoundTask([...fixedContext, 'src/workflow/*.ts']), 'codex')).rejects.toThrow(/wildcards are not allowed/);
  });

  it('rejects a task packet whose exact read path is not locator-authorized', async () => {
    const workflow = await generateWorkflow(await projectWithBoundTask(), 'codex');
    const node = workflow.nodes.find((candidate) => candidate.id === 'task-001-example-explore')!;
    node.read_scope = [...fixedContext, 'src/workflow/unlisted.ts'];

    const result = await validateWorkflow(workflow);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('task-001-example: unauthorized read_scope path: src/workflow/unlisted.ts');
  });
});
