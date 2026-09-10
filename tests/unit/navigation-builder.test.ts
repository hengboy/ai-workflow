import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { scanProject } from '../../src/context/discovery/scanner.js';
import type { DiscoveryFacts } from '../../src/context/discovery/scanner.js';
import type { ProjectConfig } from '../../src/context/discovery/project-config.js';
import {
  buildNavigation,
  canonicalizeNavigation,
  renderNavigationJson
} from '../../src/context/discovery/builder.js';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { formatSchemaErrors, schemaValidator } from '../../src/utils/schema.js';
import { temporary } from '../helpers.js';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSortedUnique(values: string[]): void {
  expect(values).toEqual([...new Set(values)].sort(compareStrings));
}

async function writeFixture(root: string, relativePath: string, contents: string): Promise<void> {
  const absolute = join(root, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

interface Fixture {
  root: string;
  facts: DiscoveryFacts;
}

async function fixture(files: Record<string, string>): Promise<Fixture> {
  const root = await temporary('ai-workflow-builder-');
  for (const [path, contents] of Object.entries(files)) await writeFixture(root, path, contents);
  return { root, facts: await scanProject(root) };
}

const CANONICAL_FILES: Record<string, string> = {
  'root.ts': 'export function rootFn(): void {}\n',
  'app/main.ts': 'export function appMain(): void {}\n',
  'src/zeta.ts': 'export function zeta(): void {}\n',
  'src/alpha.ts': 'export function alpha(): void {}\n',
  'src/beta.ts': 'export function beta(): void {}\n',
  'src/consumer.ts':
    "import { alpha } from './alpha.js';\nimport { beta } from './beta.js';\nexport function use(): void { alpha(); beta(); }\n",
  'src/alpha.test.ts': "import { alpha } from './alpha.js';\ntest('alpha', () => { alpha(); });\n"
};

const BACKEND_JAVA_CONFIG: ProjectConfig = {
  version: 1,
  modules: [
    {
      id: 'backend',
      path: 'backend',
      languages: ['java'],
      sourceRoots: ['src/main/java'],
      testRoots: ['src/test/java']
    }
  ],
  features: []
};

const BACKEND_JAVA_FILES: Record<string, string> = {
  'backend/src/main/java/com/example/users/UsersController.java':
    'package com.example.users;\n\n@RestController\npublic class UsersController {}\n',
  'backend/src/main/java/com/example/users/UsersService.java':
    'package com.example.users;\n\n@Service\npublic class UsersService {}\n',
  'backend/src/main/java/com/example/orders/OrderController.java':
    'package com.example.orders;\n\n@RestController\npublic class OrderController {}\n',
  'backend/src/main/java/com/example/orders/Order.java': 'package com.example.orders;\n\npublic class Order {}\n',
  'backend/src/test/java/com/example/users/UsersControllerTest.java':
    'package com.example.users;\n\nclass UsersControllerTest {}\n'
};

const COVERAGE_JAVA_FILES: Record<string, string> = {
  'backend/src/main/java/com/example/orders/OrderController.java':
    'package com.example.orders;\n\n@RestController\npublic class OrderController {}\n',
  'backend/src/main/java/com/example/orders/OrderService.java':
    'package com.example.orders;\n\n@Service\npublic class OrderService {}\n',
  'backend/src/main/java/com/example/orders/Order.java': 'package com.example.orders;\n\npublic class Order {}\n',
  'backend/src/main/java/com/example/plain/Alpha.java': 'package com.example.plain;\n\npublic class Alpha {}\n',
  'backend/src/main/java/com/example/plain/Beta.java': 'package com.example.plain;\n\npublic class Beta {}\n',
  'backend/src/test/java/com/example/orders/OrderControllerTest.java':
    'package com.example.orders;\n\nclass OrderControllerTest {}\n',
  'backend/src/test/java/com/example/plain/AlphaTest.java': 'package com.example.plain;\n\nclass AlphaTest {}\n'
};

describe('buildNavigation canonical output (AC-009)', () => {
  it('is byte-for-byte deterministic under shuffled and duplicated facts.files order', async () => {
    const { root, facts } = await fixture(CANONICAL_FILES);

    const forward = await buildNavigation(root, { files: [...facts.files] });
    const reversed = await buildNavigation(root, { files: [...facts.files].reverse() });
    const duplicated = await buildNavigation(root, { files: [...facts.files, ...facts.files] });

    expect(renderNavigationJson(reversed.index)).toBe(renderNavigationJson(forward.index));
    expect(renderNavigationJson(duplicated.index)).toBe(renderNavigationJson(forward.index));
  });

  it('serializes canonicalizeNavigation with two-space indentation and a final newline', async () => {
    const { root, facts } = await fixture(CANONICAL_FILES);

    const result = await buildNavigation(root, facts);

    expect(renderNavigationJson(result.index)).toBe(
      `${JSON.stringify(canonicalizeNavigation(result.index), null, 2)}\n`
    );
  });

  it('orders module roots, features, path arrays, symbols and relations canonically', async () => {
    const { root, facts } = await fixture(CANONICAL_FILES);

    const { index } = await buildNavigation(root, facts);

    const rootIds = index.module_roots.map((entry) => entry.id);
    expect(rootIds).toEqual([...rootIds].sort(compareStrings));
    const featureIds = index.features.map((entry) => entry.id);
    expect(featureIds).toEqual([...featureIds].sort(compareStrings));

    for (const feature of index.features) {
      assertSortedUnique(feature.entries);
      assertSortedUnique(feature.related_files);
      assertSortedUnique(feature.tests);
      assertSortedUnique(feature.read_scope);

      const symbolKeys = feature.symbols.map(
        (symbol) => `${symbol.file}\u0000${symbol.name}\u0000${symbol.kind}\u0000${symbol.visibility}`
      );
      expect(symbolKeys).toEqual([...symbolKeys].sort(compareStrings));

      const relationKeys = feature.relations.map(
        (relation) => `${relation.kind}\u0000${relation.from}\u0000${relation.to}`
      );
      expect(relationKeys).toEqual([...relationKeys].sort(compareStrings));
    }
  });

  it('renders Markdown purely from the canonical JSON object', async () => {
    const { root, facts } = await fixture(CANONICAL_FILES);

    const { index } = await buildNavigation(root, facts);
    const parsed = JSON.parse(renderNavigationJson(index)) as NavigationIndex;

    expect(renderNavigation(parsed)).toBe(renderNavigation(canonicalizeNavigation(index)));
  });

  it('canonicalizes diagnostics by path, code and message', async () => {
    const { root, facts } = await fixture({
      'backend/src/main/java/com/example/zeta/Z.java':
        'package com.example.zeta;\n\n/* unterminated\npublic class Z {}\n',
      'backend/src/main/java/com/example/alpha/A.java':
        'package com.example.alpha;\n\n/* unterminated\npublic class A {}\n'
    });

    const { diagnostics } = await buildNavigation(root, { files: [...facts.files].reverse() }, BACKEND_JAVA_CONFIG);

    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    const keys = diagnostics.map((entry) => `${entry.path}\u0000${entry.code}\u0000${entry.message}`);
    expect(keys).toEqual([...keys].sort(compareStrings));
  });
});

describe('buildNavigation empty project (AC-002)', () => {
  it('returns an empty version-1 index and no diagnostics without configuration', async () => {
    const root = await temporary('ai-workflow-builder-empty-');

    const result = await buildNavigation(root, { files: [] });

    expect(result).toEqual({ index: { version: 1, module_roots: [], features: [] }, diagnostics: [] });
  });
});

describe('buildNavigation TypeScript auto-discovery (AC-003)', () => {
  it('discovers one TypeScript root with entries, related files, tests and public symbols', async () => {
    const { root, facts } = await fixture({
      'src/a.ts': 'export function a(): void {}\n',
      'src/b.ts': 'const b = 1;\n',
      'src/a.test.ts': "import { a } from './a.js';\ntest('a', () => { a(); });\n"
    });

    const { index, diagnostics } = await buildNavigation(root, facts);

    expect(index.module_roots).toHaveLength(1);
    const moduleRoot = index.module_roots[0];
    expect(moduleRoot).toBeDefined();
    expect(moduleRoot).toMatchObject({ id: 'src', path: 'src', language: 'typescript', entry_kinds: ['exported-symbol'] });

    expect(index.features).toHaveLength(1);
    const feature = index.features[0];
    expect(feature).toBeDefined();
    expect(feature?.module_root).toBe(moduleRoot?.id);
    expect(feature?.module_root).toBe('src');
    expect(feature?.entries).toEqual(['src/a.ts']);
    expect(feature?.related_files).toEqual(['src/b.ts']);
    expect(feature?.tests).toEqual(['src/a.test.ts']);
    expect(feature?.symbols).toContainEqual({ file: 'src/a.ts', name: 'a', kind: 'function', visibility: 'public' });
    expect(feature?.relations).toEqual([]);
    expect(feature?.read_scope).toEqual(['src/a.test.ts', 'src/a.ts', 'src/b.ts']);
    expect(diagnostics).toEqual([]);
  });
});

describe('buildNavigation configured modules (AC-012)', () => {
  it('maps a configured single-language module to one file-capability root and covers all Java sources', async () => {
    const { root, facts } = await fixture(BACKEND_JAVA_FILES);

    const { index } = await buildNavigation(root, facts, BACKEND_JAVA_CONFIG);

    const moduleRoot = index.module_roots.find((entry) => entry.id === 'backend');
    expect(moduleRoot).toMatchObject({ id: 'backend', path: 'backend', language: 'java', entry_kinds: ['file'] });

    const sourcePaths = facts.files
      .filter((file) => file.language === 'java' && file.path.startsWith('backend/src/main/java/'))
      .map((file) => file.path);
    const covered = new Set(index.features.flatMap((feature) => [...feature.entries, ...feature.related_files]));
    for (const path of sourcePaths) expect(covered.has(path)).toBe(true);

    expect(index.features.length).toBeGreaterThan(0);
    for (const feature of index.features) expect(feature.module_root).toBe('backend');
  });

  it('binds an explicit feature to concrete source and test files with an exact read scope', async () => {
    const config: ProjectConfig = {
      version: 1,
      modules: BACKEND_JAVA_CONFIG.modules,
      features: [
        {
          id: 'users',
          name: 'Users',
          moduleRoot: 'backend',
          paths: ['backend/src/main/java/com/example/users', 'backend/src/test/java/com/example/users']
        }
      ]
    };
    const { root, facts } = await fixture(BACKEND_JAVA_FILES);

    const { index } = await buildNavigation(root, facts, config);

    const feature = index.features.find((entry) => entry.id === 'users');
    expect(feature).toBeDefined();
    expect(feature?.module_root).toBe('backend');
    expect(feature?.entries).toEqual([
      'backend/src/main/java/com/example/users/UsersController.java',
      'backend/src/main/java/com/example/users/UsersService.java'
    ]);
    expect(feature?.tests).toEqual(['backend/src/test/java/com/example/users/UsersControllerTest.java']);
    expect(feature?.read_scope).toEqual([
      'backend/src/main/java/com/example/users/UsersController.java',
      'backend/src/main/java/com/example/users/UsersService.java',
      'backend/src/test/java/com/example/users/UsersControllerTest.java'
    ]);

    const owned = [
      'backend/src/main/java/com/example/users/UsersController.java',
      'backend/src/main/java/com/example/users/UsersService.java',
      'backend/src/test/java/com/example/users/UsersControllerTest.java'
    ];
    const others = index.features.filter((entry) => entry.id !== 'users');
    for (const path of owned) {
      expect(
        others.some(
          (entry) =>
            entry.entries.includes(path) || entry.related_files.includes(path) || entry.tests.includes(path)
        )
      ).toBe(false);
    }
  });

  it('marks a multi-language configured module as mixed with both structural and semantic capabilities', async () => {
    const config: ProjectConfig = {
      version: 1,
      modules: [
        {
          id: 'app',
          path: 'app',
          languages: ['java', 'typescript'],
          sourceRoots: ['src/main/java', 'src'],
          testRoots: []
        }
      ],
      features: []
    };
    const { root, facts } = await fixture({
      'app/src/main/java/com/example/App.java':
        'package com.example;\n\n@SpringBootApplication\npublic class App {}\n',
      'app/src/a.ts': 'export function a(): void {}\n'
    });

    const { index } = await buildNavigation(root, facts, config);

    const moduleRoot = index.module_roots.find((entry) => entry.id === 'app');
    expect(moduleRoot).toMatchObject({ id: 'app', path: 'app', language: 'mixed' });
    expect(moduleRoot?.entry_kinds).toEqual(expect.arrayContaining(['file', 'exported-symbol']));
    expect(index.features.length).toBeGreaterThan(0);
    for (const feature of index.features) expect(feature.module_root).toBe('app');
  });

  it('reserves explicit feature ids and suffixes colliding discovered ids deterministically', async () => {
    const config: ProjectConfig = {
      version: 1,
      modules: BACKEND_JAVA_CONFIG.modules,
      features: [
        {
          id: 'com.example.users',
          name: 'Users explicit',
          moduleRoot: 'backend',
          paths: ['backend/src/main/java/com/example/accounts']
        }
      ]
    };
    const { root, facts } = await fixture({
      'backend/src/main/java/com/example/users/UsersController.java':
        'package com.example.users;\n\n@RestController\npublic class UsersController {}\n',
      'backend/src/main/java/com/example/accounts/AccountsController.java':
        'package com.example.accounts;\n\n@RestController\npublic class AccountsController {}\n'
    });

    const { index } = await buildNavigation(root, facts, config);

    const ids = index.features.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    const explicit = index.features.find((entry) => entry.id === 'com.example.users');
    expect(explicit).toBeDefined();
    expect(explicit?.module_root).toBe('backend');
    expect(explicit?.entries).toEqual(['backend/src/main/java/com/example/accounts/AccountsController.java']);
    expect(index.features.some((entry) => entry.id === 'com.example.users-2')).toBe(true);
  });

  it('covers every configured-module Java source and test exactly once', async () => {
    const { root, facts } = await fixture(COVERAGE_JAVA_FILES);

    const { index } = await buildNavigation(root, facts, BACKEND_JAVA_CONFIG);

    const sourcePaths = facts.files
      .filter((file) => file.language === 'java' && file.path.startsWith('backend/src/main/java/'))
      .map((file) => file.path);
    const testPaths = facts.files
      .filter((file) => file.language === 'java' && file.path.startsWith('backend/src/test/java/'))
      .map((file) => file.path);
    expect(sourcePaths.length).toBeGreaterThan(0);
    expect(testPaths.length).toBeGreaterThan(0);

    const sourceCounts = new Map(sourcePaths.map((path) => [path, 0]));
    for (const feature of index.features) {
      for (const path of [...feature.entries, ...feature.related_files]) {
        if (sourceCounts.has(path)) sourceCounts.set(path, (sourceCounts.get(path) ?? 0) + 1);
      }
    }
    for (const path of sourcePaths) expect(sourceCounts.get(path)).toBe(1);

    const testCounts = new Map(testPaths.map((path) => [path, 0]));
    for (const feature of index.features) {
      for (const path of feature.tests) {
        if (testCounts.has(path)) testCounts.set(path, (testCounts.get(path) ?? 0) + 1);
      }
    }
    for (const path of testPaths) expect(testCounts.get(path)).toBe(1);
  });
});

describe('buildNavigation export-less projects (schema validity)', () => {
  it.each([
    {
      name: 'plain source with only a default export',
      files: { 'src/plain.ts': 'const value = 1;\nexport default value;\n' },
      covered: ['src/plain.ts']
    },
    {
      name: 'root config exporting nothing named',
      files: { 'vitest.config.ts': 'export default {};\n' },
      covered: ['vitest.config.ts']
    }
  ])('keeps every feature non-empty and schema-valid: $name', async ({ files, covered }) => {
    const validate = await schemaValidator('navigation.schema.json');
    const { root, facts } = await fixture(files);
    const { index } = await buildNavigation(root, facts);

    const valid = validate(index);
    expect(formatSchemaErrors(validate.errors)).toBe('');
    expect(valid).toBe(true);

    for (const feature of index.features) {
      expect(feature.entries.length, `feature ${feature.id}`).toBeGreaterThanOrEqual(1);
    }

    const coveredPaths = new Set(index.features.flatMap((feature) => [...feature.entries, ...feature.related_files]));
    for (const path of covered) {
      expect(coveredPaths.has(path), path).toBe(true);
    }
  });
});
