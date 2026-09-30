import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

const navigationJson = '.ai-workflow/index/navigation.json';
const navigationMarkdown = '.ai-workflow/index/navigation.md';

interface CliResult { code: number; stdout: string; stderr: string }

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? ''
    };
  }
}

async function readText(root: string, relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8');
}

async function initRepo(directory: string): Promise<void> {
  await exec('git', ['init', '-b', 'main'], { cwd: directory });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: directory });
  await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: directory });
}

async function commitAll(directory: string, message: string): Promise<void> {
  await exec('git', ['add', '.'], { cwd: directory });
  await exec('git', ['commit', '-m', message], { cwd: directory });
}

/** Build a real workspace root with one initialized local git submodule named `child`. */
async function workspaceWithSubmodule(): Promise<string> {
  const root = await temporary('ai-workflow-submodule-root-');
  await initRepo(root);
  await writeFile(join(root, 'README.md'), '# Workspace\n');
  await commitAll(root, 'workspace initial');
  const child = await temporary('ai-workflow-submodule-child-');
  await initRepo(child);
  await mkdir(join(child, 'src'), { recursive: true });
  await writeFile(join(child, 'src/index.ts'), 'export function childEntry(): void {}\n');
  await commitAll(child, 'child initial');
  await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'child'], { cwd: root });
  await commitAll(root, 'add child submodule');
  return root;
}

function indexedPaths(index: NavigationIndex): string[] {
  return index.features.flatMap((feature) => [
    ...feature.entries,
    ...feature.related_files,
    ...feature.tests,
    ...feature.symbols.map((symbol) => symbol.file)
  ]);
}

function isInsideChild(path: string): boolean {
  return path === 'child' || path.startsWith('child/');
}

async function snapshotPair(root: string): Promise<{ json: string; markdown: string }> {
  return { json: await readText(root, navigationJson), markdown: await readText(root, navigationMarkdown) };
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) snapshot.set(relative(root, absolute).split(sep).join('/'), createHash('sha256').update(await readFile(absolute)).digest('hex'));
    }
  }
  await walk(root);
  return snapshot;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

const legacyIndex: NavigationIndex = {
  version: 1,
  module_roots: [{ id: 'child', path: 'child', owner_role: 'shared', responsibility: 'child workspace', language: 'typescript', entry_kinds: ['exported-symbol'] }],
  features: [{
    id: 'child',
    name: 'child',
    aliases: [],
    module_root: 'child',
    entries: ['child/src/index.ts'],
    symbols: [{ file: 'child/src/index.ts', name: 'childEntry', kind: 'function', visibility: 'public' }],
    related_files: [],
    tests: [],
    depends_on: [],
    relations: [],
    owner_role: 'shared',
    responsibility: 'child workspace',
    read_scope: ['child/src/index.ts'],
    shared_entry: false
  }]
};

describe('submodule workspace navigation', () => {
  it('initializes a workspace without indexing declared submodule files and passes --all', async () => {
    const root = await workspaceWithSubmodule();

    const init = await runCli(['init', root]);
    expect(init.code).toBe(0);

    const index = JSON.parse(await readText(root, navigationJson)) as NavigationIndex;
    expect(indexedPaths(index).filter(isInsideChild)).toEqual([]);
    expect(index.module_roots.filter((moduleRoot) => isInsideChild(moduleRoot.path))).toEqual([]);

    const validate = await runCli(['context', 'validate', '--project', root, '--all']);
    expect(validate.code).toBe(0);
    expect(JSON.parse(validate.stdout)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a legacy navigation that indexes submodule paths and repairs it with rebuild --write', async () => {
    const root = await workspaceWithSubmodule();
    const init = await runCli(['init', root]);
    expect(init.code).toBe(0);
    await writeFile(join(root, navigationJson), `${JSON.stringify(legacyIndex)}\n`);
    await writeFile(join(root, navigationMarkdown), renderNavigation(legacyIndex));

    const rejected = await runCli(['context', 'validate', '--project', root, '--all']);
    expect(rejected.code).not.toBe(0);
    const rejectedBody = JSON.parse(rejected.stdout) as { valid: boolean; errors: string[] };
    expect(rejectedBody.valid).toBe(false);
    expect(rejectedBody.errors).toContain('Navigation index references declared submodule path "child/src/index.ts"; run ai-workflow context rebuild --write to refresh');

    const pairBefore = await snapshotPair(root);
    const dryRun = await runCli(['context', 'rebuild', '--project', root]);
    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toEqual({ valid: true, wrote: false, module_roots: 0, features: 0 });
    expect(await snapshotPair(root)).toEqual(pairBefore);

    const treeBefore = await snapshotTree(root);
    const written = await runCli(['context', 'rebuild', '--project', root, '--write']);
    expect(written.code).toBe(0);
    expect(JSON.parse(written.stdout)).toEqual({ valid: true, wrote: true, module_roots: 0, features: 0 });
    expect(changedPaths(treeBefore, await snapshotTree(root))).toEqual([navigationJson, navigationMarkdown].sort());
    expect(await snapshotPair(root)).not.toEqual(pairBefore);

    const accepted = await runCli(['context', 'validate', '--project', root, '--all']);
    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({ valid: true, errors: [] });
  });

  it('keeps a boundary-free project byte-identical through rebuild', async () => {
    const root = await temporary('ai-workflow-no-submodule-');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export function alpha(): void {}\n');

    const init = await runCli(['init', root]);
    expect(init.code).toBe(0);
    const pairBefore = await snapshotPair(root);

    const rebuild = await runCli(['context', 'rebuild', '--project', root, '--write']);
    expect(rebuild.code).toBe(0);
    expect(JSON.parse(rebuild.stdout)).toEqual({ valid: true, wrote: true, module_roots: 1, features: 1 });
    expect(await snapshotPair(root)).toEqual(pairBefore);

    const validate = await runCli(['context', 'validate', '--project', root, '--all']);
    expect(validate.code).toBe(0);
    expect(JSON.parse(validate.stdout)).toEqual({ valid: true, errors: [] });
  });
});
