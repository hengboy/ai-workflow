import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

function configPath(home: string): string {
  return join(home, '.config/ai-workflow/config.yaml');
}
function markerPath(home: string): string {
  return join(home, '.config/ai-workflow/active-profile');
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
async function writeMarker(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
  await writeFile(markerPath(home), contents);
}

describe('profile CLI', () => {
  it('activates an existing profile into config.yaml without creating the legacy marker (AC-001)', async () => {
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
    expect(await exists(markerPath(home))).toBe(false);
  });

  it('preserves output_language while adding the new active_profile (AC-002)', async () => {
    const home = await temporary('ai-workflow-profile-cli-language-');
    await writeProfile(home, 'team');
    await writeConfig(home, 'output_language: zh-CN\n');
    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'install', '--host', 'codex', '--home', home]);

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'profile', 'activate', 'team', '--home', home]);

    const config = await readConfig(home);
    expect(config.output_language).toBe('zh-CN');
    expect(config.active_profile).toBe('team');
    expect(await exists(markerPath(home))).toBe(false);
  });

  it('activates the explicit profile even when the legacy marker holds an invalid value (AC-013)', async () => {
    const home = await temporary('ai-workflow-profile-cli-invalid-marker-');
    await writeProfile(home, 'beta');
    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'install', '--host', 'codex', '--home', home]);
    await writeMarker(home, 'deleted\n');

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'profile', 'activate', 'beta', '--home', home]);

    const report = JSON.parse(stdout) as { active_profile: string };
    expect(report.active_profile).toBe('beta');
    const config = await readConfig(home);
    expect(config.active_profile).toBe('beta');
    expect(await exists(markerPath(home))).toBe(false);
  });

  it('keeps config.yaml active_profile over the legacy marker during activation (AC-007)', async () => {
    const home = await temporary('ai-workflow-profile-cli-marker-conflict-');
    await writeProfile(home, 'alpha', 'alpha-model');
    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'install', '--host', 'codex', '--home', home]);
    await writeConfig(home, 'active_profile: alpha\n');
    await writeMarker(home, 'beta\n');

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'profile', 'activate', 'alpha', '--home', home]);

    const report = JSON.parse(stdout) as { active_profile: string };
    expect(report.active_profile).toBe('alpha');
    const config = await readConfig(home);
    expect(config.active_profile).toBe('alpha');
    expect(await exists(markerPath(home))).toBe(false);
    const agent = await readFile(join(home, '.codex/agents/test.toml'), 'utf8');
    expect(agent).toContain('model = "alpha-model"');
  });
});
