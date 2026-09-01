import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateWorkflow } from '../../src/workflow/generate.js';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { frozenPlan, temporary } from '../helpers.js';

const fixedContext = ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'];

async function projectWithBoundTask(readScope = [...fixedContext, 'src/workflow/input.ts']): Promise<string> {
  const project = await temporary('ai-workflow-workflow-scope-');
  const plan = await frozenPlan(project, false);
  const index: NavigationIndex = {
    version: 1,
    module_roots: [{ id: 'workflow', path: 'src/workflow', owner_role: 'frontend', responsibility: 'workflow', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [{
      id: 'task-input', name: 'task input', aliases: [], module_root: 'workflow', entries: ['src/workflow/input.ts'], symbols: [], related_files: [], tests: [], depends_on: [], relations: [], owner_role: 'frontend', responsibility: 'workflow input', read_scope: ['src/workflow/input.ts'], shared_entry: false
    }]
  };
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'MEMORY.md'), '# Memory\n');
  await writeFile(join(project, 'src/workflow/input.ts'), 'export const input = true;\n');
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));
  await writeFile(join(plan, 'tasks/task-001-example.md'), renderMarkdown({
    id: 'task-001-example', requirements: ['REQ-001'], acceptance_criteria: ['AC-001'], depends_on: [], surface: 'backend',
    feature: 'task-input', locator_read_order: ['src/workflow/input.ts'], read_scope: readScope, write_scope: ['src/workflow/output.ts'], test_commands: ['pnpm test']
  }, '# Task'));
  return plan;
}

describe('workflow task read scope', () => {
  it('rejects a task that requests a directory read scope', async () => {
    const plan = await projectWithBoundTask(['src/workflow/']);

    await expect(generateWorkflow(plan, 'codex')).rejects.toThrow(/Unsafe task read_scope: task-001-example/);
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

  it('rejects a task whose recorded locator output differs from its feature', async () => {
    const plan = await projectWithBoundTask([...fixedContext, 'src/workflow/input.ts']);
    const path = join(plan, 'tasks/task-001-example.md');
    const source = await (await import('node:fs/promises')).readFile(path, 'utf8');
    await writeFile(path, source.replaceAll('src/workflow/input.ts', 'src/workflow/other.ts'));

    await expect(generateWorkflow(plan, 'codex')).rejects.toThrow(/locator_read_order does not match feature task-input/);
  });
});
