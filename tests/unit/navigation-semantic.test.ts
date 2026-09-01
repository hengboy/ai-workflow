import { describe, expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateContext, verifyNavigation } from '../../src/context/validate.js';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { temporary } from '../helpers.js';

function navigation(language = 'typescript'): NavigationIndex {
  return {
    version: 1,
    module_roots: [{ id: 'workflow', path: 'src/workflow', owner_role: 'frontend', responsibility: 'workflow runtime', language, entry_kinds: ['exported-symbol'] }],
    features: [{
      id: 'workflow-parsing', name: 'workflow parsing', aliases: [], module_root: 'workflow', entries: ['src/workflow/parse.ts'],
      symbols: [
        { file: 'src/workflow/parse.ts', name: 'readPlan', kind: 'function', visibility: 'public' },
        { file: 'src/workflow/digest.ts', name: 'digestPlan', kind: 'function', visibility: 'public' }
      ],
      related_files: ['src/workflow/digest.ts'], tests: ['tests/unit/navigation-semantic.test.ts'], depends_on: [],
      relations: [{ kind: 'imports', from: 'src/workflow/parse.ts#readPlan', to: 'src/workflow/digest.ts#digestPlan' }],
      owner_role: 'frontend', responsibility: 'frozen-plan validation',
      read_scope: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/navigation-semantic.test.ts'], shared_entry: false
    }]
  };
}

async function projectWithWorkflow(index = navigation(), parse = "import { digestPlan } from './digest.js';\nexport function readPlan(): void { digestPlan(); }\n"): Promise<string> {
  const project = await temporary('ai-workflow-navigation-semantic-');
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, 'tests/unit'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'src/workflow/parse.ts'), parse);
  await writeFile(join(project, 'src/workflow/digest.ts'), 'export function digestPlan(): void {}\n');
  await writeFile(join(project, 'tests/unit/navigation-semantic.test.ts'), '');
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));
  return project;
}

describe('navigation semantic validation', () => {
  it('marks the index stale when a module root adds a public TypeScript symbol', async () => {
    const project = await projectWithWorkflow(navigation(), "import { digestPlan } from './digest.js';\nexport function readPlan(): void { digestPlan(); }\nexport function parsePlan(): void {}\n");

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Navigation index is stale: added symbol src/workflow/parse.ts#parsePlan');
  });

  it('marks the index stale when an indexed public TypeScript symbol is removed', async () => {
    const project = await projectWithWorkflow(navigation(), "import { digestPlan } from './digest.js';\nexport function parsePlan(): void { digestPlan(); }\n");

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Navigation index is stale: removed symbol src/workflow/parse.ts#readPlan');
  });

  it('marks the index stale when a direct import relation changes', async () => {
    const project = await projectWithWorkflow(navigation(), 'export function readPlan(): void {}\n');

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Navigation index is stale: relation change imports src/workflow/parse.ts#readPlan -> src/workflow/digest.ts#digestPlan');
  });

  it('reports a featureless module root and illegal feature owner alignment', async () => {
    const index = navigation();
    index.module_roots[0]!.owner_role = 'backend';
    index.module_roots.push({ id: 'unused', path: 'src/unused', owner_role: 'frontend', responsibility: 'unused', language: 'typescript', entry_kinds: ['exported-symbol'] });
    const project = await projectWithWorkflow(index);
    await mkdir(join(project, 'src/unused'));

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('workflow-parsing: owner mismatch for module root workflow');
    expect(result.errors).toContain('unused: featureless module root');
  });

  it('rejects a module root whose language parser is unsupported', async () => {
    const project = await projectWithWorkflow(navigation('rust'));

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unsupported navigation language parser: rust');
  });

  it('verifies a selected feature module root is a contained concrete directory', async () => {
    const project = await temporary('ai-workflow-navigation-semantic-link-');
    const outside = await temporary('ai-workflow-navigation-semantic-outside-');
    const index = navigation();
    await mkdir(join(project, 'src'), { recursive: true });
    await mkdir(join(project, 'tests/unit'), { recursive: true });
    await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
    await mkdir(join(outside, 'workflow'));
    await writeFile(join(outside, 'workflow/parse.ts'), 'export function readPlan(): void {}\n');
    await writeFile(join(outside, 'workflow/digest.ts'), 'export function digestPlan(): void {}\n');
    await writeFile(join(project, 'tests/unit/navigation-semantic.test.ts'), '');
    await symlink(join(outside, 'workflow'), join(project, 'src/workflow'));
    await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
    await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));

    const result = await verifyNavigation(project, 'workflow-parsing');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('src/workflow: module root symlink escapes project');
  });
});
