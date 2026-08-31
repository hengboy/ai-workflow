import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

describe('profile CLI', () => {
  it('activates an existing profile and reports the reinstalled hosts', async () => {
    const home = await temporary('ai-workflow-profile-cli-');
    const directory = join(home, '.config/ai-workflow/profiles');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'local.yaml'), 'version: 1.0.0\nagents:\n  test:\n    codex: { model: gpt-5.6-terra, reasoning_effort: medium }\n');
    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'install', '--host', 'codex', '--home', home]);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'profile', 'activate', 'local', '--home', home]);

    const report = JSON.parse(stdout) as {
      active_profile: string;
      installations: Array<{
        host: string;
        agents_directory: string;
        agents: Array<{ name: string; path: string; model?: string; reasoning_effort?: string }>;
      }>;
    };
    expect(report.active_profile).toBe('local');
    expect(report.installations).toHaveLength(1);
    expect(report.installations[0]).toMatchObject({
      host: 'codex',
      agents_directory: join(home, '.codex/agents')
    });
    expect(report.installations[0]?.agents.find((agent) => agent.name === 'test')).toEqual({
      name: 'test',
      path: join(home, '.codex/agents/test.toml'),
      model: 'gpt-5.6-terra',
      reasoning_effort: 'medium'
    });
    expect(await readFile(join(home, '.config/ai-workflow/active-profile'), 'utf8')).toBe('local\n');
  });
});
