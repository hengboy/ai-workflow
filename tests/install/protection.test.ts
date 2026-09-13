import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { install, uninstall, activateProfile, getActiveProfile } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
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

  it('restores config.yaml and keeps the legacy marker on activation failure (AC-003)', async () => {
    const root = await home();
    await mkdir(join(root, '.config/ai-workflow/profiles'), { recursive: true });
    for (const name of ['first', 'second']) await writeFile(join(root, `.config/ai-workflow/profiles/${name}.yaml`), `version: 1.0.0\nagents:\n  backend:\n    codex: { model: ${name}, reasoning_effort: high }\n`);
    await install(['codex'], { home: root });
    await activateProfile('first', { home: root });
    const configPath = join(root, '.config/ai-workflow/config.yaml');
    const markerPath = join(root, '.config/ai-workflow/active-profile');
    await writeFile(markerPath, 'legacy\n');
    const configBefore = await readFile(configPath);
    const markerBefore = await readFile(markerPath);
    fault.suffix = '/backend.toml'; fault.after = true;
    await expect(activateProfile('second', { home: root })).rejects.toThrow('injected publication failure');
    expect(await readFile(configPath)).toEqual(configBefore);
    expect(await readFile(markerPath)).toEqual(markerBefore);
  });

  it('removes a newly created config.yaml and keeps the legacy marker on activation failure (AC-003)', async () => {
    const root = await home();
    await mkdir(join(root, '.config/ai-workflow/profiles'), { recursive: true });
    await writeFile(join(root, '.config/ai-workflow/profiles/team.yaml'), 'version: 1.0.0\nagents:\n  backend:\n    codex: { model: team, reasoning_effort: high }\n');
    await install(['codex'], { home: root });
    const configPath = join(root, '.config/ai-workflow/config.yaml');
    const markerPath = join(root, '.config/ai-workflow/active-profile');
    await writeFile(markerPath, 'legacy\n');
    expect(await exists(configPath)).toBe(false);
    fault.suffix = '/backend.toml'; fault.after = true;
    await expect(activateProfile('team', { home: root })).rejects.toThrow('injected publication failure');
    expect(await exists(configPath)).toBe(false);
    expect(await readFile(markerPath, 'utf8')).toBe('legacy\n');
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
