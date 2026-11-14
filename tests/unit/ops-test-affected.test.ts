import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { NavigationFeature, NavigationIndex } from '../../src/context/navigation.js';
import { formatAffectedTests, suggestAffectedTests } from '../../src/ops/test-affected.js';
import { changedPaths, snapshotTree, temporary } from '../helpers.js';

/**
 * Change-aware test suggestion public contract:
 *
 *   suggestAffectedTests(project: string, changedPaths: string[]): Promise<{
 *     match: boolean;
 *     features: string[];   // sorted indexed feature ids that own a changed path
 *     tests: string[];      // sorted unique union of their indexed tests
 *     command: string | null; // exactly one `pnpm exec vitest run ...` command, or null
 *     message: string;
 *     exitCode: number;     // 0 for a match, nonzero for a no-match
 *   }>
 *
 *   formatAffectedTests(result): string // the text the script prints
 *
 * The module reads `<project>/.ai-workflow/index/navigation.json` only and writes nothing.
 */

const execFileAsync = promisify(execFile);
const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface FixtureFeature {
  id: string;
  entries: string[];
  tests: string[];
}

const FIXTURE_FEATURES: FixtureFeature[] = [
  { id: 'alpha', entries: ['src/alpha.ts', 'src/shared.ts'], tests: ['tests/unit/alpha.test.ts', 'tests/unit/shared.test.ts'] },
  { id: 'beta', entries: ['src/shared.ts'], tests: ['tests/unit/beta.test.ts', 'tests/unit/shared.test.ts'] },
  { id: 'bare', entries: ['src/bare.ts'], tests: [] },
];

function navigationFeature(feature: FixtureFeature): NavigationFeature {
  return {
    id: feature.id,
    name: feature.id,
    aliases: [],
    module_root: 'src',
    entries: feature.entries,
    symbols: [],
    related_files: [],
    tests: feature.tests,
    depends_on: [],
    relations: [],
    owner_role: 'backend',
    responsibility: `${feature.id} fixture feature`,
    read_scope: feature.entries,
    shared_entry: false,
  };
}

async function affectedFixture(): Promise<string> {
  const root = await temporary('ai-workflow-test-affected-');
  temporaries.push(root);
  const index: NavigationIndex = {
    version: 1,
    module_roots: [{ id: 'src', path: 'src', owner_role: 'backend', responsibility: 'test fixture source', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: FIXTURE_FEATURES.map(navigationFeature),
  };
  await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(root, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index, null, 2)}\n`);
  for (const feature of FIXTURE_FEATURES) {
    for (const path of [...feature.entries, ...feature.tests]) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, '// fixture\n');
    }
  }
  return root;
}

interface ExecFailure {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

function execFailure(error: unknown): ExecFailure {
  const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return {
    code: typeof value.code === 'number' ? value.code : undefined,
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
  };
}

function packageScripts(): Promise<Record<string, string>> {
  return readFile(join(process.cwd(), 'package.json'), 'utf8').then((contents) => {
    const parsed = JSON.parse(contents) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  });
}

describe('suggestAffectedTests', () => {
  it('maps one entry of an indexed feature with tests to exactly one Vitest command', async () => {
    const root = await affectedFixture();
    const result = await suggestAffectedTests(root, ['src/alpha.ts']);

    expect(result.match).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.features).toEqual(['alpha']);
    expect(result.tests).toEqual(['tests/unit/alpha.test.ts', 'tests/unit/shared.test.ts']);
    expect(result.command).toBe('pnpm exec vitest run tests/unit/alpha.test.ts tests/unit/shared.test.ts');

    const output = formatAffectedTests(result);
    expect(output.match(/vitest run/g)).toHaveLength(1);
    for (const path of result.tests) expect(output).toContain(path);
  });

  it('unions the test files of every feature that owns a shared path', async () => {
    const root = await affectedFixture();
    const result = await suggestAffectedTests(root, ['src/shared.ts']);

    expect(result.match).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.features).toEqual(['alpha', 'beta']);
    expect(result.tests).toEqual(['tests/unit/alpha.test.ts', 'tests/unit/beta.test.ts', 'tests/unit/shared.test.ts']);
    expect(result.command).toBe('pnpm exec vitest run tests/unit/alpha.test.ts tests/unit/beta.test.ts tests/unit/shared.test.ts');

    const output = formatAffectedTests(result);
    expect(output.match(/vitest run/g)).toHaveLength(1);
  });

  it('treats an indexed feature without tests as a no-match with the declared-check fallback', async () => {
    const root = await affectedFixture();
    const result = await suggestAffectedTests(root, ['src/bare.ts']);

    expect(result.match).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.command).toBeNull();
    expect(result.message).toMatch(/no indexed test matched/i);
    expect(result.message).toMatch(/declared task or plan checks/i);

    const output = formatAffectedTests(result);
    expect(output).toMatch(/no indexed test matched/i);
    expect(output).toMatch(/declared task or plan checks/i);
  });

  it('treats a path owned by no indexed feature as a no-match with the declared-check fallback', async () => {
    const root = await affectedFixture();
    const result = await suggestAffectedTests(root, ['src/unknown.ts']);

    expect(result.match).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.command).toBeNull();
    expect(result.message).toMatch(/no indexed test matched/i);
    expect(result.message).toMatch(/declared task or plan checks/i);
  });

  it('writes no file for either a match or a no-match', async () => {
    const root = await affectedFixture();
    const before = await snapshotTree(root);

    await suggestAffectedTests(root, ['src/shared.ts']);
    await suggestAffectedTests(root, ['src/unknown.ts']);

    const after = await snapshotTree(root);
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('exposes the declared package script', async () => {
    const scripts = await packageScripts();
    expect(scripts['test:affected']).toMatch(/test-affected/);
  });

  it('exits 0 at the package-script boundary for a known indexed path', async () => {
    const { stdout } = await execFileAsync('pnpm', ['run', '--silent', 'test:affected', '--', 'src/ops/doctor.ts'], { cwd: process.cwd(), timeout: 15_000 });

    expect(stdout.match(/vitest run/g)).toHaveLength(1);
    expect(stdout).toMatch(/tests\/unit\/ops-doctor\.test\.ts/);
  });

  it('exits nonzero at the package-script boundary for an unknown path', async () => {
    let failure: ExecFailure | undefined;
    try {
      await execFileAsync('pnpm', ['run', '--silent', 'test:affected', '--', 'src/not-an-indexed-path.ts'], { cwd: process.cwd(), timeout: 15_000 });
    } catch (error) {
      failure = execFailure(error);
    }

    expect(failure).toBeDefined();
    expect(failure?.code).not.toBe(0);
    const output = `${failure?.stdout ?? ''}\n${failure?.stderr ?? ''}`;
    expect(output).toMatch(/no indexed test matched/i);
    expect(output).toMatch(/declared task or plan checks/i);
  });
});
