import { describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadProjectConfig } from '../../src/context/discovery/project-config.js';
import type { DiscoveredFile } from '../../src/context/discovery/scanner.js';
import { temporary } from '../helpers.js';

const PROJECT_CONFIG_PATH = '.ai-workflow/project.yml';

const VALID_CONFIG = `version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    source_roots: [src/main/java]
    test_roots: [src/test/java]
features:
  - id: users
    name: Users
    module_root: backend
    paths:
      - backend/src/main/java/example/users
      - backend/src/test/java/example/users
`;

const MODULES_ONLY_CONFIG = `version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    source_roots: [src/main/java]
    test_roots: []
`;

async function projectWithConfig(yaml: string): Promise<string> {
  const root = await temporary('ai-workflow-config-');
  await mkdir(join(root, '.ai-workflow'), { recursive: true });
  await writeFile(join(root, PROJECT_CONFIG_PATH), yaml);
  return root;
}

async function backendTree(root: string): Promise<void> {
  await mkdir(join(root, 'backend/src/main/java/example/users'), { recursive: true });
  await mkdir(join(root, 'backend/src/test/java/example/users'), { recursive: true });
  await writeFile(join(root, 'backend/src/main/java/example/users/UsersController.java'), 'package example.users;\n');
  await writeFile(join(root, 'backend/src/test/java/example/users/UsersControllerTest.java'), 'package example.users;\n');
}

