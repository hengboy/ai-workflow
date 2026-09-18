import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

function configPath(home: string): string {
  return join(home, '.config/ai-workflow/config.yaml');
}
async function readConfig(home: string): Promise<Record<string, unknown>> {
  return YAML.parse(await readFile(configPath(home), 'utf8')) as Record<string, unknown>;
}
async function writeProfile(home: string, name: string, model = 'gpt-5.6-terra'): Promise<void> {
  const directory = join(home, '.config/ai-workflow/profiles');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.yaml`), `version: 1.0.0\nagents:\n  test:\n    codex: { model: ${model}, reasoning_effort: medium }\n`);
}
async function writeConfig(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
  await writeFile(configPath(home), contents);
}

describe('profile CLI', () => {
  it('activates an existing profile into config.yaml (AC-001)', async () => {
    const home = await temporary('ai-workflow-profile-cli-');
    await writeProfile(home, 'local');
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
    const config = await readConfig(home);
    expect(config.active_profile).toBe('local');
  });

  it('preserves an unrelated configuration key while adding the new active_profile (AC-002)', async () => {
    const home = await temporary('ai-workflow-profile-cli-preserve-');
    await writeProfile(home, 'team');
    await writeConfig(home, 'version: 1\n');
    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'install', '--host', 'codex', '--home', home]);

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'profile', 'activate', 'team', '--home', home]);

    const config = await readConfig(home);
    expect(config.version).toBe(1);
    expect(config.active_profile).toBe('team');
  });
});
