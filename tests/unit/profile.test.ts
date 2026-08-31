import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
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
`);

    await expect(loadProfile(home, 'team')).resolves.toEqual({
      version: '1.0.0',
      agents: {
        backend: {
          codex: { model: 'gpt-5.6', reasoning_effort: 'high' },
          claude: { model: 'opus', reasoning_effort: 'max' },
          opencode: { model: 'openai/gpt-5.6-terra', reasoning_effort: 'medium' }
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
});
