import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { locateContext } from '../../src/context/locate.js';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { temporary } from '../helpers.js';

const navigation: NavigationIndex = {
  version: 1,
  module_roots: [{
    id: 'project-source',
    path: '.',
    owner_role: 'shared',
    responsibility: 'shared application entry points',
    language: 'mixed',
    entry_kinds: ['component', 'utility', 'test']
  }],
  features: [{
    id: 'shared-feature',
    name: 'Shared Feature',
    aliases: ['shared feature'],
    module_root: 'project-source',
    entries: ['src/App.tsx', 'src/components/MoreToolsHub.tsx', 'src/lib/navigation.ts'],
    symbols: [{ file: 'src/components/MoreToolsHub.tsx', name: 'MoreToolsHub', kind: 'component', visibility: 'public' }],
    related_files: ['src/lib/navigation.ts'],
    tests: ['src/App.moreToolsNavigation.test.tsx'],
    depends_on: [],
    relations: [],
    owner_role: 'frontend',
    responsibility: 'More Tools navigation and catalog',
    read_scope: ['src/App.tsx', 'src/components/MoreToolsHub.tsx', 'src/lib/navigation.ts', 'src/App.moreToolsNavigation.test.tsx'],
    shared_entry: true
  }]
};

async function projectWithNavigation(): Promise<string> {
  const project = await temporary('ai-workflow-navigation-project-');
  await mkdir(join(project, 'src/components'), { recursive: true });
  await mkdir(join(project, 'src/lib'), { recursive: true });
  await writeFile(join(project, 'src/App.tsx'), 'export function App(): void {}\n');
  await writeFile(join(project, 'src/components/MoreToolsHub.tsx'), 'export function MoreToolsHub(): void {}\n');
  await writeFile(join(project, 'src/lib/navigation.ts'), 'export function navigate(): void {}\n');
  await writeFile(join(project, 'src/App.moreToolsNavigation.test.tsx'), '');
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
      read_order: ['src/App.tsx', 'src/components/MoreToolsHub.tsx', 'src/lib/navigation.ts', 'src/App.moreToolsNavigation.test.tsx'],
      fallback_required: false
    });
  });
});
