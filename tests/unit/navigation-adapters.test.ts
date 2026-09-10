import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { scanProject } from '../../src/context/discovery/scanner.js';
import { loadProjectConfig } from '../../src/context/discovery/project-config.js';
import type { CandidateModuleRoot, DiscoveryFacts } from '../../src/context/discovery/types.js';
import {
  analyzerForLanguage,
  analyzeModule,
  detectModules,
  type ModuleAnalysisRequest
} from '../../src/context/discovery/adapters.js';
import { analyzeTypeScriptModule, detectTypeScriptModules } from '../../src/context/discovery/typescript.js';
import { analyzeJavaModule, detectJavaModules } from '../../src/context/discovery/java.js';
import { temporary } from '../helpers.js';

async function writeFixture(root: string, relativePath: string, contents: string): Promise<void> {
  const absolute = join(root, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function makeModuleRoot(id: string, path: string, language: string, entryKinds: string[]): CandidateModuleRoot {
  return { id, path, ownerRole: 'shared', responsibility: `discovered ${language} module`, language, entryKinds };
}

function requestFor(
  root: string,
  facts: DiscoveryFacts,
  moduleRoot: CandidateModuleRoot,
  sourceRoots: string[],
  testRoots: string[]
): ModuleAnalysisRequest {
  return { root, facts, moduleRoot, sourceRoots, testRoots };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSorted<T>(values: T[], key: (value: T) => string): void {
  const keys = values.map(key);
  expect(keys).toEqual([...keys].sort(compareStrings));
}

function symbolKey(symbol: { file: string; name: string; kind: string }): string {
  return `${symbol.file}\u0000${symbol.name}\u0000${symbol.kind}`;
}

interface JavaFixture {
  root: string;
  facts: DiscoveryFacts;
  moduleRoot: CandidateModuleRoot;
  request: ModuleAnalysisRequest;
}

async function javaFixture(files: Record<string, string>, buildFile: string): Promise<JavaFixture> {
  const root = await temporary('ai-workflow-adapters-java-');
  await writeFixture(root, buildFile, '');
  for (const [path, contents] of Object.entries(files)) await writeFixture(root, path, contents);
  const facts = await scanProject(root);
  const moduleRoot = detectJavaModules(facts).find((entry) => entry.path === '.');
  if (!moduleRoot) throw new Error(`expected a Java module root at the project root for ${buildFile}`);
  return {
    root,
    facts,
    moduleRoot,
    request: requestFor(root, facts, moduleRoot, ['src/main/java'], ['src/test/java'])
  };
}

const TS_SOURCE_A = 'export function alpha(): number { return 1; }\n';
const TS_SOURCE_B = 'const beta = 1;\n';
const TS_TEST_FILE = "import { alpha } from './a.js';\n\ntest('alpha', () => { expect(alpha()).toBe(1); });\n";
const JS_LEGACY = "export function legacy(): string { return 'legacy'; }\n";

const TS_KINDS = `export function fn(): void {}
export class Klass {}
export interface Iface {}
export enum En { A }
export type Alias = string;
export const value = 1;
export const arrow = () => 1;
export const fnExpr = function () { return 1; };
`;

const TS_RELATION_A = 'export function alpha(): number { return 1; }\n';
const TS_RELATION_CONSUMER = "import { alpha } from './a.js';\n\nexport function use(): number { return alpha() + alpha(); }\n";
const TS_RELATION_OTHER = "import { alpha } from './a.js';\n\nexport function use(): number { return alpha(); }\n";
const TS_RELATION_GHOST = "import { missing } from './missing.js';\n\nexport function useMissing(): number { return missing(); }\n";

const BOOT_APPLICATION = `package com.example.app;

@SpringBootApplication
public class Application {
  public static void main(String[] args) {
  }
}
`;

const BOOT_ADMIN = `package com.example.app;

@SpringBootApplication
public class AdminApplication {
}
`;

const DEFAULT_PACKAGE_FILE = `public class DefaultPackageThing {
}
`;

const BROKEN_PATH = 'src/main/java/com/example/broken/Broken.java';
const BROKEN_JAVA = `package com.example.broken;

/* this block comment never terminates
public class Broken {
}
`;

const WEB_FILES: Record<string, string> = {
  'src/main/java/com/example/web/WebController.java': `package com.example.web;

@RestController
public class WebController {
}
`,
  'src/main/java/com/example/web/UserService.java': `package com.example.web;

@Service
public class UserService {
}
`,
  'src/main/java/com/example/web/UserRepo.java': `package com.example.web;

@Repository
public class UserRepo {
}
`,
  'src/main/java/com/example/web/AppConfig.java': `package com.example.web;

@Configuration
public class AppConfig {
}
`,
  'src/main/java/com/example/web/HomeController.java': `package com.example.web;

@Controller
public class HomeController {
}
`,
  'src/main/java/com/example/web/Plain.java': `package com.example.web;

public class Plain {
}
`,
  'src/main/java/com/example/web/Decoy.java': `package com.example.web;

// @Service
public class Decoy {
  private String value = "@Controller";
}
`,
  'src/main/java/com/example/web/NotAnnotated.java': `package com.example.web;

@ServiceX
public class NotAnnotated {
}
`,
  'src/main/java/com/example/plain/Alpha.java': `package com.example.plain;

public class Alpha {
}
`,
  'src/main/java/com/example/plain/Beta.java': `package com.example.plain;

public class Beta {
}
`
};

const COVERAGE_FILES: Record<string, string> = {
  'src/main/java/com/example/orders/OrderController.java': `package com.example.orders;

@RestController
public class OrderController {
}
`,
  'src/main/java/com/example/orders/OrderService.java': `package com.example.orders;

@Service
public class OrderService {
}
`,
  'src/main/java/com/example/orders/Order.java': `package com.example.orders;

public class Order {
}
`,
  'src/main/java/com/example/plain/Alpha.java': `package com.example.plain;

public class Alpha {
}
`,
  'src/test/java/com/example/orders/OrderControllerTest.java': `package com.example.orders;

class OrderControllerTest {
}
`,
  'src/test/java/com/example/plain/AlphaTest.java': `package com.example.plain;

class AlphaTest {
}
`
};

describe('analyzerForLanguage and analyzeModule', () => {
  it('selects analyzers for java and TS/JS and rejects unsupported languages', () => {
    expect(typeof analyzerForLanguage('java')).toBe('function');
    expect(typeof analyzerForLanguage('typescript')).toBe('function');
    expect(typeof analyzerForLanguage('javascript')).toBe('function');
    expect(analyzerForLanguage('rust')).toBeUndefined();
  });

  it('dispatches to the language analyzer and falls back to structural files for unknown languages', async () => {
    const root = await temporary('ai-workflow-adapters-dispatch-');
    await writeFixture(root, 'src/a.ts', TS_SOURCE_A);
    await writeFixture(root, 'src/lib.rs', 'fn main() {}\n');
    await writeFixture(root, 'tests/lib_test.rs', '#[test]\nfn it_works() {}\n');
    const facts = await scanProject(root);

    const tsRoot = makeModuleRoot('src', 'src', 'typescript', ['exported-symbol']);
    const tsResult = await analyzeModule(requestFor(root, facts, tsRoot, ['src'], ['tests']));
    expect(tsResult.candidates.some((candidate) => candidate.entries.includes('src/a.ts'))).toBe(true);

    const rustRoot = makeModuleRoot('rust-module', '.', 'rust', ['file']);
    const rustResult = await analyzeModule(requestFor(root, facts, rustRoot, ['src'], ['tests']));
    expect(rustResult.candidates).toHaveLength(1);
    const rustCandidate = rustResult.candidates[0];
    expect(rustCandidate).toBeDefined();
    expect(rustCandidate?.moduleRoot).toBe('rust-module');
    expect(rustCandidate?.entries).toEqual(['src/a.ts', 'src/lib.rs']);
    expect(rustCandidate?.tests).toEqual(['tests/lib_test.rs']);
    expect(rustCandidate?.symbols).toEqual([]);
    expect(rustCandidate?.relations).toEqual([]);
  });
});

describe('detectTypeScriptModules', () => {
  it('groups TS/JS files by top-level directory with the project root as "."', async () => {
    const root = await temporary('ai-workflow-adapters-ts-detect-');
    await writeFixture(root, 'src/a.ts', TS_SOURCE_A);
    await writeFixture(root, 'src/nested/b.ts', TS_SOURCE_B);
    await writeFixture(root, 'app/main.js', JS_LEGACY);
    await writeFixture(root, 'root.ts', TS_SOURCE_A);
    const facts = await scanProject(root);

    const roots = detectTypeScriptModules(facts);
    const byPath = new Map(roots.map((entry) => [entry.path, entry]));

    expect([...byPath.keys()].sort(compareStrings)).toEqual(['.', 'app', 'src']);
    expect(byPath.get('src')).toMatchObject({
      id: 'src',
      path: 'src',
      language: 'typescript',
      entryKinds: ['exported-symbol'],
      ownerRole: 'shared'
    });
    expect(byPath.get('app')).toMatchObject({
      id: 'app',
      path: 'app',
      language: 'typescript',
      entryKinds: ['exported-symbol'],
      ownerRole: 'shared'
    });

    const rootGroup = byPath.get('.');
    expect(rootGroup).toBeDefined();
    expect(['.', 'root']).toContain(rootGroup?.id);
    expect(rootGroup?.language).toBe('typescript');
    expect(rootGroup?.entryKinds).toEqual(['exported-symbol']);
    expect(rootGroup?.ownerRole).toBe('shared');
  });
});

describe('analyzeTypeScriptModule', () => {
  it('classifies source, related files, tests and public symbols for TS and JS', async () => {
    const root = await temporary('ai-workflow-adapters-ts-');
    await writeFixture(root, 'src/a.ts', TS_SOURCE_A);
    await writeFixture(root, 'src/b.ts', TS_SOURCE_B);
    await writeFixture(root, 'src/a.test.ts', TS_TEST_FILE);
    await writeFixture(root, 'src/legacy.js', JS_LEGACY);
    const facts = await scanProject(root);
    const moduleRoot = makeModuleRoot('src', 'src', 'typescript', ['exported-symbol']);

    const result = await analyzeTypeScriptModule(requestFor(root, facts, moduleRoot, ['src'], ['tests']));

    expect(result.moduleRoots).toEqual([moduleRoot]);
    expect(result.diagnostics).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();
    expect(candidate?.moduleRoot).toBe('src');
    expect(candidate?.entries).toEqual(['src/a.ts', 'src/legacy.js']);
    expect(candidate?.relatedFiles).toEqual(['src/b.ts']);
    expect(candidate?.tests).toEqual(['src/a.test.ts']);
    expect(candidate?.symbols).toEqual(
      expect.arrayContaining([
        { file: 'src/a.ts', name: 'alpha', kind: 'function', visibility: 'public' },
        { file: 'src/legacy.js', name: 'legacy', kind: 'function', visibility: 'public' }
      ])
    );
    expect(candidate?.symbols).toHaveLength(2);
    assertSorted(candidate?.symbols ?? [], symbolKey);
  });

  it('supports exported function, class, interface, enum, type and variable declarations', async () => {
    const root = await temporary('ai-workflow-adapters-ts-kinds-');
    await writeFixture(root, 'src/kinds.ts', TS_KINDS);
    const facts = await scanProject(root);
    const moduleRoot = makeModuleRoot('src', 'src', 'typescript', ['exported-symbol']);

    const result = await analyzeTypeScriptModule(requestFor(root, facts, moduleRoot, ['src'], ['tests']));
    const symbols = result.candidates[0]?.symbols ?? [];
    const expected: Record<string, string> = {
      Alias: 'type',
      En: 'enum',
      Iface: 'interface',
      Klass: 'class',
      arrow: 'function',
      fn: 'function',
      fnExpr: 'function',
      value: 'variable'
    };

    expect(symbols).toHaveLength(Object.keys(expected).length);
    for (const [name, kind] of Object.entries(expected)) {
      expect(symbols).toContainEqual({ file: 'src/kinds.ts', name, kind, visibility: 'public' });
    }
    assertSorted(symbols, symbolKey);
  });

  it('reports deduplicated, sorted relative named-import relations between analyzed files', async () => {
    const root = await temporary('ai-workflow-adapters-ts-relations-');
    await writeFixture(root, 'src/a.ts', TS_RELATION_A);
    await writeFixture(root, 'src/consumer.ts', TS_RELATION_CONSUMER);
    await writeFixture(root, 'src/other.ts', TS_RELATION_OTHER);
    await writeFixture(root, 'src/ghost.ts', TS_RELATION_GHOST);
    const facts = await scanProject(root);
    const moduleRoot = makeModuleRoot('src', 'src', 'typescript', ['exported-symbol']);

    const result = await analyzeTypeScriptModule(requestFor(root, facts, moduleRoot, ['src'], ['tests']));
    const candidate = result.candidates[0];

    expect(candidate?.relations).toEqual([
      { kind: 'imports', from: 'src/consumer.ts#use', to: 'src/a.ts#alpha' },
      { kind: 'imports', from: 'src/other.ts#use', to: 'src/a.ts#alpha' }
    ]);
    assertSorted(candidate?.relations ?? [], (relation) => `${relation.kind}\u0000${relation.from}\u0000${relation.to}`);
  });

  it('treats files under testRoots and source files matching test patterns as tests', async () => {
    const root = await temporary('ai-workflow-adapters-ts-tests-');
    await writeFixture(root, 'src/feature.ts', TS_SOURCE_A);
    await writeFixture(root, 'src/mystery.test.ts', TS_SOURCE_A);
    await writeFixture(root, 'src/component.spec.tsx', 'export const Component = () => null;\n');
    await writeFixture(root, 'src/widget.test.mjs', 'export const widget = 1;\n');
    await writeFixture(root, 'tests/feature.test.ts', TS_TEST_FILE);
    await writeFixture(root, 'tests/helpers.ts', TS_SOURCE_A);
    const facts = await scanProject(root);
    const moduleRoot = makeModuleRoot('src', 'src', 'typescript', ['exported-symbol']);

    const result = await analyzeTypeScriptModule(requestFor(root, facts, moduleRoot, ['src'], ['tests']));
    const candidate = result.candidates[0];
    const tests = candidate?.tests ?? [];

    expect(candidate?.entries).toEqual(['src/feature.ts']);
    expect(candidate?.relatedFiles).toEqual([]);
    expect(tests).toHaveLength(5);
    expect(tests).toEqual(
      expect.arrayContaining([
        'src/mystery.test.ts',
        'src/component.spec.tsx',
        'src/widget.test.mjs',
        'tests/feature.test.ts',
        'tests/helpers.ts'
      ])
    );
    assertSorted(tests, (path) => path);
  });

  it('derives source and test roots from project configuration for adapter requests', async () => {
    const root = await temporary('ai-workflow-adapters-config-');
    await writeFixture(
      root,
      '.ai-workflow/project.yml',
      `version: 1
modules:
  - id: app
    path: .
    languages: [typescript]
    source_roots: [src]
    test_roots: [tests]
features: []
`
    );
    await writeFixture(root, 'src/a.ts', TS_SOURCE_A);
    await writeFixture(root, 'tests/a.test.ts', TS_TEST_FILE);
    const facts = await scanProject(root);

    const config = await loadProjectConfig(root);
    expect(config.errors).toEqual([]);
    const declared = config.config.modules[0];
    expect(declared).toBeDefined();
    const moduleRoot = makeModuleRoot(declared?.id ?? '', declared?.path ?? '.', declared?.languages[0] ?? 'typescript', [
      'exported-symbol'
    ]);

    const result = await analyzeTypeScriptModule(
      requestFor(root, facts, moduleRoot, declared?.sourceRoots ?? [], declared?.testRoots ?? [])
    );

    expect(result.candidates[0]?.entries).toEqual(['src/a.ts']);
    expect(result.candidates[0]?.tests).toEqual(['tests/a.test.ts']);
  });
});

describe('detectJavaModules', () => {
  it('creates one Java module root per directory holding a supported build file', async () => {
    const root = await temporary('ai-workflow-adapters-java-detect-');
    await writeFixture(root, 'pom.xml', '');
    await writeFixture(root, 'backend/build.gradle', '');
    await writeFixture(root, 'service/build.gradle.kts', '');
    const facts = await scanProject(root);

    const roots = detectJavaModules(facts);
    const byPath = new Map(roots.map((entry) => [entry.path, entry]));

    expect([...byPath.keys()].sort(compareStrings)).toEqual(['.', 'backend', 'service']);
    expect(byPath.get('.')).toMatchObject({
      id: 'root',
      path: '.',
      language: 'java',
      entryKinds: ['file'],
      ownerRole: 'shared'
    });
    expect(byPath.get('backend')).toMatchObject({
      id: 'backend',
      path: 'backend',
      language: 'java',
      entryKinds: ['file'],
      ownerRole: 'shared'
    });
    expect(byPath.get('service')).toMatchObject({
      id: 'service',
      path: 'service',
      language: 'java',
      entryKinds: ['file'],
      ownerRole: 'shared'
    });
    for (const entry of roots) {
      expect((entry.responsibility ?? '').length).toBeGreaterThan(0);
    }
  });
});

describe('analyzeJavaModule', () => {
  it.each(['pom.xml', 'build.gradle', 'build.gradle.kts'])(
    'detects a Java root and Boot entry for %s projects',
    async (buildFile) => {
      const { request, moduleRoot } = await javaFixture(
        { 'src/main/java/com/example/app/Application.java': BOOT_APPLICATION },
        buildFile
      );

      const result = await analyzeJavaModule(request);
      const candidate = result.candidates.find((entry) => entry.id === 'com.example.app');

      expect(moduleRoot.language).toBe('java');
      expect(candidate).toBeDefined();
      expect(candidate?.name).toBe('com.example.app');
      expect(candidate?.moduleRoot).toBe(moduleRoot.id);
      expect(candidate?.entries).toContain('src/main/java/com/example/app/Application.java');
      expect(candidate?.relatedFiles).toEqual([]);
      expect(candidate?.symbols).toEqual([]);
      expect(candidate?.relations).toEqual([]);
      expect(result.moduleRoots).toEqual([moduleRoot]);
      expect(result.diagnostics).toEqual([]);
    }
  );

  it('retains multiple Boot classes in one package as sorted entries', async () => {
    const { request } = await javaFixture(
      {
        'src/main/java/com/example/app/Application.java': BOOT_APPLICATION,
        'src/main/java/com/example/app/AdminApplication.java': BOOT_ADMIN
      },
      'pom.xml'
    );

    const result = await analyzeJavaModule(request);
    const candidate = result.candidates.find((entry) => entry.id === 'com.example.app');

    expect(candidate?.entries).toEqual([
      'src/main/java/com/example/app/AdminApplication.java',
      'src/main/java/com/example/app/Application.java'
    ]);
    expect(candidate?.relatedFiles).toEqual([]);
  });

  it('classifies annotated Spring classes as entries and ordinary classes as related files', async () => {
    const { request, moduleRoot } = await javaFixture(WEB_FILES, 'pom.xml');

    const result = await analyzeJavaModule(request);
    const web = result.candidates.find((entry) => entry.id === 'com.example.web');
    const prefix = 'src/main/java/com/example/web/';

    expect(web).toBeDefined();
    expect(web?.entries).toEqual([
      `${prefix}AppConfig.java`,
      `${prefix}HomeController.java`,
      `${prefix}UserRepo.java`,
      `${prefix}UserService.java`,
      `${prefix}WebController.java`
    ]);
    expect(web?.relatedFiles).toEqual([
      `${prefix}Decoy.java`,
      `${prefix}NotAnnotated.java`,
      `${prefix}Plain.java`
    ]);
    expect(web?.entries).not.toContain(`${prefix}Decoy.java`);
    expect(web?.entries).not.toContain(`${prefix}NotAnnotated.java`);
    expect(web?.moduleRoot).toBe(moduleRoot.id);
    expect(web?.ownerRole).toBe(moduleRoot.ownerRole);
    expect(web?.responsibility).toBe(moduleRoot.responsibility);
    expect(web?.sharedEntry).toBe(false);

    const plain = result.candidates.find((entry) => entry.id === 'com.example.plain');
    expect(plain?.entries).toEqual([
      'src/main/java/com/example/plain/Alpha.java',
      'src/main/java/com/example/plain/Beta.java'
    ]);
    expect(plain?.relatedFiles).toEqual([]);

    for (const candidate of result.candidates) {
      expect(candidate.symbols).toEqual([]);
      expect(candidate.relations).toEqual([]);
    }
  });

  it('covers every discovered Java source and test exactly once', async () => {
    const { request, facts } = await javaFixture(COVERAGE_FILES, 'pom.xml');

    const result = await analyzeJavaModule(request);
    const sourcePaths = facts.files
      .filter((file) => file.language === 'java' && file.path.startsWith('src/main/java/'))
      .map((file) => file.path);
    const testPaths = facts.files
      .filter((file) => file.language === 'java' && file.path.startsWith('src/test/java/'))
      .map((file) => file.path);

    expect(sourcePaths.length).toBeGreaterThan(0);
    expect(testPaths.length).toBeGreaterThan(0);

    const covered = new Set(result.candidates.flatMap((candidate) => [...candidate.entries, ...candidate.relatedFiles]));
    for (const path of sourcePaths) expect(covered.has(path)).toBe(true);
    for (const path of testPaths) {
      const owners = result.candidates.filter((candidate) => candidate.tests.includes(path));
      expect(owners).toHaveLength(1);
    }
  });

  it('groups files without a package declaration under a default candidate', async () => {
    const { request } = await javaFixture({ 'src/main/java/DefaultPackageThing.java': DEFAULT_PACKAGE_FILE }, 'pom.xml');

    const result = await analyzeJavaModule(request);
    const candidate = result.candidates.find((entry) => entry.id === `${request.moduleRoot.id}-default`);

    expect(candidate).toBeDefined();
    expect(candidate?.entries).toContain('src/main/java/DefaultPackageThing.java');
    expect(candidate?.symbols).toEqual([]);
    expect(candidate?.relations).toEqual([]);
  });

  it('retains an unclassifiable Java file with empty semantics and one diagnostic', async () => {
    const { request } = await javaFixture({ [BROKEN_PATH]: BROKEN_JAVA }, 'pom.xml');

    const result = await analyzeJavaModule(request);
    const retained = result.candidates.some((candidate) => candidate.entries.includes(BROKEN_PATH));
    const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.path === BROKEN_PATH);

    expect(retained).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('java-unclassified');
    expect((diagnostics[0]?.message ?? '').length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.symbols).toEqual([]);
      expect(candidate.relations).toEqual([]);
    }
  });
});

describe('detectModules', () => {
  it('merges Java and TypeScript roots and sorts them by path', async () => {
    const root = await temporary('ai-workflow-adapters-detect-');
    await writeFixture(root, 'backend/pom.xml', '');
    await writeFixture(root, 'backend/src/main/java/com/example/App.java', 'package com.example;\n');
    await writeFixture(root, 'frontend/src/a.ts', TS_SOURCE_A);
    await writeFixture(root, 'root.ts', TS_SOURCE_A);
    const facts = await scanProject(root);

    const roots = await detectModules(root, facts);
    const paths = roots.map((entry) => entry.path);

    expect(paths).toEqual(['.', 'backend', 'frontend']);
    assertSorted(roots, (entry) => entry.path);
    expect(roots.find((entry) => entry.path === 'backend')?.language).toBe('java');
    expect(roots.find((entry) => entry.path === 'frontend')?.language).toBe('typescript');
    expect(roots.find((entry) => entry.path === '.')?.language).toBe('typescript');
  });
});
