import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { activateProfile, getActiveProfile, install, uninstall } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

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
    expect(report.installations.every((installation) => installation.agents.length === 10)).toBe(true);
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
  it('rejects reinstall when the active profile no longer exists', async () => {
    const home = await temporary('ai-workflow-profile-stale-');
    await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
    await writeFile(join(home, '.config/ai-workflow/active-profile'), 'deleted\n');

    await expect(install(['codex'], { home })).rejects.toThrow(/Profile does not exist: deleted/);

    expect(await exists(join(home, '.codex/agents/backend.toml'))).toBe(false);
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
    expect(skill).toContain('`<project>/.worktrees`');
    expect(skill).toContain('`.gitignore` contains `.worktrees/`');
  });
  it('installs agents without a product prefix and emits valid host frontmatter', async () => {
    const home = await temporary('ai-workflow-agent-format-');
    await install(['codex', 'claude', 'opencode'], { home });

    expect(await exists(join(home, '.codex/agents/backend.toml'))).toBe(true);
    expect(await exists(join(home, '.codex/agents/ai-workflow-backend.toml'))).toBe(false);
    expect(await exists(join(home, '.claude/agents/backend.md'))).toBe(true);
    expect(await exists(join(home, '.config/opencode/agents/task-worker.md'))).toBe(true);
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
    const legacy = join(home, '.config/opencode/agents/ai-workflow-task-worker.md');
    const unrelated = join(home, '.config/opencode/agents/ai-workflow-unrelated.md');
    await mkdir(join(home, '.config/opencode/agents'), { recursive: true });
    await writeFile(legacy, 'legacy managed agent');
    await writeFile(unrelated, 'keep');
    await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
    await writeFile(join(home, '.config/ai-workflow/install-manifest.json'), JSON.stringify({
      version: '0.1.0',
      installed_at: new Date(0).toISOString(),
      hosts: { opencode: [{ path: '.config/opencode/agents/ai-workflow-task-worker.md', digest: 'old', kind: 'file' }] }
    }));

    await install(['opencode'], { home, version: '0.2.0' });

    expect(await exists(legacy)).toBe(false);
    expect(await exists(join(home, '.config/opencode/agents/task-worker.md'))).toBe(true);
    expect(await exists(unrelated)).toBe(true);
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
    expect(await readFile(join(home, '.agents/skills/git-message/SKILL.md'), 'utf8')).toContain('# Git Message');
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
});
