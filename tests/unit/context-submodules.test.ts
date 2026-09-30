import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findSubmoduleBoundary, readSubmodules } from '../../src/context/submodules.js';
import { temporary } from '../helpers.js';

async function submodulesFile(root: string, contents: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '.gitmodules'), contents);
}

describe('readSubmodules', () => {
  it('returns no declarations when .gitmodules is missing', async () => {
    const root = await temporary('ai-workflow-submodules-missing-');

    await expect(readSubmodules(root)).resolves.toEqual([]);
  });

  it('reads declared submodule names and project-relative paths', async () => {
    const root = await temporary('ai-workflow-submodules-basic-');
    await submodulesFile(root, '[submodule "child"]\n\tpath = child\n\turl = ../child\n');

    await expect(readSubmodules(root)).resolves.toEqual([{ name: 'child', path: 'child' }]);
  });

  it('ignores comment and blank lines', async () => {
    const root = await temporary('ai-workflow-submodules-comments-');
    await submodulesFile(
      root,
      ['# leading comment', '', '; semicolon comment', '[submodule "child"]', '\tpath = child', '\t# inline comment', '', '; trailing comment', ''].join('\n')
    );

    await expect(readSubmodules(root)).resolves.toEqual([{ name: 'child', path: 'child' }]);
  });

  it('skips sections without a path', async () => {
    const root = await temporary('ai-workflow-submodules-nopath-');
    await submodulesFile(root, '[submodule "no-path"]\n\turl = ../no-path\n[submodule "child"]\n\tpath = child\n');

    await expect(readSubmodules(root)).resolves.toEqual([{ name: 'child', path: 'child' }]);
  });

  it('keeps the last declaration for a duplicated path and returns each path once', async () => {
    const root = await temporary('ai-workflow-submodules-duplicate-');
    await submodulesFile(
      root,
      ['[submodule "first"]', '\tpath = shared', '[submodule "second"]', '\tpath = shared', '[submodule "third"]', '\tpath = other'].join('\n')
    );

    await expect(readSubmodules(root)).resolves.toEqual([
      { name: 'second', path: 'shared' },
      { name: 'third', path: 'other' }
    ]);
  });

  it('distinguishes declarations that share a name but differ in path', async () => {
    const root = await temporary('ai-workflow-submodules-samename-');
    await submodulesFile(root, ['[submodule "same"]', '\tpath = a', '[submodule "same"]', '\tpath = b'].join('\n'));

    await expect(readSubmodules(root)).resolves.toEqual([
      { name: 'same', path: 'a' },
      { name: 'same', path: 'b' }
    ]);
  });

  it('normalizes backslashes, a leading ./ and trailing slashes', async () => {
    const root = await temporary('ai-workflow-submodules-normalize-');
    await submodulesFile(root, ['[submodule "a"]', '\tpath = .\\child\\', '[submodule "b"]', '\tpath = ./vendor/lib///'].join('\n'));

    await expect(readSubmodules(root)).resolves.toEqual([
      { name: 'a', path: 'child' },
      { name: 'b', path: 'vendor/lib' }
    ]);
  });

  it('reads .gitmodules on every call without caching', async () => {
    const root = await temporary('ai-workflow-submodules-fresh-');
    await submodulesFile(root, '[submodule "first"]\n\tpath = first\n');

    expect(await readSubmodules(root)).toEqual([{ name: 'first', path: 'first' }]);

    await submodulesFile(root, '[submodule "second"]\n\tpath = second\n');

    expect(await readSubmodules(root)).toEqual([{ name: 'second', path: 'second' }]);
  });
});

describe('findSubmoduleBoundary', () => {
  const declarations = [
    { name: 'child', path: 'child' },
    { name: 'vendor', path: 'vendor/lib' }
  ];

  it('matches the exact declared path', () => {
    expect(findSubmoduleBoundary('child', declarations)).toEqual({ name: 'child', path: 'child' });
    expect(findSubmoduleBoundary('vendor/lib', declarations)).toEqual({ name: 'vendor', path: 'vendor/lib' });
  });

  it('matches a descendant path on a slash boundary', () => {
    expect(findSubmoduleBoundary('child/src/index.ts', declarations)).toEqual({ name: 'child', path: 'child' });
    expect(findSubmoduleBoundary('vendor/lib/index.ts', declarations)).toEqual({ name: 'vendor', path: 'vendor/lib' });
  });

  it('normalizes the input before matching', () => {
    expect(findSubmoduleBoundary('./child\\src\\index.ts', declarations)).toEqual({ name: 'child', path: 'child' });
  });

  it('does not match a sibling that shares the prefix text', () => {
    expect(findSubmoduleBoundary('childish/index.ts', declarations)).toBeUndefined();
    expect(findSubmoduleBoundary('vendor/library.ts', declarations)).toBeUndefined();
  });

  it('returns undefined when no declaration contains the path', () => {
    expect(findSubmoduleBoundary('src/index.ts', declarations)).toBeUndefined();
  });
});
