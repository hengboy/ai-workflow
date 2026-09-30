import { describe, expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isExcludedDirectory, scanProject } from '../../src/context/discovery/scanner.js';
import { temporary } from '../helpers.js';

const EXCLUDED_DIRECTORIES = [
  '.git',
  '.ai-workflow',
  '.worktrees',
  'node_modules',
  'vendor',
  'target',
  'build',
  'dist',
  'coverage',
  '.next',
  '.cache'
];

async function writeFileAt(root: string, relativePath: string, contents = 'export const value = true;\n'): Promise<void> {
  const absolute = join(root, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

describe('scanProject', () => {
  it('excludes generated directories and never traverses project-external symlinks', async () => {
    const root = await temporary('ai-workflow-discovery-');
    const external = await temporary('ai-workflow-external-');

    await writeFileAt(root, 'src/app.ts');
    await writeFileAt(root, 'src/nested/util.ts');

    for (const directory of EXCLUDED_DIRECTORIES) {
      await writeFileAt(root, `${directory}/inside.ts`);
    }

    await writeFileAt(external, 'external-only.ts');
    await writeFileAt(external, 'extdir/nested-only.ts');
    await symlink(join(external, 'external-only.ts'), join(root, 'linked-file.ts'));
    await symlink(join(external, 'extdir'), join(root, 'linked-dir'));

    const facts = await scanProject(root);
    const paths = facts.files.map((file) => file.path);

    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('src/nested/util.ts');

    for (const directory of EXCLUDED_DIRECTORIES) {
      expect(paths.some((path) => path.split('/').includes(directory))).toBe(false);
    }

    expect(paths.some((path) => path.includes('linked-file'))).toBe(false);
    expect(paths.some((path) => path.includes('linked-dir'))).toBe(false);
    expect(paths.some((path) => path.includes('external-only'))).toBe(false);
    expect(paths.some((path) => path.includes('nested-only'))).toBe(false);
  });

  it('maps file extensions to discovery languages', async () => {
    const root = await temporary('ai-workflow-language-');
    const expected: Record<string, string> = {
      'lang/a.ts': 'typescript',
      'lang/b.tsx': 'typescript',
      'lang/c.js': 'javascript',
      'lang/d.jsx': 'javascript',
      'lang/e.mjs': 'javascript',
      'lang/f.cjs': 'javascript',
      'lang/G.java': 'java',
      'lang/h.txt': 'unknown',
      'lang/i.css': 'unknown'
    };

    for (const path of Object.keys(expected)) {
      await writeFileAt(root, path);
    }

    const facts = await scanProject(root);
    const byPath = new Map(facts.files.map((file) => [file.path, file.language]));

    for (const [path, language] of Object.entries(expected)) {
      expect(byPath.get(path)).toBe(language);
    }
  });

  it('is deterministic and sorts paths with a locale-independent comparator', async () => {
    const root = await temporary('ai-workflow-order-');
    for (const path of ['z.ts', 'm.ts', 'a.ts', 'nested/b.ts']) {
      await writeFileAt(root, path);
    }

    const first = await scanProject(root);
    const second = await scanProject(root);

    expect(second).toEqual(first);

    const paths = first.files.map((file) => file.path);
    expect(paths).toEqual(['a.ts', 'm.ts', 'nested/b.ts', 'z.ts']);
    expect(paths).toEqual([...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  });

  it('returns project-relative POSIX paths without parent traversal', async () => {
    const root = await temporary('ai-workflow-relative-');
    await writeFileAt(root, 'src/app.ts');

    const facts = await scanProject(root);
    const paths = facts.files.map((file) => file.path);

    expect(paths).toContain('src/app.ts');
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(false);
      expect(path.includes('\\')).toBe(false);
      expect(path.split('/')).not.toContain('..');
      expect(path.split('/')).not.toContain('');
    }
  });

  it('returns an empty file list for an empty project', async () => {
    const root = await temporary('ai-workflow-empty-');

    await expect(scanProject(root)).resolves.toEqual({ files: [] });
  });

  it('prunes declared submodule directories before traversal', async () => {
    const root = await temporary('ai-workflow-submodule-scan-');
    await writeFile(
      join(root, '.gitmodules'),
      '[submodule "child"]\n\tpath = child\n\turl = ../child\n[submodule "nested"]\n\tpath = nested/child\n\turl = ../nested-child\n'
    );
    await writeFileAt(root, 'src/app.ts');
    await writeFileAt(root, 'child/src/nested.ts');
    await writeFileAt(root, 'nested/child/deep.ts');

    const facts = await scanProject(root);
    const paths = facts.files.map((file) => file.path);

    expect(paths).toContain('src/app.ts');
    expect(paths.filter((path) => path === 'child' || path.startsWith('child/'))).toEqual([]);
    expect(paths.filter((path) => path === 'nested/child' || path.startsWith('nested/child/'))).toEqual([]);
  });

  it('treats a declared submodule without a directory as a safe boundary', async () => {
    const root = await temporary('ai-workflow-submodule-uninitialized-');
    await writeFile(join(root, '.gitmodules'), '[submodule "empty"]\n\tpath = empty\n\turl = ../empty\n');
    await writeFileAt(root, 'src/app.ts');

    const facts = await scanProject(root);
    const paths = facts.files.map((file) => file.path);

    expect(paths).toContain('src/app.ts');
    expect(paths.some((path) => path === 'empty' || path.startsWith('empty/'))).toBe(false);
  });

  it('does not error on a declared submodule whose directory is empty', async () => {
    const root = await temporary('ai-workflow-submodule-empty-');
    await writeFile(join(root, '.gitmodules'), '[submodule "child"]\n\tpath = child\n\turl = ../child\n');
    await mkdir(join(root, 'child'), { recursive: true });
    await writeFileAt(root, 'src/app.ts');

    const facts = await scanProject(root);
    const paths = facts.files.map((file) => file.path);

    expect(paths).toContain('src/app.ts');
    expect(paths.some((path) => path === 'child' || path.startsWith('child/'))).toBe(false);
  });
});

describe('isExcludedDirectory', () => {
  it.each(EXCLUDED_DIRECTORIES)('treats %s as an excluded directory', (name) => {
    expect(isExcludedDirectory(name)).toBe(true);
  });

  it.each(['src', 'tests'])('does not exclude ordinary directory %s', (name) => {
    expect(isExcludedDirectory(name)).toBe(false);
  });
});
