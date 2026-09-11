import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { install, uninstall, activateProfile, getActiveProfile } from '../../src/install/index.js';
import { temporary } from '../helpers.js';

const fault = vi.hoisted(() => ({ suffix: '', after: false }));
vi.mock('../../src/utils/fs.js', async (load) => {
  const actual = await load<typeof import('../../src/utils/fs.js')>();
  return { ...actual, atomicWrite: async (path: string, contents: string | Buffer) => {
    if (fault.suffix && path.endsWith(fault.suffix)) {
      fault.suffix = '';
      if (fault.after) await actual.atomicWrite(path, contents);
      throw new Error('injected publication failure');
    }
    await actual.atomicWrite(path, contents);
  } };
});
const homes: string[] = [];
async function home(): Promise<string> { const root = await temporary(); homes.push(root); return root; }
afterEach(async () => { fault.suffix = ''; fault.after = false; await Promise.all(homes.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('installation ownership and rollback', () => {
  it('reports edited agents and skills as skipped on reinstall and uninstall, including a later reinstall', async () => {
    const root = await home();
    await install(['codex'], { home: root });
    const paths = ['.codex/agents/backend.toml', '.agents/skills/planning/SKILL.md'];
    for (const path of paths) await writeFile(join(root, path), 'user changes');
    expect((await install(['codex'], { home: root })).skipped).toEqual(expect.arrayContaining(paths));
    expect((await uninstall(['codex'], { home: root })).skipped).toEqual(expect.arrayContaining(['.codex/agents/backend.toml']));
    expect((await install(['codex'], { home: root })).skipped).toEqual(expect.arrayContaining(paths));
    for (const path of paths) expect(await readFile(join(root, path), 'utf8')).toBe('user changes');
  });

  it.each([false, true])('rolls back fresh installation when agent publication fails (after write: %s)', async (after) => {
    const root = await home();
    await writeFile(join(root, 'keep.txt'), 'user');
    fault.suffix = '/backend.toml'; fault.after = after;
    await expect(install(['codex'], { home: root })).rejects.toThrow('injected publication failure');
    expect(await readdir(root)).toEqual(['keep.txt']);
  });

  it('restores agents, marker and manifest on activation failure', async () => {
    const root = await home();
    await mkdir(join(root, '.config/ai-workflow/profiles'), { recursive: true });
    for (const name of ['first', 'second']) await writeFile(join(root, `.config/ai-workflow/profiles/${name}.yaml`), `version: 1.0.0\nagents:\n  backend:\n    codex: { model: ${name}, reasoning_effort: high }\n`);
    await install(['codex'], { home: root });
    await activateProfile('first', { home: root });
    const paths = ['.codex/agents/backend.toml', '.config/ai-workflow/active-profile', '.config/ai-workflow/install-manifest.json'];
    const before = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')));
    fault.suffix = '/backend.toml'; fault.after = true;
    await expect(activateProfile('second', { home: root })).rejects.toThrow('injected publication failure');
    expect(await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')))).toEqual(before);
  });

  it('does not activate a profile over an edited agent or report the requested model as installed', async () => {
    const root = await home();
    await install(['codex'], { home: root });
    await mkdir(join(root, '.config/ai-workflow/profiles'), { recursive: true });
    await writeFile(join(root, '.config/ai-workflow/profiles/team.yaml'), 'version: 1.0.0\nagents:\n  backend:\n    codex: { model: team, reasoning_effort: high }\n');
    await writeFile(join(root, '.codex/agents/backend.toml'), 'user changes');
    await expect(activateProfile('team', { home: root })).rejects.toThrow(/modified|conflict|skipped/i);
    expect(await getActiveProfile(root)).toBeUndefined();
    expect(await readFile(join(root, '.codex/agents/backend.toml'), 'utf8')).toBe('user changes');
  });
});
