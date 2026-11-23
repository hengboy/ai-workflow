import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadProfile } from '../../src/profile/index.js';
import { temporary } from '../helpers.js';

describe('profile configuration', () => {
  it('loads per-agent model and reasoning settings for each host', async () => {
    const home = await temporary('ai-workflow-profile-');
    const directory = join(home, '.config/ai-workflow/profiles');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'team.yaml'), `
version: 1.0.0
agents:
  backend:
    codex:
      model: gpt-5.6
      reasoning_effort: high
    claude:
      model: opus
      reasoning_effort: max
    opencode:
      model: openai/gpt-5.6-terra
      reasoning_effort: medium
    antigravity:
      model: pro
      reasoning_effort: high
`);

    await expect(loadProfile(home, 'team')).resolves.toEqual({
      version: '1.0.0',
      agents: {
        backend: {
          codex: { model: 'gpt-5.6', reasoning_effort: 'high' },
          claude: { model: 'opus', reasoning_effort: 'max' },
          opencode: { model: 'openai/gpt-5.6-terra', reasoning_effort: 'medium' },
          antigravity: { model: 'pro', reasoning_effort: 'high' }
        }
      }
    });
  });

  it('rejects invalid profile names and invalid agent configuration', async () => {
    const home = await temporary('ai-workflow-profile-invalid-');
    const directory = join(home, '.config/ai-workflow/profiles');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'invalid.yaml'), 'version: 1.0.0\nagents:\n  unknown:\n    codex:\n      model: gpt-5.6\n      reasoning_effort: extreme\n');

    await expect(loadProfile(home, '../invalid')).rejects.toThrow(/Invalid profile name/);
    await expect(loadProfile(home, 'invalid')).rejects.toThrow(/Invalid profile/);
  });

  it('rejects a legacy task-worker profile and names the removed role', async () => {
    const home = await temporary('ai-workflow-profile-legacy-');
    const directory = join(home, '.config/ai-workflow/profiles');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'legacy.yaml'), 'version: 1.0.0\nagents:\n  task-worker:\n    codex:\n      model: gpt-5.6\n      reasoning_effort: low\n');

    await expect(loadProfile(home, 'legacy')).rejects.toThrow(/task-worker/);
  });

  it('accepts every Antigravity model tier in a per-agent profile', async () => {
    const home = await temporary('ai-workflow-profile-antigravity-tiers-');
    const directory = join(home, '.config/ai-workflow/profiles');
    await mkdir(directory, { recursive: true });

    for (const tier of ['inherit', 'flash_lite', 'flash', 'pro']) {
      const name = `tier-${tier}`;
      await writeFile(join(directory, `${name}.yaml`), `version: 1.0.0\nagents:\n  backend:\n    antigravity:\n      model: ${tier}\n      reasoning_effort: high\n`);
      await expect(loadProfile(home, name), `Antigravity tier ${tier}`).resolves.toMatchObject({
        agents: { backend: { antigravity: { model: tier, reasoning_effort: 'high' } } }
      });
    }
  });

  it('rejects a non-tier Antigravity model without writing a profile or active config', async () => {
    const home = await temporary('ai-workflow-profile-antigravity-invalid-');
    const directory = join(home, '.config/ai-workflow/profiles');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'bad-tier.yaml');
    const source = 'version: 1.0.0\nagents:\n  backend:\n    antigravity:\n      model: gemini-3.8-flash-low\n      reasoning_effort: high\n';
    await writeFile(path, source);

    await expect(loadProfile(home, 'bad-tier')).rejects.toThrow(/Invalid profile/);
    await expect(readFile(path, 'utf8')).resolves.toBe(source);
    await expect(readFile(join(home, '.config/ai-workflow/config.yaml'), 'utf8')).rejects.toThrow();
  });
});
