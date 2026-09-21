import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeProject } from '../../src/install/index.js';
import { validateContext } from '../../src/context/validate.js';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

// A mutable hook lets individual cases inject an ordinary filesystem failure for a chosen
// managed path while every other call keeps the real atomic-write behavior.
const fsControl = vi.hoisted(() => ({ failPath: null as string | null }));

vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/fs.js')>();
  const fails = (path: string): boolean => fsControl.failPath !== null && path.endsWith(fsControl.failPath);
  return {
    ...actual,
    atomicWrite: async (path: string, contents: string | Buffer): Promise<void> => {
      if (fails(path)) throw new Error(`injected write failure: ${path}`);
      await actual.atomicWrite(path, contents);
    }
  };
});

const navigationJson = '.ai-workflow/index/navigation.json';
const navigationMarkdown = '.ai-workflow/index/navigation.md';
const projectManifest = '.ai-workflow/project-manifest.json';
const projectConfig = '.ai-workflow/project.yml';
const managedTargets = ['MEMORY.md', navigationJson, navigationMarkdown];

function readText(root: string, relative: string): Promise<string> {
  return readFile(join(root, relative), 'utf8');
}

afterEach(() => {
  fsControl.failPath = null;
});

describe('generated project initialization', () => {
  it('builds navigation from TypeScript facts', async () => {
    const root = await temporary();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export function a(): void {}\n');
    await writeFile(join(root, 'src/b.ts'), 'const b = 1;\n');

    const created = await initializeProject(root);

    expect(created).toContain(navigationJson);
    expect(created).toContain(navigationMarkdown);

    const jsonBytes = await readText(root, navigationJson);
    const index = JSON.parse(jsonBytes) as NavigationIndex;
    expect(index.version).toBe(1);
    expect(index.module_roots.length).toBeGreaterThan(0);
    expect(index.features.some((feature) => feature.entries.includes('src/a.ts'))).toBe(true);
    expect(jsonBytes).toBe(`${JSON.stringify(index, null, 2)}\n`);
    expect(await readText(root, navigationMarkdown)).toBe(renderNavigation(index));

    expect(await exists(join(root, 'MEMORY.md'))).toBe(true);
    const ignoreLines = (await readText(root, '.gitignore')).split(/\r?\n/).map((line) => line.trim());
    expect(ignoreLines).toContain('.ai-workflow/plans/');
    expect(ignoreLines).toContain('.worktrees/');
    expect(ignoreLines).not.toContain('MEMORY.md');
  });

  it('initializes an empty project with an empty index and matching markdown', async () => {
    const root = await temporary();

    await initializeProject(root);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    expect(index).toEqual({ version: 1, module_roots: [], features: [] });
    expect(await readText(root, navigationMarkdown)).toBe(renderNavigation(index));
  });

  it('covers every discovered Java source and test with generated features', async () => {
    const root = await temporary();
    await mkdir(join(root, 'src/main/java/example'), { recursive: true });
    await mkdir(join(root, 'src/test/java/example'), { recursive: true });
    await writeFile(join(root, 'pom.xml'), '<project></project>\n');
    await writeFile(join(root, 'src/main/java/example/App.java'), 'package example;\n\n@SpringBootApplication\npublic class App {}\n');
    await writeFile(join(root, 'src/main/java/example/Helper.java'), 'package example;\n\npublic class Helper {}\n');
    await writeFile(join(root, 'src/test/java/example/AppTest.java'), 'package example;\n\npublic class AppTest {}\n');

    await initializeProject(root);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    expect(index.module_roots.some((moduleRoot) => moduleRoot.language === 'java')).toBe(true);
    const covered = new Set(index.features.flatMap((feature) => [
      ...feature.entries,
      ...feature.related_files,
      ...feature.tests,
    ]));
    expect(covered).toContain('src/main/java/example/App.java');
    expect(covered).toContain('src/main/java/example/Helper.java');
    expect(covered).toContain('src/test/java/example/AppTest.java');
    expect(index.features.some((feature) => feature.entries.includes('src/main/java/example/App.java'))).toBe(true);
  });

  it('rejects malformed project.yml before writing anything', async () => {
    const root = await temporary();
    await mkdir(join(root, '.ai-workflow'), { recursive: true });
    const configBytes = 'version: 1\nmodules: [1, 2\n';
    await writeFile(join(root, projectConfig), configBytes);

    await expect(initializeProject(root)).rejects.toThrow();

    expect(await readText(root, projectConfig)).toBe(configBytes);
    for (const target of managedTargets) {
      expect(await exists(join(root, target))).toBe(false);
    }
    expect(await exists(join(root, projectManifest))).toBe(false);
    expect(await exists(join(root, '.gitignore'))).toBe(false);
  });

  it('keeps a pre-existing project.yml as valid non-conflicting configuration', async () => {
    const root = await temporary();
    await mkdir(join(root, '.ai-workflow'), { recursive: true });
    const configBytes = 'version: 1\nmodules: []\nfeatures: []\n';
    await writeFile(join(root, projectConfig), configBytes);

    await initializeProject(root);

    expect(await readText(root, projectConfig)).toBe(configBytes);
    expect(await exists(join(root, projectManifest))).toBe(false);
  });

  it('rejects an existing managed target before writing', async () => {
    const root = await temporary();
    const memoryBytes = '# existing memory\n';
    await writeFile(join(root, 'MEMORY.md'), memoryBytes);

    await expect(initializeProject(root)).rejects.toThrow(/no files written/);

    expect(await readText(root, 'MEMORY.md')).toBe(memoryBytes);
    expect(await exists(join(root, 'AGENTS.md'))).toBe(false);
    expect(await exists(join(root, 'CLAUDE.md'))).toBe(false);
    expect(await exists(join(root, navigationJson))).toBe(false);
    expect(await exists(join(root, navigationMarkdown))).toBe(false);
    expect(await exists(join(root, '.gitignore'))).toBe(false);
  });
});

