import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { activateProfile, getActiveProfile, install, uninstall } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

function configPath(home: string): string {
  return join(home, '.config/ai-workflow/config.yaml');
}
function markerPath(home: string): string {
  return join(home, '.config/ai-workflow/active-profile');
}
async function readConfig(home: string): Promise<Record<string, unknown>> {
  return YAML.parse(await readFile(configPath(home), 'utf8')) as Record<string, unknown>;
}
async function writeConfig(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
  await writeFile(configPath(home), contents);
}
async function writeMarker(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
  await writeFile(markerPath(home), contents);
}
async function writeProfile(home: string, name: string, model = name): Promise<void> {
  const directory = join(home, '.config/ai-workflow/profiles');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.yaml`), `version: 1.0.0\nagents:\n  backend:\n    codex: { model: ${model}, reasoning_effort: high }\n`);
}

describe('host installation', () => {
  it('activates an existing profile and reinstalls every host agent with native model settings', async () => {
    const home = await temporary('ai-workflow-profile-activate-');
    await install(['codex', 'claude', 'opencode'], { home });
    await mkdir(join(home, '.config/ai-workflow/profiles'), { recursive: true });
    await writeFile(join(home, '.config/ai-workflow/profiles/team.yaml'), `
version: 1.0.0
agents:
  backend:
    codex: { model: gpt-5.6, reasoning_effort: high }
    claude: { model: opus, reasoning_effort: max }
    opencode: { model: openai/gpt-5.6-terra, reasoning_effort: medium }
`);

    const report = await activateProfile('team', { home });

    expect(await getActiveProfile(home)).toBe('team');
    expect(report.active_profile).toBe('team');
    expect(report.installations.map((installation) => installation.host)).toEqual(['codex', 'claude', 'opencode']);
    expect(report.installations.map((installation) => installation.agents_directory)).toEqual([
      join(home, '.codex/agents'),
      join(home, '.claude/agents'),
      join(home, '.config/opencode/agents')
    ]);
    expect(report.installations.every((installation) => installation.agents.length === 9)).toBe(true);
    expect(report.installations.every((installation) => installation.agents.some((agent) => agent.name === 'researcher'))).toBe(true);
    expect(report.installations.every((installation) => installation.agents.some((agent) => agent.name === 'documentation-maintainer'))).toBe(true);
    expect(report.installations[0]?.agents.find((agent) => agent.name === 'backend')).toMatchObject({
      path: join(home, '.codex/agents/backend.toml'),
      model: 'gpt-5.6',
      reasoning_effort: 'high'
    });
    const codex = await readFile(join(home, '.codex/agents/backend.toml'), 'utf8');
    expect(codex).toContain('model = "gpt-5.6"');
    expect(codex).toContain('model_reasoning_effort = "high"');
    const claude = await readFile(join(home, '.claude/agents/backend.md'), 'utf8');
    expect(claude).not.toContain('model: gpt-5.6');
    expect(claude).toContain('model: "opus"');
    expect(claude).toContain('effort: "max"');
    const opencode = await readFile(join(home, '.config/opencode/agents/backend.md'), 'utf8');
    expect(opencode).toContain('model: "openai/gpt-5.6-terra"');
    expect(opencode).toContain('reasoningEffort: "medium"');
  });
  it('rejects a missing profile without changing the active profile or installed agents', async () => {
    const home = await temporary('ai-workflow-profile-missing-');
    await install(['codex'], { home });
    const before = await readFile(join(home, '.codex/agents/backend.toml'), 'utf8');

    await expect(activateProfile('missing', { home })).rejects.toThrow(/does not exist/);

    expect(await getActiveProfile(home)).toBeUndefined();
    expect(await readFile(join(home, '.codex/agents/backend.toml'), 'utf8')).toBe(before);
  });
  it('replaces the single active profile when another existing profile is enabled', async () => {
    const home = await temporary('ai-workflow-profile-switch-');
    const directory = join(home, '.config/ai-workflow/profiles');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'first.yaml'), 'version: 1.0.0\nagents:\n  backend:\n    codex: { model: first, reasoning_effort: low }\n');
    await writeFile(join(directory, 'second.yaml'), 'version: 1.0.0\nagents:\n  backend:\n    codex: { model: second, reasoning_effort: high }\n');
    await install(['codex'], { home });

    await activateProfile('first', { home });
    await activateProfile('second', { home });

    expect(await getActiveProfile(home)).toBe('second');
    expect(await readFile(join(home, '.codex/agents/backend.toml'), 'utf8')).toContain('model = "second"');
  });
  it('reuses the active profile when ai-workflow is installed again', async () => {
    const home = await temporary('ai-workflow-profile-reinstall-');
    const directory = join(home, '.config/ai-workflow/profiles');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'active.yaml'), 'version: 1.0.0\nagents:\n  backend:\n    codex: { model: retained, reasoning_effort: xhigh }\n');
    await install(['codex'], { home, version: '0.1.0' });
    await activateProfile('active', { home });

    await install(['codex'], { home, version: '0.2.0' });

    const agent = await readFile(join(home, '.codex/agents/backend.toml'), 'utf8');
    expect(agent).toContain('model = "retained"');
    expect(agent).toContain('model_reasoning_effort = "xhigh"');
  });
  it('rejects an invalid migration candidate before writing and keeps the legacy marker (AC-008)', async () => {
    const home = await temporary('ai-workflow-profile-stale-');
    await writeConfig(home, 'output_language: zh-CN\n');
    await writeMarker(home, 'deleted\n');
    const configBefore = await readFile(configPath(home));

    await expect(install(['codex'], { home })).rejects.toThrow(/Profile does not exist: deleted/);

    expect(await exists(join(home, '.codex/agents/backend.toml'))).toBe(false);
    expect(await exists(join(home, '.agents/skills/planning/SKILL.md'))).toBe(false);
    expect(await readFile(configPath(home))).toEqual(configBefore);
    expect(await readFile(markerPath(home), 'utf8')).toBe('deleted\n');
  });
  it('installs shared skills and per-host agents, then precisely uninstalls owned files', async () => { const home = await temporary('ai-workflow-home-'); await mkdir(join(home, '.agents/plugins'), { recursive: true }); await writeFile(join(home, '.agents/plugins/marketplace.json'), JSON.stringify({ plugins: [{ name: 'keep', version: '1' }], setting: true })); await mkdir(join(home, '.codex/agents'), { recursive: true }); await writeFile(join(home, '.codex/agents/unrelated.md'), 'keep'); await install(['codex', 'claude', 'opencode'], { home }); expect(await exists(join(home, '.agents/skills/planning/SKILL.md'))).toBe(true); expect(await exists(join(home, '.agents/skills/git-message/SKILL.md'))).toBe(true); expect(await exists(join(home, '.agents/skills/switch-profile/SKILL.md'))).toBe(true); expect(await exists(join(home, '.codex/plugins/ai-workflow'))).toBe(false); expect(await exists(join(home, '.claude/skills/ai-workflow'))).toBe(false); expect(await exists(join(home, '.config/opencode/skills/planning/SKILL.md'))).toBe(false); expect(await readFile(join(home, '.agents/plugins/marketplace.json'), 'utf8')).toBe(JSON.stringify({ plugins: [{ name: 'keep', version: '1' }], setting: true })); const skill = await readFile(join(home, '.agents/skills/planning/SKILL.md'), 'utf8'); expect(skill).toContain('## Clarification loop'); await uninstall(['codex', 'claude', 'opencode'], { home }); expect(await exists(join(home, '.codex/agents/unrelated.md'))).toBe(true); expect(await exists(join(home, '.agents/skills/planning/SKILL.md'))).toBe(false); expect(await exists(join(home, '.codex/agents/backend.toml'))).toBe(false); const marketplace = JSON.parse(await readFile(join(home, '.agents/plugins/marketplace.json'), 'utf8')) as { plugins: Array<{ name: string }>; setting: boolean }; expect(marketplace.plugins.some((plugin) => plugin.name === 'keep')).toBe(true); expect(marketplace.plugins.some((plugin) => plugin.name === 'ai-workflow')).toBe(false); expect(marketplace.setting).toBe(true); });
  it('installs each skill with its metadata and nested reference templates', async () => {
    const home = await temporary('ai-workflow-skill-resources-');

    await install(['codex', 'claude', 'opencode'], { home });

    const root = join(home, '.agents/skills');
    expect(await exists(join(root, 'coding/agents/openai.yaml'))).toBe(true);
    expect(await exists(join(root, 'git-message/references/commit-message.md'))).toBe(true);
    expect(await exists(join(root, 'plan-to-tasks/references/task.md'))).toBe(true);
    expect(await exists(join(root, 'planning/references/spec.md'))).toBe(true);
    expect(await exists(join(root, 'planning/references/plan.md'))).toBe(true);
    expect(await exists(join(root, 'switch-profile/agents/openai.yaml'))).toBe(true);
    expect(await exists(join(root, 'setup-ai-workflow/agents/openai.yaml'))).toBe(true);
  });
  it('installs the coding skill with the project-local worktree policy', async () => {
    const home = await temporary('ai-workflow-coding-worktree-policy-');

    await install(['codex', 'claude', 'opencode'], { home });

    const skill = await readFile(join(home, '.agents/skills/coding/SKILL.md'), 'utf8');
    expect(skill).toContain('test-driven');
    expect(skill).toContain('approved task');
    expect(skill).not.toContain('workflow.json');
  });
  it('installs agents without a product prefix and emits valid host frontmatter', async () => {
    const home = await temporary('ai-workflow-agent-format-');
    await install(['codex', 'claude', 'opencode'], { home });

    expect(await exists(join(home, '.codex/agents/backend.toml'))).toBe(true);
    expect(await exists(join(home, '.codex/agents/ai-workflow-backend.toml'))).toBe(false);
    expect(await exists(join(home, '.claude/agents/backend.md'))).toBe(true);
    expect(await exists(join(home, '.config/opencode/agents/task-worker.md'))).toBe(false);
    expect(await exists(join(home, '.config/opencode/agents/researcher.md'))).toBe(true);
    expect(await exists(join(home, '.config/opencode/agents/documentation-maintainer.md'))).toBe(true);
    expect(await exists(join(home, '.config/opencode/agents/ai-workflow-task-worker.md'))).toBe(false);

    const codex = await readFile(join(home, '.codex/agents/backend.toml'), 'utf8');
    expect(codex).toContain('name = "backend"');
    expect(codex).toContain('developer_instructions =');
    const claude = await readFile(join(home, '.claude/agents/backend.md'), 'utf8');
    expect(claude).toContain('allowed-tools: [read, edit, shell]');
    const opencode = await readFile(join(home, '.config/opencode/agents/backend.md'), 'utf8');
    expect(opencode).toContain('hidden: true');
    expect(opencode).toContain('permission:\n  read: allow\n  edit: allow\n  bash: allow');
    expect(opencode).not.toContain('tools:');
  });
  it('removes previously managed prefixed agents during an upgrade', async () => {
    const home = await temporary('ai-workflow-agent-upgrade-');
    const legacy = join(home, '.config/opencode/agents/ai-workflow-backend.md');
    const unrelated = join(home, '.config/opencode/agents/ai-workflow-unrelated.md');
    const sameNamedElsewhere = join(home, '.claude/agents/ai-workflow-backend.md');
    await mkdir(join(home, '.config/opencode/agents'), { recursive: true });
    await writeFile(legacy, 'legacy managed agent');
    await writeFile(unrelated, 'keep');
    await mkdir(join(home, '.claude/agents'), { recursive: true });
    await writeFile(sameNamedElsewhere, 'keep');
    await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
    await writeFile(join(home, '.config/ai-workflow/install-manifest.json'), JSON.stringify({
      version: '0.1.0',
      installed_at: new Date(0).toISOString(),
      hosts: { opencode: [{ path: '.config/opencode/agents/ai-workflow-backend.md', digest: 'old', kind: 'file' }] }
    }));

    await install(['opencode'], { home, version: '0.2.0' });

    expect(await exists(legacy)).toBe(true);
    expect(await exists(join(home, '.config/opencode/agents/backend.md'))).toBe(true);
    expect(await exists(unrelated)).toBe(true);
    expect(await exists(sameNamedElsewhere)).toBe(true);
  });
  it('removes previously managed prefixed skill directories during an upgrade', async () => {
    const home = await temporary('ai-workflow-skill-upgrade-');
    const legacy = join(home, '.config/opencode/skills/ai-workflow-git-message');
    const unrelated = join(home, '.config/opencode/skills/ai-workflow-unrelated');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'SKILL.md'), 'legacy managed skill');
    await mkdir(unrelated, { recursive: true });
    await writeFile(join(unrelated, 'SKILL.md'), 'keep');
    await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
    await writeFile(join(home, '.config/ai-workflow/install-manifest.json'), JSON.stringify({
      version: '0.1.0',
      installed_at: new Date(0).toISOString(),
      hosts: { opencode: [{ path: '.config/opencode/skills/ai-workflow-git-message', digest: 'old', kind: 'directory' }] }
    }));

    await install(['opencode'], { home, version: '0.2.0' });

    expect(await exists(legacy)).toBe(false);
    expect(await exists(join(home, '.agents/skills/git-message/SKILL.md'))).toBe(true);
    expect(await exists(unrelated)).toBe(true);
  });
  it('overwrites managed skill files and preserves unrelated files in the shared skills directory', async () => {
    const home = await temporary('ai-workflow-shared-skill-safety-');
    await install(['codex', 'claude', 'opencode'], { home });
    await mkdir(join(home, '.agents/skills/tdd'), { recursive: true });
    await writeFile(join(home, '.agents/skills/tdd/SKILL.md'), 'keep');
    await writeFile(join(home, '.agents/skills/planning/notes.md'), 'user note');
    await writeFile(join(home, '.agents/skills/git-message/SKILL.md'), 'tampered');

    await install(['codex', 'claude', 'opencode'], { home, version: '0.2.0' });

    expect(await readFile(join(home, '.agents/skills/tdd/SKILL.md'), 'utf8')).toBe('keep');
    expect(await readFile(join(home, '.agents/skills/planning/notes.md'), 'utf8')).toBe('user note');
    expect(await readFile(join(home, '.agents/skills/git-message/SKILL.md'), 'utf8')).toBe('tampered');
  });
  it('installs shared skills for a single host install and uninstalls only that host', async () => {
    const home = await temporary('ai-workflow-single-host-');
    await install(['claude'], { home });

    expect(await exists(join(home, '.agents/skills/planning/SKILL.md'))).toBe(true);
    expect(await exists(join(home, '.claude/agents/backend.md'))).toBe(true);
    expect(await exists(join(home, '.codex/agents/backend.toml'))).toBe(false);

    await uninstall(['claude'], { home });

    expect(await exists(join(home, '.claude/agents/backend.md'))).toBe(false);
    expect(await exists(join(home, '.agents/skills/planning/SKILL.md'))).toBe(false);
  });
  it('keeps shared skills when one host is uninstalled while others remain', async () => {
    const home = await temporary('ai-workflow-partial-uninstall-');
    await install(['codex', 'claude'], { home });

    await uninstall(['codex'], { home });

    expect(await exists(join(home, '.codex/agents/backend.toml'))).toBe(false);
    expect(await exists(join(home, '.agents/skills/planning/SKILL.md'))).toBe(true);
    expect(await exists(join(home, '.claude/agents/backend.md'))).toBe(true);
  });
  it('strips the legacy ai-workflow entry from an existing shared marketplace on install', async () => {
    const home = await temporary('ai-workflow-marketplace-migration-');
    await mkdir(join(home, '.agents/plugins'), { recursive: true });
    await writeFile(join(home, '.agents/plugins/marketplace.json'), JSON.stringify({
      name: 'ai-workflow-local',
      plugins: [
        { name: 'ai-workflow', source: { source: 'local', path: './.codex/plugins/ai-workflow' }, policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' }, category: 'Productivity', version: '0.1.0' },
        { name: 'keep', version: '1' }
      ],
      setting: true
    }));

    await install(['codex', 'claude', 'opencode'], { home });

    const marketplace = JSON.parse(await readFile(join(home, '.agents/plugins/marketplace.json'), 'utf8')) as { name: string; plugins: Array<{ name: string }>; setting: boolean };
    expect(marketplace.plugins.some((plugin) => plugin.name === 'ai-workflow')).toBe(false);
    expect(marketplace.plugins.some((plugin) => plugin.name === 'keep')).toBe(true);
    expect(marketplace.setting).toBe(true);
  });
  it('leaves a malformed legacy marketplace untouched and still installs', async () => {
    const home = await temporary('ai-workflow-malformed-marketplace-');
    await mkdir(join(home, '.agents/plugins'), { recursive: true });
    await writeFile(join(home, '.agents/plugins/marketplace.json'), '[]');

    await install(['codex', 'claude', 'opencode'], { home });

    expect(await readFile(join(home, '.agents/plugins/marketplace.json'), 'utf8')).toBe('[]');
    expect(await exists(join(home, '.agents/skills/planning/SKILL.md'))).toBe(true);
  });
  it('rejects a legacy profile containing task-worker atomically and names the role', async () => {
    const home = await temporary('ai-workflow-profile-legacy-');
    await install(['codex'], { home });
    const before = await readFile(join(home, '.codex/agents/backend.toml'), 'utf8');
    const directory = join(home, '.config/ai-workflow/profiles'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'legacy.yaml'), 'version: 1.0.0\nagents:\n  task-worker:\n    codex: { model: legacy, reasoning_effort: low }\n');
    await expect(activateProfile('legacy', { home })).rejects.toThrow(/task-worker/);
    expect(await getActiveProfile(home)).toBeUndefined();
    expect(await readFile(join(home, '.codex/agents/backend.toml'), 'utf8')).toBe(before);
  });
  it('renders agents from config.yaml active_profile without a legacy marker (AC-004)', async () => {
    const home = await temporary('ai-workflow-install-config-active-');
    await writeProfile(home, 'team', 'gpt-5.6');
    await writeConfig(home, 'active_profile: team\n');

    await install(['codex'], { home });

    const agent = await readFile(join(home, '.codex/agents/backend.toml'), 'utf8');
    expect(agent).toContain('model = "gpt-5.6"');
    expect(agent).toContain('model_reasoning_effort = "high"');
    expect(await exists(markerPath(home))).toBe(false);
  });
  it('installs with default rendering when there is no active profile (AC-005)', async () => {
    const home = await temporary('ai-workflow-install-default-');

    await install(['codex'], { home });

    const agent = await readFile(join(home, '.codex/agents/backend.toml'), 'utf8');
    expect(agent).toContain('name = "backend"');
    expect(agent).not.toMatch(/^model = /m);
    expect(agent).not.toMatch(/^model_reasoning_effort = /m);
    expect(await exists(configPath(home))).toBe(false);
    expect(await exists(markerPath(home))).toBe(false);
  });
  it('migrates a legacy marker into config.yaml and preserves output_language (AC-006)', async () => {
    const home = await temporary('ai-workflow-install-migrate-');
    await writeProfile(home, 'opencode-go', 'gpt-5.6');
    await writeConfig(home, 'output_language: zh-CN\n');
    await writeMarker(home, 'opencode-go\n');

    await install(['codex'], { home });

    const config = await readConfig(home);
    expect(config.active_profile).toBe('opencode-go');
    expect(config.output_language).toBe('zh-CN');
    expect(await exists(markerPath(home))).toBe(false);
  });
  it('prefers config.yaml active_profile over the legacy marker and deletes the marker (AC-007)', async () => {
    const home = await temporary('ai-workflow-install-marker-conflict-');
    await writeProfile(home, 'alpha', 'alpha-model');
    await writeConfig(home, 'active_profile: alpha\n');
    await writeMarker(home, 'beta\n');

    await install(['codex'], { home });

    const config = await readConfig(home);
    expect(config.active_profile).toBe('alpha');
    expect(await exists(markerPath(home))).toBe(false);
    const agent = await readFile(join(home, '.codex/agents/backend.toml'), 'utf8');
    expect(agent).toContain('model = "alpha-model"');
  });
  it.each([
    ['a numeric active_profile', 'active_profile: 123\n'],
    ['an empty active_profile', 'active_profile: ""\n'],
    ['a path-like active_profile', 'active_profile: ../x\n']
  ])('rejects %s during install before writing any managed file (AC-009)', async (_label, contents) => {
    const home = await temporary('ai-workflow-install-invalid-active-');
    await writeConfig(home, contents);
    const configBefore = await readFile(configPath(home));

    await expect(install(['codex'], { home })).rejects.toThrow(/active_profile/);

    expect(await exists(join(home, '.codex/agents/backend.toml'))).toBe(false);
    expect(await exists(join(home, '.agents/skills/planning/SKILL.md'))).toBe(false);
    expect(await readFile(configPath(home))).toEqual(configBefore);
  });
  it('rejects an illegal config active_profile during activation before writing (AC-009)', async () => {
    const home = await temporary('ai-workflow-activate-invalid-active-');
    await writeProfile(home, 'team', 'gpt-5.6');
    await install(['codex'], { home });
    const agentBefore = await readFile(join(home, '.codex/agents/backend.toml'), 'utf8');
    await writeConfig(home, 'active_profile: 123\n');
    const configBefore = await readFile(configPath(home));

    await expect(activateProfile('team', { home })).rejects.toThrow(/active_profile/);

    expect(await readFile(join(home, '.codex/agents/backend.toml'), 'utf8')).toBe(agentBefore);
    expect(await readFile(configPath(home))).toEqual(configBefore);
  });
  it('leaves config.yaml unchanged when a host is uninstalled (regression)', async () => {
    const home = await temporary('ai-workflow-uninstall-config-');
    await writeProfile(home, 'team', 'gpt-5.6');
    await writeConfig(home, 'output_language: zh-CN\nactive_profile: team\n');
    await install(['codex'], { home });
    const before = await readFile(configPath(home));

    await uninstall(['codex'], { home });

    expect(await readFile(configPath(home))).toEqual(before);
  });
});
