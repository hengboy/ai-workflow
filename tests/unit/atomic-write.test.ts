import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

const fault = vi.hoisted(() => ({ operation: '' }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]).endsWith('.tmp') && fault.operation) {
      const operation = fault.operation; fault.operation = '';
      vi.spyOn(handle, operation as 'writeFile' | 'sync').mockRejectedValueOnce(new Error(`injected ${operation}`));
    }
    return handle;
  } };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); fault.operation = ''; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe('atomic write failures', () => {
  it.each(['writeFile', 'sync'])('cleans temporary files and preserves existing bytes when %s fails', async (operation) => {
    const root = await temporary(); roots.push(root);
    const path = join(root, 'target'); await writeFile(path, 'before');
    fault.operation = operation;
    await expect(atomicWrite(path, 'after')).rejects.toThrow(`injected ${operation}`);
    expect(await readdir(root)).toEqual(['target']);
    expect(await readFile(path, 'utf8')).toBe('before');
  });
  it('cleans its temporary file when rename fails on an existing directory', async () => {
    const root = await temporary(); roots.push(root); const path = join(root, 'target');
    await mkdir(path);
    await expect(atomicWrite(path, 'after')).rejects.toThrow();
    expect(await readdir(root)).toEqual(['target']);
  });
});
