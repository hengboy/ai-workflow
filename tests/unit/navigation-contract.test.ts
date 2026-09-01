import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateContext } from '../../src/context/validate.js';
import { temporary } from '../helpers.js';

const navigation = {
  version: 1,
  module_roots: [{
    id: 'workflow',
    path: 'src/workflow',
    owner_role: 'frontend',
    responsibility: 'workflow runtime',
    language: 'typescript',
    entry_kinds: ['exported-symbol']
  }],
  features: [{
    id: 'workflow-parsing',
    name: 'workflow parsing',
    aliases: [],
    module_root: 'workflow',
    entries: ['src/workflow/parse.ts'],
    symbols: [{ file: 'src/workflow/parse.ts', name: 'readPlan', kind: 'function', visibility: 'public' }],
    related_files: [],
    tests: ['tests/unit/navigation-contract.test.ts'],
    depends_on: [],
    relations: [],
    owner_role: 'frontend',
    responsibility: 'frozen-plan validation',
    read_scope: ['src/workflow/parse.ts', 'tests/unit/navigation-contract.test.ts'],
    shared_entry: false
  }]
};

async function projectWithNavigation(value: unknown): Promise<string> {
  const project = await temporary('ai-workflow-navigation-contract-');
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, 'tests/unit'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'src/workflow/parse.ts'), 'export function readPlan(): void {}\n');
  await writeFile(join(project, 'tests/unit/navigation-contract.test.ts'), '');
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(value)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), '# Feature navigation\n\n| Feature | Entries | Public Symbols | Related Files | Tests | Read Scope | Owner | Responsibility |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| workflow parsing | src/workflow/parse.ts | src/workflow/parse.ts#readPlan |  | tests/unit/navigation-contract.test.ts | src/workflow/parse.ts, tests/unit/navigation-contract.test.ts | frontend | frozen-plan validation |\n');
  return project;
}

describe('navigation index contract', () => {
  it('accepts an exact JSON index without project memory', async () => {
    const project = await projectWithNavigation(navigation);

    await expect(validateContext(project)).resolves.toMatchObject({ valid: true, errors: [] });
  });

  it.each([
    ['src/', /exact regular file/i],
    ['src/**/*.ts', /exact regular file/i],
    ['${SOURCE_FILE}', /exact regular file/i]
  ])('rejects non-exact read scope path %s', async (path, error) => {
    const project = await projectWithNavigation({
      ...navigation,
      features: [{ ...navigation.features[0], read_scope: [path] }]
    });

    const result = await validateContext(project);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(error));
  });

  it('rejects an index feature that declares write authorization', async () => {
    const project = await projectWithNavigation({
      ...navigation,
      features: [{ ...navigation.features[0], write_scope: ['src/workflow/parse.ts'] }]
    });

    const result = await validateContext(project);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(/write_scope/i));
  });

  it("requires read scope to cover the feature's exact read order", async () => {
    const project = await projectWithNavigation({
      ...navigation,
      features: [{ ...navigation.features[0], read_scope: ['src/workflow/parse.ts'] }]
    });

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('workflow-parsing read_scope must include tests/unit/navigation-contract.test.ts');
  });

  it('rejects a read scope containing a file outside the feature read order', async () => {
    const project = await projectWithNavigation({
      ...navigation,
      features: [{ ...navigation.features[0], read_scope: ['src/workflow/parse.ts', 'tests/unit/navigation-contract.test.ts', 'src/workflow/extra.ts'] }]
    });
    await writeFile(join(project, 'src/workflow/extra.ts'), 'export function extra(): void {}\n');

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('workflow-parsing read_scope has unneeded path src/workflow/extra.ts');
  });

  it('marks the index stale when a declared module root contains an unclassified TypeScript file', async () => {
    const project = await projectWithNavigation(navigation);
    await writeFile(join(project, 'src/workflow/unclassified.ts'), 'export function newEntry(): void {}\n');

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Navigation index is stale: unclassified module file src/workflow/unclassified.ts');
  });

  it('rejects a duplicated entry unless both features explicitly share it', async () => {
    const project = await projectWithNavigation({
      ...navigation,
      features: [
        navigation.features[0],
        { ...navigation.features[0], id: 'workflow-copy', name: 'workflow copy' }
      ]
    });

    const result = await validateContext(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('src/workflow/parse.ts is an illegal duplicate entry');
  });
});