describe('publication rollback', () => {
  it('removes created files and restores .gitignore when a late write fails', async () => {
    const root = await temporary();
    const ignoreBytes = 'node_modules/\n';
    await writeFile(join(root, '.gitignore'), ignoreBytes);
    fsControl.failPath = '.gitignore';

    await expect(initializeProject(root)).rejects.toThrow(/injected write failure/);

    for (const target of managedTargets) {
      expect(await exists(join(root, target))).toBe(false);
    }
    expect(await exists(join(root, 'AGENTS.md'))).toBe(false);
    expect(await exists(join(root, 'CLAUDE.md'))).toBe(false);
    expect(await exists(join(root, projectManifest))).toBe(false);
    expect(await readText(root, '.gitignore')).toBe(ignoreBytes);
  });

  it('removes only invocation-created files when an earlier navigation write fails', async () => {
    const root = await temporary();
    const ignoreBytes = 'dist/\n';
    const unrelated = 'keep me\n';
    await writeFile(join(root, '.gitignore'), ignoreBytes);
    await writeFile(join(root, 'notes.txt'), unrelated);
    fsControl.failPath = navigationJson;

    await expect(initializeProject(root)).rejects.toThrow(/injected write failure/);

    for (const target of managedTargets) {
      expect(await exists(join(root, target))).toBe(false);
    }
    expect(await readText(root, '.gitignore')).toBe(ignoreBytes);
    expect(await readText(root, 'notes.txt')).toBe(unrelated);
  });
});

