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
import { renderNavigation, type NavigationFeature, type NavigationIndex } from '../../src/context/navigation.js';
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

// AC-006 compares the compact catalog against the pre-implementation full-table
// rendering of one controlled long-array fixture. The fixture shape below is
// reproduced from the captured baseline; the baseline UTF-8 size is the scalar
// carried forward from that capture.
const CAPTURED_CONTROLLED_TABLE_UTF8_BYTES = 40_934;

interface ControlledCounts { entries: number; symbols: number; related: number; tests: number }

function controlledFeature(id: string, responsibility: string, counts: ControlledCounts): NavigationFeature {
  return {
    id,
    name: id,
    aliases: [],
    module_root: 'src',
    entries: Array.from({ length: counts.entries }, (_, index) => `src/mod${index}/file${index}.ts`),
    symbols: Array.from({ length: counts.symbols }, (_, index) => ({
      file: `src/mod${index % 10}/file${index}.ts`,
      name: `symbol${index}`,
      kind: 'function',
      visibility: 'public' as const
    })),
    related_files: Array.from({ length: counts.related }, (_, index) => `docs/rel${index}.md`),
    tests: Array.from({ length: counts.tests }, (_, index) => `tests/behavior/t${index}.test.ts`),
    depends_on: [],
    relations: [],
    owner_role: 'shared',
    responsibility,
    read_scope: Array.from({ length: counts.entries }, (_, index) => `src/scope${index}.ts`),
    shared_entry: false
  };
}

function controlledIndex(): NavigationIndex {
  return {
    version: 1,
    module_roots: [{ id: 'src', path: 'src', owner_role: 'shared', responsibility: 'module', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [
      controlledFeature('alpha', 'Handles alpha | beta with a newline\nand a pipe', { entries: 50, symbols: 120, related: 40, tests: 25 }),
      controlledFeature('beta', 'Beta responsibility summary', { entries: 100, symbols: 240, related: 80, tests: 50 }),
      controlledFeature('gamma', 'Gamma responsibility summary', { entries: 150, symbols: 360, related: 120, tests: 75 })
    ]
  };
}

function catalogFeature(id: string, responsibility: string, entries: string[] = ['src/alpha/one.ts']): NavigationFeature {
  return {
    id, name: id, aliases: [], module_root: 'src', entries,
    symbols: [], related_files: [], tests: [], depends_on: [], relations: [],
    owner_role: 'shared', responsibility, read_scope: entries, shared_entry: false
  };
}

function catalogIndex(feature: NavigationFeature): NavigationIndex {
  return {
    version: 1,
    module_roots: [{ id: 'src', path: 'src', owner_role: 'shared', responsibility: 'source', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [feature]
  };
}

function unescapedPipes(row: string): number {
  let count = 0;
  for (let index = 0; index < row.length; index += 1) if (row[index] === '|' && row[index - 1] !== '\\') count += 1;
  return count;
}

describe('compact navigation catalog (AC-006)', () => {
  it('keeps the controlled long-array catalog at most 40% of the captured legacy table bytes', () => {
    const index = controlledIndex();
    // Confirm the reconstruction matches the captured fixture shape before applying its baseline.
    expect(index.features.map((feature) => feature.entries.length)).toEqual([50, 100, 150]);
    expect(index.features.map((feature) => feature.symbols.length)).toEqual([120, 240, 360]);
    expect(index.features.map((feature) => feature.related_files.length)).toEqual([40, 80, 120]);
    expect(index.features.map((feature) => feature.tests.length)).toEqual([25, 50, 75]);
    expect(index.features.map((feature) => feature.read_scope.length)).toEqual([50, 100, 150]);

    const bytes = Buffer.byteLength(renderNavigation(index), 'utf8');

    expect(bytes).toBeLessThanOrEqual(Math.floor(CAPTURED_CONTROLLED_TABLE_UTF8_BYTES * 0.4));
  });

  it('renders feature id, owner, one existing entry and the locate command without expanding arrays', () => {
    const index: NavigationIndex = {
      version: 1,
      module_roots: [{ id: 'src', path: 'src', owner_role: 'shared', responsibility: 'source', language: 'typescript', entry_kinds: ['exported-symbol'] }],
      features: [{
        id: 'alpha', name: 'alpha feature', aliases: [], module_root: 'src',
        entries: ['src/alpha/one.ts', 'src/alpha/two.ts'],
        symbols: [{ file: 'src/alpha/one.ts', name: 'symbolOne', kind: 'function', visibility: 'public' }],
        related_files: ['src/alpha/helper.ts'], tests: ['tests/unit/alpha.test.ts'], depends_on: [], relations: [],
        owner_role: 'shared', responsibility: 'alpha summary',
        read_scope: ['src/alpha/helper.ts', 'src/alpha/one.ts', 'src/alpha/two.ts', 'tests/unit/alpha.test.ts'], shared_entry: false
      }]
    };

    const output = renderNavigation(index);

    expect(output).toContain('alpha');
    expect(output).toContain('shared');
    const shownEntries = index.features[0]!.entries.filter((entry) => output.includes(entry));
    expect(shownEntries).toHaveLength(1);
    expect(output).toContain('locate');
    expect(output).toMatch(/--feature\s+alpha/);
    expect(output).not.toContain('symbolOne');
    expect(output).not.toContain('src/alpha/helper.ts');
    expect(output).not.toContain('tests/unit/alpha.test.ts');
  });

  it('escapes supported pipe and newline prose so every catalog row keeps its columns', () => {
    const output = renderNavigation(catalogIndex(catalogFeature('alpha', 'Handles alpha | beta with a newline\nand a pipe')));

    const rows = output.split('\n').filter((line) => line.startsWith('|'));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const columnCounts = rows.map(unescapedPipes);
    expect(new Set(columnCounts).size).toBe(1);
    expect(output).toContain('\\|');
    expect(output).not.toContain('newline\nand a pipe');
  });

  it('truncates a responsibility summary to at most 120 code points', () => {
    const output = renderNavigation(catalogIndex(catalogFeature('long', 'Ω'.repeat(200))));

    expect(output).toContain('Ω');
    expect(output.split('Ω').length - 1).toBeLessThanOrEqual(120);
  });

  it('counts the responsibility summary by code point so a 120 code point non-BMP tail is retained', () => {
    const summary = `${'😀'.repeat(119)}X`;
    expect(Array.from(summary)).toHaveLength(120);

    const output = renderNavigation(catalogIndex(catalogFeature('wide', summary)));

    expect(output).toContain(summary);
  });

  it('does not invent an entry for an empty index or an entry-less feature', () => {
    const empty = renderNavigation({ version: 1, module_roots: [], features: [] });
    expect(empty).not.toMatch(/\.ts/);

    const entryless = renderNavigation(catalogIndex(catalogFeature('entryless', 'entryless summary', [])));
    expect(entryless).toContain('entryless');
    expect(entryless).not.toMatch(/\.ts/);
  });
});
