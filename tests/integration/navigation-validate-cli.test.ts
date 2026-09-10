import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { initializeProject } from '../../src/install/index.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

async function projectWithNavigation(): Promise<string> {
  const project = await temporary('ai-workflow-navigation-validate-');
  const index: NavigationIndex = {
    version: 1,
    module_roots: [{ id: 'workflow', path: 'src/workflow', owner_role: 'frontend', responsibility: 'workflow runtime', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [{
      id: 'workflow-parsing', name: 'workflow parsing', aliases: ['frozen-plan'], module_root: 'workflow', entries: ['src/workflow/parse.ts'],
      symbols: [{ file: 'src/workflow/parse.ts', name: 'readPlan', kind: 'function', visibility: 'public' }], related_files: [],
      tests: ['tests/unit/navigation-validate-cli.test.ts'], depends_on: [], relations: [], owner_role: 'frontend', responsibility: 'frozen-plan validation',
      read_scope: ['src/workflow/parse.ts', 'tests/unit/navigation-validate-cli.test.ts'], shared_entry: false,
      task_ids: ['task-001-frozen-plan'], requirement_ids: ['REQ-001'], acceptance_criteria_ids: ['AC-001']
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
    const project = await projectWithNavigation();

    const feature = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--feature', 'workflow-parsing']);
    let allOutput = '';
    try {
      await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') allOutput = error.stdout;
    }

    expect(JSON.parse(feature.stdout)).toEqual({ valid: true, errors: [] });
    expect(JSON.parse(allOutput)).toEqual({
      valid: false,
      errors: [
        'Navigation index is stale: unclassified module file src/workflow/unclassified.ts',
        'Navigation index is stale: added symbol src/workflow/unclassified.ts#newEntry'
      ]
    });
  });

  it('rejects an unknown feature instead of treating an empty selection as valid', async () => {
    const project = await projectWithNavigation();

    let output = '';
    try {
      await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--feature', 'unknown-feature']);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') output = error.stdout;
    }

    expect(JSON.parse(output)).toEqual({ valid: false, errors: ['Unknown navigation feature: unknown-feature'] });
  });

  it('rejects aliases registered by more than one feature', async () => {
    const project = await projectWithNavigation();
    const indexPath = join(project, '.ai-workflow/index/navigation.json');
    const index = JSON.parse(await (await import('node:fs/promises')).readFile(indexPath, 'utf8')) as NavigationIndex;
    index.features.push({
      ...index.features[0]!,
      id: 'workflow-copy',
      name: 'workflow copy',
      aliases: ['frozen-plan'],
      entries: ['src/workflow/copy.ts'],
      symbols: [{ file: 'src/workflow/copy.ts', name: 'copyPlan', kind: 'function', visibility: 'public' }],
      read_scope: ['src/workflow/copy.ts', 'tests/unit/navigation-validate-cli.test.ts'],
      task_ids: ['task-002-copy'],
      requirement_ids: ['REQ-002'],
      acceptance_criteria_ids: ['AC-002']
    });
    await writeFile(join(project, 'src/workflow/copy.ts'), 'export function copyPlan(): void {}\n');
    await writeFile(indexPath, `${JSON.stringify(index)}\n`);
    await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));

    let output = '';
    try {
      await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') output = error.stdout;
    }

    expect(JSON.parse(output)).toEqual({ valid: false, errors: ['Duplicate feature alias: frozen-plan'] });
  });
});

describe('generated project validation (Step 5 fixtures)', () => {
  it('validates an empty initialized project as all-valid', async () => {
    const project = await temporary('ai-workflow-navigation-empty-');
    await initializeProject(project);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);

    expect(JSON.parse(stdout)).toEqual({ valid: true, errors: [] });
  });

  it('validates a TypeScript project whose test file lives inside the module root', async () => {
    const project = await temporary('ai-workflow-navigation-ts-');
    await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(join(project, 'src/a.ts'), 'export function alpha(): void {}\n');
    await writeFile(join(project, 'src/b.ts'), "import { alpha } from './a.js';\nexport function beta(): void { alpha(); }\n");
    await writeFile(join(project, 'src/a.test.ts'), 'import { beta } from "./b.js";\n');
    await initializeProject(project);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);

    expect(JSON.parse(stdout)).toEqual({ valid: true, errors: [] });
  });

  it('validates a JavaScript project through the TypeScript compiler capability', async () => {
    const project = await temporary('ai-workflow-navigation-js-');
    await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(join(project, 'src/index.js'), 'export function start(): void {}\n');
    await writeFile(join(project, 'src/util.js'), 'function helper(): void {}\n');
    await initializeProject(project);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);

    expect(JSON.parse(stdout)).toEqual({ valid: true, errors: [] });
  });

  it('validates a Maven Java project and reports an added structural file as stale', async () => {
    const project = await temporary('ai-workflow-navigation-maven-');
    await mkdir(join(project, 'src/main/java/com/example/app'), { recursive: true });
    await writeFile(join(project, 'pom.xml'), '<project></project>\n');
    await writeFile(join(project, 'src/main/java/com/example/app/Application.java'), 'package com.example.app;\n\n@SpringBootApplication\npublic class Application {}\n');
    await initializeProject(project);

    const first = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);
    expect(JSON.parse(first.stdout)).toEqual({ valid: true, errors: [] });

    await writeFile(join(project, 'src/main/java/com/example/app/Extra.java'), 'package com.example.app;\n\npublic class Extra {}\n');
    let drifted = '';
    try {
      await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') drifted = error.stdout;
    }

    expect(JSON.parse(drifted)).toEqual({
      valid: false,
      errors: ['Navigation index is stale: unclassified module file src/main/java/com/example/app/Extra.java']
    });
  });

  it.each([
    ['Groovy', 'build.gradle', 'plugins { id "java" }\n'],
    ['Kotlin', 'build.gradle.kts', 'plugins { id("java") }\n']
  ])('validates a Gradle %s Java project as all-valid', async (_label, buildFile, buildContents) => {
    const project = await temporary('ai-workflow-navigation-gradle-');
    await mkdir(join(project, 'src/main/java/com/example/app'), { recursive: true });
    await writeFile(join(project, buildFile), buildContents);
    await writeFile(join(project, 'src/main/java/com/example/app/App.java'), 'package com.example.app;\n\n@SpringBootApplication\npublic class App {}\n');
    await initializeProject(project);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);

    expect(JSON.parse(stdout)).toEqual({ valid: true, errors: [] });
  });

  it('validates a mixed frontend/backend project as all-valid', async () => {
    const project = await temporary('ai-workflow-navigation-mixed-');
    await mkdir(join(project, 'frontend/src'), { recursive: true });
    await mkdir(join(project, 'backend/src/main/java/com/example'), { recursive: true });
    await writeFile(join(project, 'frontend/src/app.ts'), 'export function render(): void {}\n');
    await writeFile(join(project, 'backend/pom.xml'), '<project></project>\n');
    await writeFile(join(project, 'backend/src/main/java/com/example/BackendApp.java'), 'package com.example;\n\n@SpringBootApplication\npublic class BackendApp {}\n');
    await initializeProject(project);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);

    expect(JSON.parse(stdout)).toEqual({ valid: true, errors: [] });
  });
});
