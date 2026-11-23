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

  it('AC-009 activates a profile for antigravity with a model tier and an ignored-effort warning', async () => {
    const home = await temporary('ai-workflow-profile-cli-antigravity-');
    const profileDirectory = join(home, '.config/ai-workflow/profiles');
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(profileDirectory, 'grid.yaml'), [
      'version: 1.0.0',
      'agents:',
      '  backend:',
      '    antigravity: { model: pro, reasoning_effort: high }',
      '',
    ].join('\n'));
    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'install', '--host', 'antigravity', '--home', home]);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'profile', 'activate', 'grid', '--home', home]);

    const report = JSON.parse(stdout) as {
      installations: Array<{
        host: string;
        agents_directory: string;
        agents: Array<{ name: string; path: string; model?: string; reasoning_effort?: string }>;
      }>;
      warnings?: string[];
    };
    const antigravity = report.installations.find((item) => item.host === 'antigravity');
    expect(antigravity).toMatchObject({ agents_directory: join(home, '.gemini/config/agents') });
    const backend = antigravity?.agents.find((agent) => agent.name === 'backend');
    expect(backend?.model).toBe('pro');
    expect(backend?.reasoning_effort).toBeUndefined();
    expect(report.warnings?.some((warning) => /antigravity/i.test(warning) && /reasoning_effort/i.test(warning))).toBe(true);

    const agent = await readFile(join(home, '.gemini/config/agents/backend.md'), 'utf8');
    expect(agent).toContain('model: "pro"');
    expect(agent).not.toMatch(/^(?:reasoning_effort|effort|variant):/m);
  });
});
