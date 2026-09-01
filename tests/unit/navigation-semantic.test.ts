import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateContext } from '../../src/context/validate.js';
import { temporary } from '../helpers.js';

const markdown = `# Feature navigation

| Feature | Entries | Public Symbols | Related Files | Tests | Read Scope | Owner | Responsibility |
| --- | --- | --- | --- | --- | --- | --- | --- |
| workflow parsing | src/workflow/parse.ts | src/workflow/parse.ts#readPlan, src/workflow/digest.ts#digestPlan | src/workflow/digest.ts | tests/unit/navigation-semantic.test.ts | src/workflow/parse.ts, src/workflow/digest.ts, tests/unit/navigation-semantic.test.ts | frontend | frozen-plan validation |
`;

function navigation(language = 'typescript') {
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
      relations: [{ kind: 'calls', from: 'src/workflow/parse.ts#readPlan', to: 'src/workflow/digest.ts#digestPlan' }],
      owner_role: 'frontend', responsibility: 'frozen-plan validation',
      read_scope: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/navigation-semantic.test.ts'], shared_entry: false
    }]
  };
}

async function projectWithWorkflow(index = navigation(), parse = 'export function readPlan(): void {}\n'): Promise<string> {
  const project = await temporary('ai-workflow-navigation-semantic-');
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, 'tests/unit'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'src/workflow/parse.ts'), parse);
  await writeFile(join(project, 'src/workflow/digest.ts'), 'export function digestPlan(): void {}\n');
  await writeFile(join(project, 'tests/unit/navigation-semantic.test.ts'), '');
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), markdown);
  return project;
}

describe('navigation semantic validation', () => {
  it('marks the index stale when a declared public TypeScript symbol no longer exists', async () => {
    const project = await projectWithWorkflow(navigation(), 'export function parsePlan(): void {}\n');

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Navigation index is stale: src/workflow/parse.ts no longer contains readPlan');
  });

  it('marks the index stale when a declared relation target no longer exists', async () => {
    const index = navigation();
    index.features[0]!.symbols = [{ file: 'src/workflow/parse.ts', name: 'readPlan', kind: 'function', visibility: 'public' }];
    const project = await projectWithWorkflow(index);
    await writeFile(join(project, 'src/workflow/digest.ts'), 'export function makeDigest(): void {}\n');

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Navigation index is stale: src/workflow/digest.ts no longer contains digestPlan');
  });

  it('rejects a module root whose language parser is unsupported', async () => {
    const project = await projectWithWorkflow(navigation('rust'));

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unsupported navigation language parser: rust');
  });
});
