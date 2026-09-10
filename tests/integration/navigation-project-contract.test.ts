import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { locateContext } from '../../src/context/locate.js';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { createNavigationCandidate } from '../../src/context/validate.js';
import { initializeProject, updateProject } from '../../src/install/index.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

const navigation: NavigationIndex = {
  version: 1,
  module_roots: [{
    id: 'project-source',
    path: '.',
    owner_role: 'frontend',
    responsibility: 'shared application entry points',
    language: 'mixed',
    entry_kinds: ['component', 'utility', 'test']
  }],
  features: [{
    id: 'shared-feature',
    name: 'Shared Feature',
    aliases: ['shared feature'],
    module_root: 'project-source',
    entries: ['src/App.tsx', 'src/components/', 'src/components/SharedPanel.tsx', 'src/lib/navigation.ts'],
    symbols: [{ file: 'src/components/SharedPanel.tsx', name: 'SharedPanel', kind: 'component', visibility: 'public' }],
    related_files: ['src/lib/navigation.ts'],
    tests: ['src/App.sharedFeature.test.tsx'],
    depends_on: [],
    relations: [],
    owner_role: 'frontend',
    responsibility: 'shared navigation and catalog',
    read_scope: ['src/App.tsx', 'src/components', 'src/lib/navigation.ts', 'src/App.sharedFeature.test.tsx'],
    shared_entry: true
  }]
};

async function projectWithNavigation(): Promise<string> {
  const project = await temporary('ai-workflow-navigation-project-');
  await mkdir(join(project, 'src/components'), { recursive: true });
  await mkdir(join(project, 'src/lib'), { recursive: true });
  await writeFile(join(project, 'src/App.tsx'), 'export function App(): void {}\n');
  await writeFile(join(project, 'src/components/SharedPanel.tsx'), 'export function SharedPanel(): void {}\n');
  await writeFile(join(project, 'src/lib/navigation.ts'), 'export function navigate(): void {}\n');
  await writeFile(join(project, 'src/App.sharedFeature.test.tsx'), '');
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(navigation)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(navigation));
  return project;
}

describe('project navigation contract', () => {
  it('locates a shared mixed-language feature with stable read order', async () => {
    const project = await projectWithNavigation();

    await expect(locateContext(project, { feature: 'shared-feature', verify: true })).resolves.toMatchObject({
      status: 'hit',
      resolution_mode: 'index',
      feature: 'shared-feature',
      read_order: ['src/App.tsx', 'src/components/', 'src/components/SharedPanel.tsx', 'src/lib/navigation.ts', 'src/App.sharedFeature.test.tsx'],
      fallback_required: false
    });
  });

  it('generates one versioned candidate without collapsing shared module-root features', async () => {
    const project = await projectWithNavigation();
    const candidatePath = join(project, '.ai-workflow/candidate.json');
    const secondFeature = structuredClone(navigation.features[0]!);
    secondFeature.id = 'another-feature';
    secondFeature.name = 'Another Feature';
    secondFeature.entries = ['src/lib/navigation.ts'];
    secondFeature.symbols = [];
    secondFeature.related_files = [];
    secondFeature.tests = [];
    secondFeature.read_scope = ['src/lib/navigation.ts'];
    const indexPath = join(project, '.ai-workflow/index/navigation.json');
    const sharedIndex = { ...navigation, module_roots: [{ ...navigation.module_roots[0]!, path: '.', language: 'typescript' }], features: [...navigation.features, secondFeature] };
    await writeFile(indexPath, `${JSON.stringify(sharedIndex)}\n`);

    await createNavigationCandidate(project, 'shared-feature', ['.'], ['src/components/SharedPanel.tsx'], candidatePath);

    const candidate = JSON.parse(await readFile(candidatePath, 'utf8')) as { version: number; navigation: NavigationIndex };
    expect(candidate.version).toBe(1);
    expect(candidate.navigation.version).toBe(1);
    expect(candidate.navigation.features.map((feature) => feature.id)).toEqual(['shared-feature', 'another-feature']);
  });

  it('keeps explicit module and feature bindings exact while discovering uncovered territory', async () => {
    const project = await temporary('ai-workflow-navigation-config-');
    await mkdir(join(project, '.ai-workflow'), { recursive: true });
    await mkdir(join(project, 'backend/src/main/java/com/example/users'), { recursive: true });
    await mkdir(join(project, 'backend/src/main/java/com/example/admin'), { recursive: true });
    await mkdir(join(project, 'backend/src/it/java/com/example/it'), { recursive: true });
    await mkdir(join(project, 'frontend/src'), { recursive: true });
    await writeFile(join(project, 'backend/src/main/java/com/example/users/UsersService.java'), 'package com.example.users;\n\n@Service\npublic class UsersService {}\n');
    await writeFile(join(project, 'backend/src/main/java/com/example/admin/AdminController.java'), 'package com.example.admin;\n\npublic class AdminController {}\n');
    await writeFile(join(project, 'backend/src/it/java/com/example/it/ItCheck.java'), 'package com.example.it;\n\npublic class ItCheck {}\n');
    await writeFile(join(project, 'frontend/src/app.ts'), 'export function render(): void {}\n');
    const configPath = join(project, '.ai-workflow/project.yml');
    const configBytes = [
      'version: 1',
      'modules:',
      '  - id: backend',
      '    path: backend',
      '    languages: [java]',
      '    source_roots: [src/main/java, src/it/java]',
      '    test_roots: []',
      'features:',
      '  - id: users',
      '    name: Users',
      '    module_root: backend',
      '    paths: [backend/src/main/java/com/example/users]',
      ''
    ].join('\n');
    await writeFile(configPath, configBytes);

    await initializeProject(project);

    const index = JSON.parse(await readFile(join(project, '.ai-workflow/index/navigation.json'), 'utf8')) as NavigationIndex;
    const backend = index.module_roots.find((root) => root.id === 'backend');
    expect(backend).toMatchObject({ id: 'backend', path: 'backend', language: 'java', entry_kinds: ['file'] });
    const users = index.features.find((feature) => feature.id === 'users');
    expect(users).toMatchObject({ module_root: 'backend', entries: ['backend/src/main/java/com/example/users/UsersService.java'] });
    expect(index.features.some((feature) => feature.id === 'com.example.admin')).toBe(true);
    expect(index.features.some((feature) => feature.id === 'com.example.it')).toBe(true);
    expect(index.features.some((feature) => feature.id === 'frontend' && feature.entries.includes('frontend/src/app.ts'))).toBe(true);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'validate', '--project', project, '--all']);
    expect(JSON.parse(stdout)).toEqual({ valid: true, errors: [] });

    const report = await updateProject(project);
    expect(report.skipped).toEqual(['.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md']);
    expect(await readFile(configPath, 'utf8')).toBe(configBytes);
  });
});