describe('Step 5 end-to-end discovery fixtures', () => {
  it('initializes a TypeScript semantic project with entry, symbol, relation and exact test coverage', async () => {
    const root = await temporary();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export function alpha(): void {}\n');
    await writeFile(join(root, 'src/b.ts'), "import { alpha } from './a.js';\nexport function beta(): void { alpha(); }\n");
    await writeFile(join(root, 'src/a.test.ts'), 'import { beta } from "./b.js";\n');

    const created = await initializeProject(root);

    expect(created).toContain(navigationJson);
    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    const feature = index.features.find((entry) => entry.entries.includes('src/a.ts'));
    expect(feature).toBeDefined();
    expect(feature!.entries).toEqual(['src/a.ts', 'src/b.ts']);
    expect(feature!.related_files).toEqual([]);
    expect(feature!.tests).toEqual(['src/a.test.ts']);
    expect(feature!.symbols.map((symbol) => `${symbol.file}#${symbol.name}`)).toEqual(['src/a.ts#alpha', 'src/b.ts#beta']);
    expect(feature!.relations).toEqual([{ kind: 'imports', from: 'src/b.ts#beta', to: 'src/a.ts#alpha' }]);
  });

  it('initializes a JavaScript project through the TypeScript compiler capability', async () => {
    const root = await temporary();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.js'), 'export function start(): void {}\n');
    await writeFile(join(root, 'src/util.js'), 'function helper(): void {}\n');

    const created = await initializeProject(root);

    expect(created).toContain(navigationJson);
    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    const feature = index.features.find((entry) => entry.entries.includes('src/index.js'));
    expect(feature).toBeDefined();
    expect(feature!.entries).toEqual(['src/index.js']);
    expect(feature!.related_files).toEqual(['src/util.js']);
    expect(feature!.symbols).toEqual([{ file: 'src/index.js', name: 'start', kind: 'function', visibility: 'public' }]);
  });

  it('indexes Maven src/test/java tests as feature tests with annotated entries', async () => {
    const root = await temporary();
    await mkdir(join(root, 'src/main/java/com/example/app'), { recursive: true });
    await mkdir(join(root, 'src/test/java/com/example/app'), { recursive: true });
    await writeFile(join(root, 'pom.xml'), '<project></project>\n');
    await writeFile(join(root, 'src/main/java/com/example/app/Application.java'), 'package com.example.app;\n\n@SpringBootApplication\npublic class Application {}\n');
    await writeFile(join(root, 'src/main/java/com/example/app/UserService.java'), 'package com.example.app;\n\n@Service\npublic class UserService {}\n');
    await writeFile(join(root, 'src/main/java/com/example/app/Plain.java'), 'package com.example.app;\n\npublic class Plain {}\n');
    await writeFile(join(root, 'src/test/java/com/example/app/ApplicationTest.java'), 'package com.example.app;\n\npublic class ApplicationTest {}\n');

    await initializeProject(root);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    const javaRoot = index.module_roots.find((moduleRoot) => moduleRoot.language === 'java');
    expect(javaRoot).toBeDefined();
    expect(javaRoot!.entry_kinds).toContain('file');
    const feature = index.features.find((entry) => entry.id === 'com.example.app');
    expect(feature).toBeDefined();
    expect(feature!.entries).toEqual([
      'src/main/java/com/example/app/Application.java',
      'src/main/java/com/example/app/UserService.java'
    ]);
    expect(feature!.related_files).toEqual(['src/main/java/com/example/app/Plain.java']);
    expect(feature!.tests).toEqual(['src/test/java/com/example/app/ApplicationTest.java']);
  });

  it.each([
    ['Groovy', 'build.gradle', 'plugins { id "java" }\n'],
    ['Kotlin', 'build.gradle.kts', 'plugins { id("java") }\n']
  ])('detects Gradle %s Java projects with a package feature', async (_label, buildFile, buildContents) => {
    const root = await temporary();
    await mkdir(join(root, 'src/main/java/com/example/app'), { recursive: true });
    await writeFile(join(root, buildFile), buildContents);
    await writeFile(join(root, 'src/main/java/com/example/app/App.java'), 'package com.example.app;\n\n@SpringBootApplication\npublic class App {}\n');

    await initializeProject(root);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    const javaRoot = index.module_roots.find((moduleRoot) => moduleRoot.language === 'java');
    expect(javaRoot).toBeDefined();
    expect(javaRoot!.language).toBe('java');
    expect(index.features.some((feature) => feature.id === 'com.example.app' && feature.entries.includes('src/main/java/com/example/app/App.java'))).toBe(true);
  });

  it('initializes mixed frontend and backend repositories with separate roots', async () => {
    const root = await temporary();
    await mkdir(join(root, 'frontend/src'), { recursive: true });
    await mkdir(join(root, 'backend/src/main/java/com/example'), { recursive: true });
    await writeFile(join(root, 'frontend/src/app.ts'), 'export function render(): void {}\n');
    await writeFile(join(root, 'backend/pom.xml'), '<project></project>\n');
    await writeFile(join(root, 'backend/src/main/java/com/example/BackendApp.java'), 'package com.example;\n\n@SpringBootApplication\npublic class BackendApp {}\n');

    await initializeProject(root);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    expect(index.module_roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'frontend', path: 'frontend', language: 'typescript', entry_kinds: ['exported-symbol'] }),
      expect.objectContaining({ id: 'backend', path: 'backend', language: 'java', entry_kinds: ['file'] })
    ]));
    expect(index.features.some((feature) => feature.id === 'frontend' && feature.entries.includes('frontend/src/app.ts'))).toBe(true);
    expect(index.features.some((feature) => feature.id === 'com.example' && feature.entries.includes('backend/src/main/java/com/example/BackendApp.java'))).toBe(true);
  });
});