describe('loadProjectConfig', () => {
  it('reports absent configuration without errors or declarations', async () => {
    const root = await temporary('ai-workflow-config-absent-');

    const result = await loadProjectConfig(root);

    expect(result.present).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.config.version).toBe(1);
    expect(result.config.modules).toEqual([]);
    expect(result.config.features).toEqual([]);
  });

  it('loads a valid version-1 configuration with camelCase mapping', async () => {
    const root = await projectWithConfig(VALID_CONFIG);
    await backendTree(root);

    const result = await loadProjectConfig(root);

    expect(result.present).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.config.version).toBe(1);
    expect(result.config.modules).toHaveLength(1);
    expect(result.config.modules[0]).toMatchObject({
      id: 'backend',
      path: 'backend',
      languages: ['java'],
      sourceRoots: ['src/main/java'],
      testRoots: ['src/test/java']
    });
    expect(result.config.features).toHaveLength(1);
    expect(result.config.features[0]).toMatchObject({
      id: 'users',
      name: 'Users',
      moduleRoot: 'backend',
      paths: ['backend/src/main/java/example/users', 'backend/src/test/java/example/users']
    });
  });

  it('accepts a partial configuration with modules and no features', async () => {
    const root = await projectWithConfig(MODULES_ONLY_CONFIG);
    await mkdir(join(root, 'backend/src/main/java'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.present).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.config.features).toEqual([]);
    expect(result.config.modules).toHaveLength(1);
    expect(result.config.modules[0]?.testRoots).toEqual([]);
  });

  it('reports malformed YAML while remaining present', async () => {
    const root = await projectWithConfig('version: 1\nmodules: [\n');

    const result = await loadProjectConfig(root);

    expect(result.present).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects an unsupported configuration version', async () => {
    const root = await projectWithConfig(VALID_CONFIG.replace('version: 1', 'version: 2'));
    await backendTree(root);

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => /version/i.test(error) || error.includes('2'))).toBe(true);
  });

  it('rejects unknown extra properties', async () => {
    const root = await projectWithConfig(`${VALID_CONFIG}unexpected: true\n`);
    await backendTree(root);

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a module missing languages', async () => {
    const root = await projectWithConfig(`version: 1
modules:
  - id: backend
    path: backend
    source_roots: [src/main/java]
    test_roots: []
features: []
`);
    await mkdir(join(root, 'backend/src/main/java'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => /language/i.test(error))).toBe(true);
  });

  it('rejects a module missing source roots', async () => {
    const root = await projectWithConfig(`version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    test_roots: []
features: []
`);
    await mkdir(join(root, 'backend'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => /source/i.test(error))).toBe(true);
  });

  it('reports a duplicate module id', async () => {
    const root = await projectWithConfig(`version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    source_roots: [src/main/java]
    test_roots: []
  - id: backend
    path: frontend
    languages: [typescript]
    source_roots: [src]
    test_roots: []
features: []
`);
    await mkdir(join(root, 'backend/src/main/java'), { recursive: true });
    await mkdir(join(root, 'frontend/src'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.errors.some((error) => /duplicate/i.test(error) && error.includes('backend'))).toBe(true);
  });

  it('reports a duplicate feature id', async () => {
    const root = await projectWithConfig(`version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    source_roots: [src/main/java]
    test_roots: []
features:
  - id: users
    name: Users
    module_root: backend
    paths: [backend/src/main/java/example/users]
  - id: users
    name: Users copy
    module_root: backend
    paths: [backend/src/main/java/example/accounts]
`);
    await mkdir(join(root, 'backend/src/main/java/example/users'), { recursive: true });
    await mkdir(join(root, 'backend/src/main/java/example/accounts'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.errors.some((error) => /duplicate/i.test(error) && error.includes('users'))).toBe(true);
  });

  it('reports a feature referencing an unknown module', async () => {
    const root = await projectWithConfig(`version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    source_roots: [src/main/java]
    test_roots: []
features:
  - id: users
    name: Users
    module_root: ghost
    paths: [backend/src/main/java/example/users]
`);
    await mkdir(join(root, 'backend/src/main/java/example/users'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes('ghost'))).toBe(true);
  });

  it('reports a nonexistent module path', async () => {
    const root = await projectWithConfig(`version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    source_roots: [src/main/java]
    test_roots: []
features: []
`);

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes('backend'))).toBe(true);
  });

  it('reports a nonexistent module source root', async () => {
    const root = await projectWithConfig(MODULES_ONLY_CONFIG);
    await mkdir(join(root, 'backend'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes('src/main/java'))).toBe(true);
  });

  it('reports a nonexistent module test root', async () => {
    const root = await projectWithConfig(VALID_CONFIG);
    await mkdir(join(root, 'backend/src/main/java/example/users'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes('src/test/java'))).toBe(true);
  });

  it('reports a nonexistent feature path', async () => {
    const root = await projectWithConfig(VALID_CONFIG);
    await mkdir(join(root, 'backend/src/main/java'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes('backend/src/main/java/example/users'))).toBe(true);
  });

  it('reports a declared path that escapes the project', async () => {
    const root = await projectWithConfig(`version: 1
modules:
  - id: escape
    path: ../outside
    languages: [java]
    source_roots: [src]
    test_roots: []
features: []
`);

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes('..') || error.includes('outside'))).toBe(true);
  });

  it('reports overlapping module boundaries', async () => {
    const root = await projectWithConfig(`version: 1
modules:
  - id: core
    path: backend
    languages: [java]
    source_roots: [src]
    test_roots: []
  - id: api
    path: backend/api
    languages: [java]
    source_roots: [src]
    test_roots: []
features: []
`);
    await mkdir(join(root, 'backend/src'), { recursive: true });
    await mkdir(join(root, 'backend/api/src'), { recursive: true });

    const result = await loadProjectConfig(root);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes('api') || error.includes('core') || error.includes('backend/api'))).toBe(true);
  });

  it('never modifies configuration bytes or creates files under .ai-workflow', async () => {
    const root = await projectWithConfig(VALID_CONFIG);
    await backendTree(root);
    const configPath = join(root, PROJECT_CONFIG_PATH);
    const directory = join(root, '.ai-workflow');

    const before = await readFile(configPath, 'utf8');
    const entriesBefore = (await readdir(directory)).sort();

    await loadProjectConfig(root);

    const after = await readFile(configPath, 'utf8');
    const entriesAfter = (await readdir(directory)).sort();

    expect(after).toBe(before);
    expect(entriesAfter).toEqual(entriesBefore);
    expect(entriesAfter).toEqual(['project.yml']);
  });

  it('reports duplicate feature file ownership across overlapping feature directories', async () => {
    const root = await projectWithConfig(`version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    source_roots: [src/main/java]
    test_roots: []
features:
  - id: users
    name: Users
    module_root: backend
    paths: [backend/src/main/java/example/users]
  - id: accounts
    name: Accounts
    module_root: backend
    paths: [backend/src/main/java/example]
`);
    const owned = 'backend/src/main/java/example/users/User.java';
    await mkdir(dirname(join(root, owned)), { recursive: true });
    await writeFile(join(root, owned), 'package example.users;\n');
    const files: DiscoveredFile[] = [{ path: owned, language: 'java' }];

    const result = await loadProjectConfig(root, files);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes(owned) || /duplicate|ownership/i.test(error))).toBe(true);
  });
});
