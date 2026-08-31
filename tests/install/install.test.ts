import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { install, uninstall } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

describe('host installation', () => {
  it('installs all hosts in a temporary HOME and precisely uninstalls owned files', async () => { const home = await temporary('ai-workflow-home-'); await mkdir(join(home, '.agents/plugins'), { recursive: true }); await writeFile(join(home, '.agents/plugins/marketplace.json'), JSON.stringify({ plugins: [{ name: 'keep', version: '1' }], setting: true })); await mkdir(join(home, '.codex/agents'), { recursive: true }); await writeFile(join(home, '.codex/agents/unrelated.md'), 'keep'); await install(['codex', 'claude', 'opencode'], { home }); expect(await exists(join(home, '.codex/plugins/ai-workflow/.codex-plugin/plugin.json'))).toBe(true); expect(await exists(join(home, '.codex/plugins/ai-workflow/skills/planning/SKILL.md'))).toBe(true); expect(await exists(join(home, '.claude/skills/ai-workflow/skills/planning/SKILL.md'))).toBe(true); expect(await exists(join(home, '.config/opencode/skills/ai-workflow-planning/SKILL.md'))).toBe(true); const skill = await readFile(join(home, '.codex/plugins/ai-workflow/skills/planning/SKILL.md'), 'utf8'); expect(skill).toContain('## Clarification loop'); await uninstall(['codex', 'claude', 'opencode'], { home }); expect(await exists(join(home, '.codex/agents/unrelated.md'))).toBe(true); const marketplace = JSON.parse(await readFile(join(home, '.agents/plugins/marketplace.json'), 'utf8')) as { plugins: Array<{ name: string }>; setting: boolean }; expect(marketplace.plugins.some((plugin) => plugin.name === 'keep')).toBe(true); expect(marketplace.plugins.some((plugin) => plugin.name === 'ai-workflow')).toBe(false); expect(marketplace.setting).toBe(true); });
  it('installs agents without a product prefix and emits valid host frontmatter', async () => {
    const home = await temporary('ai-workflow-agent-format-');
    await install(['codex', 'claude', 'opencode'], { home });

    expect(await exists(join(home, '.codex/agents/backend.md'))).toBe(true);
    expect(await exists(join(home, '.codex/agents/ai-workflow-backend.md'))).toBe(false);
    expect(await exists(join(home, '.claude/skills/ai-workflow/agents/backend.md'))).toBe(true);
    expect(await exists(join(home, '.config/opencode/agents/task-worker.md'))).toBe(true);
    expect(await exists(join(home, '.config/opencode/agents/ai-workflow-task-worker.md'))).toBe(false);

    const codex = await readFile(join(home, '.codex/agents/backend.md'), 'utf8');
    expect(codex).toContain('tools: [read, edit, shell]');
    const claude = await readFile(join(home, '.claude/skills/ai-workflow/agents/backend.md'), 'utf8');
    expect(claude).toContain('allowed-tools: [read, edit, shell]');
    const opencode = await readFile(join(home, '.config/opencode/agents/backend.md'), 'utf8');
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
  it('overwrites only managed host directories on upgrade', async () => { const home = await temporary(); await install(['codex'], { home, version: '0.1.0' }); await writeFile(join(home, '.codex/plugins/ai-workflow/stale.txt'), 'old'); await install(['codex'], { home, version: '0.2.0' }); expect(await exists(join(home, '.codex/plugins/ai-workflow/stale.txt'))).toBe(false); expect(await readFile(join(home, '.codex/plugins/ai-workflow/.codex-plugin/plugin.json'), 'utf8')).toContain('0.2.0'); });
  it('preflights malformed shared marketplace before changing any host', async () => { const home = await temporary(); await mkdir(join(home, '.agents/plugins'), { recursive: true }); await writeFile(join(home, '.agents/plugins/marketplace.json'), '[]'); await expect(install(['codex', 'claude'], { home })).rejects.toThrow(/marketplace/); expect(await exists(join(home, '.codex/plugins/ai-workflow'))).toBe(false); expect(await exists(join(home, '.claude/skills/ai-workflow'))).toBe(false); });
});