describe('review repair regressions', () => {
  it('supplements a configured module with uncovered files without failing validation', async () => {
    const root = await temporary();
    await mkdir(join(root, 'app/src'), { recursive: true });
    await mkdir(join(root, 'app/scripts'), { recursive: true });
    await mkdir(join(root, '.ai-workflow'), { recursive: true });
    await writeFile(join(root, 'app/src/index.ts'), 'export function index(): void {}\n');
    await writeFile(join(root, 'app/scripts/tool.ts'), 'export function tool(): void {}\n');
    await writeFile(join(root, projectConfig), `version: 1
modules:
  - id: app
    path: app
    languages: [typescript]
    source_roots: [src]
    test_roots: []
features: []
`);

    await initializeProject(root);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    const covered = new Set(index.features.flatMap((feature) => [...feature.entries, ...feature.related_files]));
    expect(covered).toContain('app/scripts/tool.ts');
    const validation = await validateContext(root);
    expect(validation).toEqual({ valid: true, errors: [] });
  });

  it('initializes and validates a root-level unknown-language configured module', async () => {
    const root = await temporary();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.ai-workflow'), { recursive: true });
    await writeFile(join(root, 'src/main.rs'), 'fn main() {}\n');
    await writeFile(join(root, projectConfig), `version: 1
modules:
  - id: rust
    path: .
    languages: [rust]
    source_roots: [.]
    test_roots: []
features: []
`);

    await initializeProject(root);

    const validation = await validateContext(root);
    expect(validation).toEqual({ valid: true, errors: [] });
  });

  it('indexes TypeScript files in a root module shared with a Maven project', async () => {
    const root = await temporary();
    await mkdir(join(root, 'src/main/java/com/example'), { recursive: true });
    await writeFile(join(root, 'pom.xml'), '<project></project>\n');
    await writeFile(join(root, 'src/main/java/com/example/App.java'), 'package com.example;\n\n@SpringBootApplication\npublic class App {}\n');
    await writeFile(join(root, 'root.ts'), 'export function helper(): void {}\n');
    await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');

    await initializeProject(root);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    const covered = new Set(index.features.flatMap((feature) => [...feature.entries, ...feature.related_files]));
    expect(covered).toContain('root.ts');
    const validation = await validateContext(root);
    expect(validation).toEqual({ valid: true, errors: [] });
  });
});

