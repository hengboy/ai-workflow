import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

async function projectWithUnclassifiedFile(): Promise<string> {
  const project = await temporary('ai-workflow-navigation-validate-');
  const index: NavigationIndex = {
    version: 1,
    module_roots: [{ id: 'workflow', path: 'src/workflow', owner_role: 'frontend', responsibility: 'workflow runtime', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [{
      id: 'workflow-parsing', name: 'workflow parsing', aliases: [], module_root: 'workflow', entries: ['src/workflow/parse.ts'],
      symbols: [{ file: 'src/workflow/parse.ts', name: 'readPlan', kind: 'function', visibility: 'public' }], related_files: [],
      tests: ['tests/unit/navigation-validate-cli.test.ts'], depends_on: [], relations: [], owner_role: 'frontend', responsibility: 'frozen-plan validation',
      read_scope: ['src/workflow/parse.ts', 'tests/unit/navigation-validate-cli.test.ts'], shared_entry: false
    }]
  };
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, 'tests/unit'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'src/workflow/parse.ts'), 'export function readPlan(): void {}\n');
  await writeFile(join(project, 'src/workflow/unclassified.ts'), 'export function newEntry(): void {}\n');
  await writeFile(join(project, 'tests/unit/navigation-validate-cli.test.ts'), '');
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));
  return project;
}

describe('context validate CLI', () => {
  it('checks one feature without traversing other module entries while --all reports drift', async () => {
    const project = await projectWithUnclassifiedFile();

    const feature = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--feature', 'workflow-parsing']);
    let allOutput = '';
    try {
      await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') allOutput = error.stdout;
    }

    expect(JSON.parse(feature.stdout)).toEqual({ valid: true, errors: [] });
    expect(JSON.parse(allOutput)).toEqual({ valid: false, errors: ['Navigation index is stale: unclassified module file src/workflow/unclassified.ts'] });
  });
});
