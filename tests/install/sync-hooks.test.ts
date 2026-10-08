import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { install, uninstall } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { packagePath } from '../../src/utils/schema.js';
import { temporary } from '../helpers.js';
import type { Host } from '../../src/workflow/types.js';

// External filesystem-boundary fault: intercept only the native-config rename target so the
// real installer transaction (not an internal product helper) is exercised end to end.
const fault = vi.hoisted(() => ({ armed: false, target: '', after: false }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) => {
      if (fault.armed && String(newPath).endsWith(fault.target)) {
        fault.armed = false;
        if (!fault.after) throw new Error(`injected native configuration failure before rename: ${fault.target}`);
        await actual.rename(oldPath, newPath);
        throw new Error(`injected native configuration failure after rename: ${fault.target}`);
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

/**
 * Frozen native synchronization deployment contract for slice 2.4.
 *
 * `install(hosts, { home, opencodeVersion })` / `uninstall(hosts, { home })` deploy one
 * shared native entry per host into a disposable HOME and must stay additive:
 *
 *   - Claude  -> `<home>/.claude/settings.json` nested `hooks[event] = Group[]`
 *                with `Group.hooks = [{ type: 'command', command }]`.
 *   - Codex   -> `<home>/.codex/hooks.json` with the same nested shape.
 *   - OpenCode-> owned plugin `<home>/.config/opencode/plugins/ai-workflow-sync.js`.
 *
 * The owned hook command is the built local CLI, both paths shell-quoted:
 *   "<node>" "<package>/dist/cli.js" sync-hook --host <host>
 *
 * Install freezes an optional public report:
 *   synchronization: Array<{ host, status, active, warnings }>
 *   - claude   status 'installed'        active false (the installer cannot prove a
 *              loaded session; 'installed' is not a universal active guarantee)
 *   - codex    status 'trust_required'   active false (no trust bypass)
 *   - opencode status 'restart_required' active false (plugin loads on restart)
 *   - disabled native config -> status 'disabled', active false, config left untouched
 *   - unowned host-scoped legacy `sync-ai-workflow/SKILL.md` survives and its exact
 *     path is reported in the opencode warnings.
 */
interface SynchronizationReport { host: Host; status: string; active: boolean; warnings: string[] }
type InstallResult = Awaited<ReturnType<typeof install>> & { synchronization?: SynchronizationReport[] };

interface HookEntry { type?: string; command?: string; [key: string]: unknown }
interface HookGroup { matcher?: string; hooks?: HookEntry[]; [key: string]: unknown }
interface HookConfig { hooks?: Record<string, HookGroup[]>; [key: string]: unknown }

const hosts: Host[] = ['claude', 'codex', 'opencode'];
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse'] as const;
const claudeSettingsRelative = '.claude/settings.json';
const codexHooksRelative = '.codex/hooks.json';
const codexConfigRelative = '.codex/config.toml';
const opencodePluginRelative = '.config/opencode/plugins/ai-workflow-sync.js';
const opencodeUserPluginRelative = '.config/opencode/plugins/user.js';
const legacyOpencodeSkillRelative = '.config/opencode/skills/sync-ai-workflow/SKILL.md';

const cliPath = packagePath('dist', 'cli.js');
function expectedCommand(host: Host): string { return `"${process.execPath}" "${cliPath}" sync-hook --host ${host}`; }

const userClaudeGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-claude' }] };
const claudeUserSettings = {
  model: 'opus',
  permissions: { allow: ['Bash'] },
  hooks: { PreToolUse: [userClaudeGroup] },
};
const userCodexGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-codex' }] };
const codexUserHooks = { hooks: { PreToolUse: [userCodexGroup] } };
const userPluginBytes = 'export const userPlugin = true;\n';

const homes: string[] = [];
afterEach(async () => {
  fault.armed = false;
  fault.target = '';
  fault.after = false;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function homeWithSpace(): Promise<string> {
  // A space in the root proves path-sensitive configuration keeps working.
  const home = await temporary('ai-workflow hook home ');
  homes.push(home);
  return home;
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function writeAt(home: string, relativePath: string, contents: string): Promise<void> {
  const path = join(home, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

/** Full fixture state: every file digest plus every directory, so empty dirs are compared too. */
async function treeState(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push(`d ${relativePath}`);
        await walk(join(directory, entry.name), relativePath);
      } else if (entry.isSymbolicLink()) {
        entries.push(`l ${relativePath}`);
      } else if (entry.isFile()) {
        entries.push(`f ${relativePath} ${createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex')}`);
      }
    }
  }
  await walk(root, '');
  return entries.sort();
}

const userGlobalInstructionBytes = '# User global instruction\n\nIndependent user bytes.\n';
const userOpencodeAgentBytes = '# User opencode agent\n\nIndependent agent bytes.\n';
const userOpencodeSkillBytes = '# User opencode skill\n\nIndependent skill bytes.\n';

/** Pre-existing user native configs, global instructions and OpenCode plugin/agent/skill bytes. */
async function seedUserState(home: string): Promise<void> {
  await writeAt(home, claudeSettingsRelative, `${JSON.stringify(claudeUserSettings, null, 2)}\n`);
  await writeAt(home, codexHooksRelative, `${JSON.stringify(codexUserHooks, null, 2)}\n`);
  await writeAt(home, opencodeUserPluginRelative, userPluginBytes);
  await writeAt(home, '.config/opencode/agents/user-agent.md', userOpencodeAgentBytes);
  await writeAt(home, '.config/opencode/skills/user-skill/SKILL.md', userOpencodeSkillBytes);
  await writeAt(home, '.claude/CLAUDE.md', userGlobalInstructionBytes);
  await writeAt(home, '.codex/AGENTS.md', userGlobalInstructionBytes);
}

function ownedCommands(config: HookConfig, host: Host): Array<{ event: string; group: HookGroup; entry: HookEntry }> {
  const owned: Array<{ event: string; group: HookGroup; entry: HookEntry }> = [];
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const entry of group.hooks ?? []) {
        if (typeof entry.command === 'string' && entry.command.includes(`sync-hook --host ${host}`)) owned.push({ event, group, entry });
      }
    }
  }
  return owned;
}

function isOwnedGroup(group: HookGroup, host: Host): boolean {
  return (group.hooks ?? []).some((entry) => typeof entry.command === 'string' && entry.command.includes(`sync-hook --host ${host}`));
}

/** Simulate a user inserting a new unrelated group immediately before the owned one. */
function insertUserGroupBeforeOwned(config: HookConfig, host: Host, event: string, inserted: HookGroup): void {
  const groups = config.hooks?.[event];
  if (!groups) throw new Error(`missing hook event: ${host} ${event}`);
  const index = groups.findIndex((group) => isOwnedGroup(group, host));
  if (index === -1) throw new Error(`owned group not found: ${host} ${event}`);
  groups.splice(index, 0, inserted);
}

/** Simulate a user moving the unchanged owned group to another position within one event. */
function moveOwnedGroupToFront(config: HookConfig, host: Host, event: string): void {
  const groups = config.hooks?.[event];
  if (!groups) throw new Error(`missing hook event: ${host} ${event}`);
  const index = groups.findIndex((group) => isOwnedGroup(group, host));
  if (index === -1) throw new Error(`owned group not found: ${host} ${event}`);
  const [owned] = groups.splice(index, 1);
  groups.unshift(owned!);
}

describe('native synchronization deployment lifecycle', () => {
  it('AC-012/AC-013 installs one shared native entry per host additively and uninstalls only owned entries', async () => {
    const home = await homeWithSpace();
    expect(home.includes(' ')).toBe(true);
    await writeAt(home, claudeSettingsRelative, `${JSON.stringify(claudeUserSettings, null, 2)}\n`);
    await writeAt(home, codexHooksRelative, `${JSON.stringify(codexUserHooks, null, 2)}\n`);
    await writeAt(home, opencodeUserPluginRelative, userPluginBytes);

    const report = await install(hosts, { home, opencodeVersion: 'v1' }) as InstallResult;

    // Frozen truthful enablement report.
    expect(report.synchronization, 'install must report per-host synchronization state').toBeDefined();
    const byHost = new Map(report.synchronization!.map((entry) => [entry.host, entry]));
    expect(byHost.get('claude')?.status).toBe('installed');
    expect(byHost.get('claude')?.active).toBe(false);
    expect(byHost.get('codex')?.status).toBe('trust_required');
    expect(byHost.get('codex')?.active).toBe(false);
    expect(byHost.get('opencode')?.status).toBe('restart_required');
    expect(byHost.get('opencode')?.active).toBe(false);
    for (const host of hosts) expect(Array.isArray(byHost.get(host)?.warnings)).toBe(true);

    // Claude: one owned entry per event, exact shared-local-CLI command, no unsupported ids.
    const claude = await readJsonFile<HookConfig>(join(home, claudeSettingsRelative));
    for (const event of events) {
      const owned = ownedCommands(claude, 'claude').filter((item) => item.event === event);
      expect(owned.length, `claude ${event}`).toBe(1);
      expect(owned[0]!.entry.type).toBe('command');
      expect(owned[0]!.entry.command).toBe(expectedCommand('claude'));
      expect(Object.prototype.hasOwnProperty.call(owned[0]!.entry, 'id')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(owned[0]!.group, 'id')).toBe(false);
    }

    // Codex: same nested shape and shared command.
    const codex = await readJsonFile<HookConfig>(join(home, codexHooksRelative));
    for (const event of events) {
      const owned = ownedCommands(codex, 'codex').filter((item) => item.event === event);
      expect(owned.length, `codex ${event}`).toBe(1);
      expect(owned[0]!.entry.type).toBe('command');
      expect(owned[0]!.entry.command).toBe(expectedCommand('codex'));
      expect(Object.prototype.hasOwnProperty.call(owned[0]!.entry, 'id')).toBe(false);
    }

    // OpenCode: the owned plugin file appears and uses the shared entry.
    expect(await exists(join(home, opencodePluginRelative))).toBe(true);
    expect(await readFile(join(home, opencodePluginRelative), 'utf8')).toContain('sync-hook');

    // Existing user groups/data survive byte-for-byte / structurally.
    expect(claude.model).toBe('opus');
    expect(claude.permissions).toEqual({ allow: ['Bash'] });
    expect(claude.hooks?.PreToolUse ?? []).toEqual(expect.arrayContaining([userClaudeGroup]));
    expect(codex.hooks?.PreToolUse ?? []).toEqual(expect.arrayContaining([userCodexGroup]));
    expect(await readFile(join(home, opencodeUserPluginRelative), 'utf8')).toBe(userPluginBytes);

    // Reinstall is idempotent: no duplicated owned entries and no user changes.
    const claudeOwnedBefore = ownedCommands(claude, 'claude').length;
    const codexOwnedBefore = ownedCommands(codex, 'codex').length;
    await install(hosts, { home, opencodeVersion: 'v1' });
    const claudeAgain = await readJsonFile<HookConfig>(join(home, claudeSettingsRelative));
    const codexAgain = await readJsonFile<HookConfig>(join(home, codexHooksRelative));
    expect(ownedCommands(claudeAgain, 'claude').length).toBe(claudeOwnedBefore);
    expect(ownedCommands(codexAgain, 'codex').length).toBe(codexOwnedBefore);
    for (const event of events) {
      expect(ownedCommands(claudeAgain, 'claude').filter((item) => item.event === event).length).toBe(1);
      expect(ownedCommands(codexAgain, 'codex').filter((item) => item.event === event).length).toBe(1);
    }
    expect(await readFile(join(home, opencodeUserPluginRelative), 'utf8')).toBe(userPluginBytes);

    // Uninstall removes only owned entries; user settings and plugins remain.
    await uninstall(hosts, { home });
    const claudeRemoved = await readJsonFile<HookConfig>(join(home, claudeSettingsRelative));
    const codexRemoved = await readJsonFile<HookConfig>(join(home, codexHooksRelative));
    expect(ownedCommands(claudeRemoved, 'claude')).toEqual([]);
    expect(ownedCommands(codexRemoved, 'codex')).toEqual([]);
    expect(claudeRemoved.model).toBe('opus');
    expect(claudeRemoved.permissions).toEqual({ allow: ['Bash'] });
    expect(claudeRemoved.hooks?.PreToolUse ?? []).toEqual(expect.arrayContaining([userClaudeGroup]));
    expect(codexRemoved.hooks?.PreToolUse ?? []).toEqual(expect.arrayContaining([userCodexGroup]));
    expect(await exists(join(home, opencodePluginRelative))).toBe(false);
    expect(await readFile(join(home, opencodeUserPluginRelative), 'utf8')).toBe(userPluginBytes);
  });

  it('AC-013 reports disabled native config and an unowned shadow skill without overriding them', async () => {
    const home = await homeWithSpace();
    await writeAt(home, claudeSettingsRelative, `${JSON.stringify({ disableAllHooks: true, model: 'sonnet' }, null, 2)}\n`);
    const codexConfigBytes = '[features]\nhooks = false\n';
    await writeAt(home, codexConfigRelative, codexConfigBytes);
    const legacyBytes = '# sync-ai-workflow\n\nLegacy skill that copies whole templates.\n';
    await writeAt(home, legacyOpencodeSkillRelative, legacyBytes);

    const report = await install(hosts, { home, opencodeVersion: 'v1' }) as InstallResult;
    const byHost = new Map((report.synchronization ?? []).map((entry) => [entry.host, entry]));

    expect(byHost.get('claude')?.status).toBe('disabled');
    expect(byHost.get('claude')?.active).toBe(false);
    expect(byHost.get('codex')?.status).toBe('disabled');
    expect(byHost.get('codex')?.active).toBe(false);
    const opencode = byHost.get('opencode');
    expect(opencode).toBeDefined();
    expect((opencode?.warnings ?? []).some((warning) => warning.includes(legacyOpencodeSkillRelative))).toBe(true);
    expect(opencode?.active).toBe(false);

    // No override or blind deletion: disabled flags and the unowned skill stay intact.
    const claude = await readJsonFile<Record<string, unknown>>(join(home, claudeSettingsRelative));
    expect(claude.disableAllHooks).toBe(true);
    expect(claude.model).toBe('sonnet');
    expect(await readFile(join(home, codexConfigRelative), 'utf8')).toBe(codexConfigBytes);
    expect(await readFile(join(home, legacyOpencodeSkillRelative), 'utf8')).toBe(legacyBytes);
  });

  it('AC-012 refreshes and removes uniquely owned groups after the user shifts their position', async () => {
    const home = await homeWithSpace();
    await writeAt(home, claudeSettingsRelative, `${JSON.stringify(claudeUserSettings, null, 2)}\n`);
    await writeAt(home, codexHooksRelative, `${JSON.stringify(codexUserHooks, null, 2)}\n`);
    await install(['claude', 'codex'], { home, opencodeVersion: 'v1' });

    // The user edits their own native config: inserts new unrelated groups before the
    // owned PreToolUse/UserPromptSubmit groups and moves the owned group in one event.
    const insertedClaude = { matcher: 'Write', hooks: [{ type: 'command', command: 'echo user-inserted-claude' }] };
    const insertedClaudePrompt = { hooks: [{ type: 'command', command: 'echo user-inserted-prompt' }] };
    const insertedCodexPrompt = { hooks: [{ type: 'command', command: 'echo user-inserted-codex-prompt' }] };
    const claudeConfig = await readJsonFile<HookConfig>(join(home, claudeSettingsRelative));
    insertUserGroupBeforeOwned(claudeConfig, 'claude', 'PreToolUse', insertedClaude);
    insertUserGroupBeforeOwned(claudeConfig, 'claude', 'UserPromptSubmit', insertedClaudePrompt);
    await writeFile(join(home, claudeSettingsRelative), `${JSON.stringify(claudeConfig, null, 2)}\n`);
    const codexConfig = await readJsonFile<HookConfig>(join(home, codexHooksRelative));
    moveOwnedGroupToFront(codexConfig, 'codex', 'PreToolUse');
    insertUserGroupBeforeOwned(codexConfig, 'codex', 'UserPromptSubmit', insertedCodexPrompt);
    await writeFile(join(home, codexHooksRelative), `${JSON.stringify(codexConfig, null, 2)}\n`);

    // Reinstall must find the moved-but-unchanged owned groups without duplicating them
    // and without degrading a normal host to an attention result.
    const report = await install(['claude', 'codex'], { home, opencodeVersion: 'v1' }) as InstallResult;
    const byHost = new Map((report.synchronization ?? []).map((entry) => [entry.host, entry]));
    expect(byHost.get('claude')?.status).toBe('installed');
    expect(byHost.get('codex')?.status).toBe('trust_required');
    expect((byHost.get('claude')?.warnings ?? []).some((warning) => /modified owned/i.test(warning)), 'a merely moved owned group is not modified').toBe(false);
    expect((byHost.get('codex')?.warnings ?? []).some((warning) => /modified owned/i.test(warning)), 'a merely moved owned group is not modified').toBe(false);

    const claudeAfter = await readJsonFile<HookConfig>(join(home, claudeSettingsRelative));
    const codexAfter = await readJsonFile<HookConfig>(join(home, codexHooksRelative));
    for (const event of events) {
      expect(ownedCommands(claudeAfter, 'claude').filter((item) => item.event === event).length, `claude ${event}`).toBe(1);
      expect(ownedCommands(codexAfter, 'codex').filter((item) => item.event === event).length, `codex ${event}`).toBe(1);
    }
    for (const item of ownedCommands(claudeAfter, 'claude')) expect(item.entry.command).toBe(expectedCommand('claude'));
    for (const item of ownedCommands(codexAfter, 'codex')) expect(item.entry.command).toBe(expectedCommand('codex'));
    // Every unrelated user group and setting survives the reinstall.
    expect(claudeAfter.hooks?.PreToolUse ?? []).toEqual(expect.arrayContaining([userClaudeGroup, insertedClaude]));
    expect(claudeAfter.hooks?.UserPromptSubmit ?? []).toEqual(expect.arrayContaining([insertedClaudePrompt]));
    expect(codexAfter.hooks?.PreToolUse ?? []).toEqual(expect.arrayContaining([userCodexGroup]));
    expect(codexAfter.hooks?.UserPromptSubmit ?? []).toEqual(expect.arrayContaining([insertedCodexPrompt]));
    expect(claudeAfter.model).toBe('opus');
    expect(claudeAfter.permissions).toEqual({ allow: ['Bash'] });

    // Uninstall must remove the owned groups at their current position, not their old
    // array index, leaving every user group and the settings intact.
    await uninstall(['claude', 'codex'], { home });
    const claudeRemoved = await readJsonFile<HookConfig>(join(home, claudeSettingsRelative));
    const codexRemoved = await readJsonFile<HookConfig>(join(home, codexHooksRelative));
    expect(ownedCommands(claudeRemoved, 'claude')).toEqual([]);
    expect(ownedCommands(codexRemoved, 'codex')).toEqual([]);
    expect(claudeRemoved.hooks?.PreToolUse ?? []).toEqual(expect.arrayContaining([userClaudeGroup, insertedClaude]));
    expect(claudeRemoved.hooks?.UserPromptSubmit ?? []).toEqual(expect.arrayContaining([insertedClaudePrompt]));
    expect(codexRemoved.hooks?.PreToolUse ?? []).toEqual(expect.arrayContaining([userCodexGroup]));
    expect(codexRemoved.hooks?.UserPromptSubmit ?? []).toEqual(expect.arrayContaining([insertedCodexPrompt]));
    expect(claudeRemoved.model).toBe('opus');
    expect(claudeRemoved.permissions).toEqual({ allow: ['Bash'] });
  });

  it.each([false, true])('AC-012/REQ-006 restores the whole tree when the Codex native config publication fails (after rename: %s)', async (after) => {
    const home = await homeWithSpace();
    await seedUserState(home);
    const beforeTree = await treeState(home);

    // Hosts run claude then codex, so Claude's native config is already published when the
    // one-shot external rename fault hits .codex/hooks.json.
    fault.target = '.codex/hooks.json';
    fault.after = after;
    fault.armed = true;
    await expect(install(['claude', 'codex', 'opencode'], { home, opencodeVersion: 'v1' }))
      .rejects.toThrow(/\.codex[/\\]hooks\.json/);
    expect(fault.armed, 'the one-shot external fault is consumed').toBe(false);

    // The installer contract rejects, and the entire fixture tree (bytes and directories,
    // including invocation-created files/plugins/instructions and emptied directories) is
    // restored to its independent pre-install state.
    expect(await treeState(home)).toEqual(beforeTree);
    expect(await readFile(join(home, claudeSettingsRelative), 'utf8')).toBe(`${JSON.stringify(claudeUserSettings, null, 2)}\n`);
    expect(await readFile(join(home, codexHooksRelative), 'utf8')).toBe(`${JSON.stringify(codexUserHooks, null, 2)}\n`);
    expect(await readFile(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe(userGlobalInstructionBytes);
    expect(await readFile(join(home, '.codex/AGENTS.md'), 'utf8')).toBe(userGlobalInstructionBytes);
    expect(await readFile(join(home, opencodeUserPluginRelative), 'utf8')).toBe(userPluginBytes);
    expect(await readFile(join(home, '.config/opencode/agents/user-agent.md'), 'utf8')).toBe(userOpencodeAgentBytes);
    expect(await readFile(join(home, '.config/opencode/skills/user-skill/SKILL.md'), 'utf8')).toBe(userOpencodeSkillBytes);

    // Only invocation-created artifacts are gone; no own native config/plugin survives.
    expect(await exists(join(home, opencodePluginRelative))).toBe(false);
    expect(await exists(join(home, '.config/opencode/AGENTS.md'))).toBe(false);
    expect(await exists(join(home, '.agents'))).toBe(false);
  });
});