describe('navigation protection', () => {
  it('never writes AGENTS.md, CLAUDE.md or a project manifest', async () => {
    const root = await temporary();

    const created = await initializeProject(root);

    expect(created).not.toContain('AGENTS.md');
    expect(created).not.toContain('CLAUDE.md');
    expect(await exists(join(root, 'AGENTS.md'))).toBe(false);
    expect(await exists(join(root, 'CLAUDE.md'))).toBe(false);
    expect(await exists(join(root, projectManifest))).toBe(false);
    expect(await exists(join(root, navigationJson))).toBe(true);
    expect(await exists(join(root, navigationMarkdown))).toBe(true);
  });

  it('refuses to overwrite existing navigation and MEMORY.md on re-init and leaves bytes unchanged', async () => {
    const root = await temporary();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export function a(): void {}\n');
    await initializeProject(root);
    const jsonBytes = await readText(root, navigationJson);
    const markdownBytes = await readText(root, navigationMarkdown);
    const memoryBytes = await readText(root, 'MEMORY.md');

    await expect(initializeProject(root)).rejects.toThrow(/no files written/);

    expect(await readText(root, navigationJson)).toBe(jsonBytes);
    expect(await readText(root, navigationMarkdown)).toBe(markdownBytes);
    expect(await readText(root, 'MEMORY.md')).toBe(memoryBytes);
    expect(await exists(join(root, projectManifest))).toBe(false);
  });
});

describe('Maven aggregator multi-module discovery', () => {
  it('initializes a Maven aggregator where each module owns its sources and no root feature exists', async () => {
    const root = await temporary();
    await mkdir(join(root, 'module-a/src/main/java/com/example/a'), { recursive: true });
    await mkdir(join(root, 'module-b/src/main/java/com/example/b'), { recursive: true });
    await writeFile(join(root, 'pom.xml'), '<project><modules><module>module-a</module><module>module-b</module></modules></project>\n');
    await writeFile(join(root, 'module-a/pom.xml'), '<project></project>\n');
    await writeFile(join(root, 'module-b/pom.xml'), '<project></project>\n');
    await writeFile(join(root, 'module-a/src/main/java/com/example/a/AService.java'), 'package com.example.a;\n\n@Service\npublic class AService {}\n');
    await writeFile(join(root, 'module-b/src/main/java/com/example/b/BService.java'), 'package com.example.b;\n\n@Service\npublic class BService {}\n');

    await initializeProject(root);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    for (const moduleRoot of index.module_roots) {
      expect(index.features.some((feature) => feature.module_root === moduleRoot.id)).toBe(true);
    }
    const ownerOf = (path: string): string | undefined =>
      index.features.find((feature) =>
        [...feature.entries, ...feature.related_files, ...feature.tests].includes(path)
      )?.module_root;
    expect(ownerOf('module-a/src/main/java/com/example/a/AService.java')).toBe('module-a');
    expect(ownerOf('module-b/src/main/java/com/example/b/BService.java')).toBe('module-b');
    expect(index.features.some((feature) => feature.module_root === 'root')).toBe(false);

    expect(await validateContext(root)).toEqual({ valid: true, errors: [] });
  });

  it('keeps a parent module with its own sources from owning nested module sources', async () => {
    const root = await temporary();
    await mkdir(join(root, 'src/main/java/com/example/root'), { recursive: true });
    await mkdir(join(root, 'child/src/main/java/com/example/child'), { recursive: true });
    await writeFile(join(root, 'pom.xml'), '<project></project>\n');
    await writeFile(join(root, 'child/pom.xml'), '<project></project>\n');
    await writeFile(join(root, 'src/main/java/com/example/root/RootApp.java'), 'package com.example.root;\n\n@SpringBootApplication\npublic class RootApp {}\n');
    await writeFile(join(root, 'child/src/main/java/com/example/child/ChildService.java'), 'package com.example.child;\n\n@Service\npublic class ChildService {}\n');

    await initializeProject(root);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    const rootFeature = index.features.find((feature) => feature.entries.includes('src/main/java/com/example/root/RootApp.java'));
    const childFeature = index.features.find((feature) => feature.entries.includes('child/src/main/java/com/example/child/ChildService.java'));
    expect(rootFeature?.module_root).toBe('root');
    expect(childFeature?.module_root).toBe('child');
    expect(rootFeature?.entries).not.toContain('child/src/main/java/com/example/child/ChildService.java');
    expect(rootFeature?.read_scope).not.toContain('child/src/main/java/com/example/child/ChildService.java');

    expect(await validateContext(root)).toEqual({ valid: true, errors: [] });
  });
});
