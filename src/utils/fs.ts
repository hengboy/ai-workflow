import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWrite(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

export async function atomicDirectory(target: string, build: (temporary: string) => Promise<void>): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  await mkdir(temporary, { recursive: true });
  let moved = false;
  try {
    await build(temporary);
    if (await exists(target)) { await rename(target, backup); moved = true; }
    await rename(temporary, target);
    if (moved) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (moved && !(await exists(target))) await rename(backup, target);
    throw error;
  }
}
