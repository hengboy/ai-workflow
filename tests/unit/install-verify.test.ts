import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { install } from '../../src/install/index.js';
import { verifyInstallation } from '../../src/install/verify.js';
import type { Host } from '../../src/workflow/types.js';
import { changedPaths, snapshotTree, temporary } from '../helpers.js';

/**
 * Installation verification public contract (stable, minimal):
 *
 *   verifyInstallation(home: string, hosts?: Host[]): Promise<{
 *     home: string;
 *     valid: boolean;   // true only when no check is 'fail'
 *     checks: Check[];
 *   }>
 *
 *   Check = {
 *     id: string;                              // stable across runs
 *     status: 'pass' | 'warn' | 'fail';
 *     detail: string;                          // a fault names the exact path, identity or SHA
 *     recovery?: string;                       // an exact command when one exists
 *   }
 *
 * Verification is read-only and never repairs the installation.
 */
interface Check { id: string; status: 'pass' | 'warn' | 'fail'; detail: string; recovery?: string }
interface InstallationReport { home: string; valid: boolean; checks: Check[] }

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function installedHome(hosts: Host[] = ['codex', 'claude', 'opencode']): Promise<string> {
  const home = await temporary('ai-workflow-install-verify-');
  homes.push(home);
  await install(hosts, { home, opencodeVersion: 'v1' });
  return home;
}

function nonPassCheck(report: InstallationReport, needles: string[], statuses?: Check['status'][]): Check | undefined {
  return report.checks.find((check) =>
    (statuses === undefined || statuses.includes(check.status))
    && needles.some((needle) => check.detail.includes(needle)),
  );
}

function expectRecovery(check: Check): void {
  expect(typeof check.recovery, `${check.id} must expose a recovery command`).toBe('string');
  expect(check.recovery?.length ?? 0).toBeGreaterThan(0);
}

function expectDigest(detail: string): void {
  expect(detail, 'a digest fault must name the expected or actual SHA').toMatch(/(?:sha256:)?[0-9a-f]{64}/);
}

describe('installation verification', () => {
  it('passes a healthy installation with stable check ids and writes nothing', async () => {
    const home = await installedHome();
    const before = await snapshotTree(home);

    const report = await verifyInstallation(home);
    const second = await verifyInstallation(home);

    expect(report.home).toBe(home);
    expect(report.valid).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((check) => check.status === 'pass'), JSON.stringify(report.checks, null, 2)).toBe(true);
    const ids = report.checks.map((check) => check.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.checks.map((check) => check.id)).toEqual(ids);
    expect(changedPaths(before, await snapshotTree(home)), 'verification must not write').toEqual([]);
  });

  it('fails a valid-JSON manifest with an invalid shape instead of throwing', async () => {
    const home = await installedHome();
    const relative = '.config/ai-workflow/install-manifest.json';
    const path = join(home, relative);
    await writeFile(path, '{}\n');

    const report = await verifyInstallation(home);
    const check = nonPassCheck(report, [relative, path]);

    expect(report.valid).toBe(false);
    expect(check, 'the invalid manifest shape must be reported').toBeDefined();
    expect(check!.status).not.toBe('pass');
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/install/i);
  });

  it('fails sync hook ownership without entries instead of throwing', async () => {
    const home = await installedHome(['claude']);
    const manifestRelative = '.config/ai-workflow/install-manifest.json';
    const manifestPath = join(home, manifestRelative);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { sync_hooks?: Record<string, unknown> };
    manifest.sync_hooks = { ...(manifest.sync_hooks ?? {}), claude: { kind: 'configuration', path: '.claude/settings.json' } };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = await verifyInstallation(home, ['claude']);
    const relative = '.claude/settings.json';
    const check = nonPassCheck(report, [relative, join(home, relative)]);

    expect(check, 'the invalid hook ownership must be reported against its settings path').toBeDefined();
    expect(check!.status).not.toBe('pass');
  });

  it('fails a null synchronization hook entry instead of throwing', async () => {
    const home = await installedHome(['claude']);
    const manifestRelative = '.config/ai-workflow/install-manifest.json';
    const manifestPath = join(home, manifestRelative);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { sync_hooks?: Record<string, unknown> };
    manifest.sync_hooks = {
      ...(manifest.sync_hooks ?? {}),
      claude: { kind: 'configuration', path: '.claude/settings.json', entries: [null] },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const report = await verifyInstallation(home, ['claude']);
    const relative = '.claude/settings.json';
    const check = nonPassCheck(report, [relative, join(home, relative)]);

    expect(check, 'the invalid hook entry must be reported against its settings path').toBeDefined();
    expect(check!.status).not.toBe('pass');
  });

  it('fails a modified managed file with its exact path and SHA', async () => {
    const home = await installedHome();
    const relative = '.agents/skills/git-message/SKILL.md';
    await writeFile(join(home, relative), 'tampered managed skill\n');

    const report = await verifyInstallation(home);
    const check = nonPassCheck(report, [relative, join(home, relative)]);

    expect(report.valid).toBe(false);
    expect(check, 'the modified managed file must be reported').toBeDefined();
    expect(['fail', 'warn']).toContain(check!.status);
    expectDigest(check!.detail);
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/install/i);
  });

  it('fails a missing owned plugin with its exact path', async () => {
    const home = await installedHome(['opencode']);
    const relative = '.config/opencode/plugins/ai-workflow-sync.js';
    await rm(join(home, relative));

    const report = await verifyInstallation(home, ['opencode']);
    const check = nonPassCheck(report, [relative, join(home, relative)]);

    expect(report.valid).toBe(false);
    expect(check, 'the missing plugin must be reported').toBeDefined();
    expect(check!.status).toBe('fail');
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/install/i);
  });

  it('fails a missing owned hook registration with its exact path and event', async () => {
    const home = await installedHome(['claude']);
    const relative = '.claude/settings.json';
    const path = join(home, relative);
    const settings = JSON.parse(await readFile(path, 'utf8')) as { hooks?: Record<string, unknown[]> };
    delete settings.hooks?.PreToolUse;
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);

    const report = await verifyInstallation(home, ['claude']);
    const check = nonPassCheck(report, [relative, path]);

    expect(report.valid).toBe(false);
    expect(check, 'the missing hook registration must be reported').toBeDefined();
    expect(check!.status).toBe('fail');
    expect(check!.detail).toMatch(/PreToolUse|hook/i);
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/install/i);
  });

  it('warns about a disabled hook configuration without changing it', async () => {
    const home = await installedHome(['claude']);
    const relative = '.claude/settings.json';
    const path = join(home, relative);
    const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    settings.disableAllHooks = true;
    const bytes = `${JSON.stringify(settings, null, 2)}\n`;
    await writeFile(path, bytes);

    const report = await verifyInstallation(home, ['claude']);
    const check = nonPassCheck(report, [relative, path]);

    expect(check, 'the disabled hook configuration must be reported').toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.detail).toMatch(/disabled/i);
    expectRecovery(check!);
    expect(await readFile(path, 'utf8'), 'verification must not rewrite disabling configuration').toBe(bytes);
  });

  it('fails an opencode host-scoped skills link pointing at a wrong directory, with a two-level relative recovery', async () => {
    const home = await installedHome(['opencode']);
    const other = await temporary('ai-workflow-install-verify-wrong-skills-');
    homes.push(other);
    await mkdir(join(other, 'sync-ai-workflow'), { recursive: true });
    await writeFile(join(other, 'sync-ai-workflow', 'SKILL.md'), '# other skills\n');
    const relative = '.config/opencode/skills';
    const path = join(home, relative);
    await rm(path, { force: true });
    await symlink(other, path, 'dir');

    const report = await verifyInstallation(home, ['opencode']);
    const check = report.checks.find((item) => item.id === 'install.skills-link.opencode');

    expect(report.valid).toBe(false);
    expect(check, 'the wrong opencode host-scoped skills link must be reported').toBeDefined();
    expect(check!.status).toBe('fail');
    expect(check!.recovery, 'the recovery command must name the two-level relative target').toContain('../../.agents/skills');
    expect(check!.recovery).not.toContain('ln -sfn ../.agents/skills');
  });

  it('fails a shared-skill link whose identity does not resolve to the shared skills tree', async () => {
    const home = await installedHome(['claude']);
    const other = await temporary('ai-workflow-other-skills-');
    homes.push(other);
    await mkdir(join(other, 'sync-ai-workflow'), { recursive: true });
    await writeFile(join(other, 'sync-ai-workflow', 'SKILL.md'), '# other skills\n');
    const relative = '.claude/skills';
    await rm(join(home, relative), { recursive: true, force: true });
    await symlink(other, join(home, relative), 'dir');

    const report = await verifyInstallation(home, ['claude']);
    const check = nonPassCheck(report, [relative, join(home, relative)]);

    expect(check, 'the mismatched shared-skill link must be reported').toBeDefined();
    expect(check!.status).not.toBe('pass');
    expect(check!.detail).toMatch(/\.agents\/skills|identity|resolved|->/i);
    expectRecovery(check!);
  });
});

describe('antigravity installation verification', () => {
  const antigravityHosts = ['antigravity'] as Host[];
  const roles = ['backend', 'documentation-maintainer', 'file-explorer', 'frontend', 'git-operator', 'researcher', 'spec-review', 'standards-review', 'test'];

  function expectPathFailure(report: InstallationReport, relative: string, home: string): Check {
    const check = report.checks.find((item) => item.status === 'fail' && (item.detail.includes(relative) || item.detail.includes(join(home, relative))));
    expect(check, `a fail check naming ${relative} must exist`).toBeDefined();
    expectRecovery(check!);
    return check!;
  }

  it('passes a healthy antigravity installation with stable check ids for every managed surface', async () => {
    const home = await installedHome(antigravityHosts);
    const before = await snapshotTree(home);

    const report = await verifyInstallation(home, antigravityHosts);
    const second = await verifyInstallation(home, antigravityHosts);
    const ids = report.checks.map((check) => check.id);

    expect(report.home).toBe(home);
    expect(report.valid, JSON.stringify(report.checks, null, 2)).toBe(true);
    for (const role of roles) {
      expect(ids, `the ${role} agent file must be checked`).toContain(`install.file..gemini/config/agents/${role}.md`);
    }
    expect(ids).toContain('install.contract.antigravity');
    const skillsEntry = report.checks.find((check) => check.detail.includes('.gemini/config/skills.json') && check.detail.includes('include_only'));
    expect(skillsEntry, 'the owned skills.json entry must be checked').toBeDefined();
    expect(skillsEntry!.status).toBe('pass');
    expect(skillsEntry!.detail).toContain('.agents/skills');
    const hookEntry = report.checks.find((check) => check.detail.includes('.gemini/config/hooks.json') && check.detail.includes('ai-workflow-sync'));
    expect(hookEntry, 'the named hook registration must be checked').toBeDefined();
    expect(hookEntry!.status).toBe('pass');
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.checks.map((check) => check.id)).toEqual(ids);
    expect(changedPaths(before, await snapshotTree(home)), 'verification must not write').toEqual([]);
  });

  it('fails a tampered .gemini/config/skills.json with its exact path and recovery', async () => {
    const home = await installedHome(antigravityHosts);
    const relative = '.gemini/config/skills.json';
    const path = join(home, relative);
    const data = JSON.parse(await readFile(path, 'utf8')) as { entries?: Array<{ path?: string; include_only?: string[] }> };
    const owned = data.entries?.find((entry) => typeof entry.path === 'string' && entry.path.includes('.agents/skills'));
    expect(owned, 'the installed skills.json must expose the owned entry').toBeDefined();
    owned!.include_only = ['tampered'];
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);

    const report = await verifyInstallation(home, antigravityHosts);

    expect(report.valid).toBe(false);
    expectPathFailure(report, relative, home);
  });

  it('fails a tampered .gemini/config/hooks.json with its exact path and recovery', async () => {
    const home = await installedHome(antigravityHosts);
    const relative = '.gemini/config/hooks.json';
    const path = join(home, relative);
    const data = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(data['ai-workflow-sync'], 'the installed hooks.json must expose the named hook').toBeDefined();
    delete data['ai-workflow-sync'];
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);

    const report = await verifyInstallation(home, antigravityHosts);

    expect(report.valid).toBe(false);
    expectPathFailure(report, relative, home);
  });

  it('fails a tampered .gemini/AGENTS.md contract with its exact path and recovery', async () => {
    const home = await installedHome(antigravityHosts);
    const relative = '.gemini/AGENTS.md';
    const path = join(home, relative);
    const contents = await readFile(path, 'utf8');
    expect(contents).toContain('<!-- ai-workflow:begin -->');
    await writeFile(path, contents.replace('<!-- ai-workflow:end -->', ''));

    const report = await verifyInstallation(home, antigravityHosts);

    expect(report.valid).toBe(false);
    expectPathFailure(report, relative, home);
  });

  it('fails a tampered antigravity agent file with its exact path and recovery', async () => {
    const home = await installedHome(antigravityHosts);
    const relative = '.gemini/config/agents/backend.md';
    await writeFile(join(home, relative), '# tampered agent\n');

    const report = await verifyInstallation(home, antigravityHosts);

    expect(report.valid).toBe(false);
    expectPathFailure(report, relative, home);
  });

  it('warns for a disabled ai-workflow-sync hook without rewriting .gemini/config/hooks.json', async () => {
    const home = await installedHome(antigravityHosts);
    const relative = '.gemini/config/hooks.json';
    const path = join(home, relative);
    const data = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const hook = data['ai-workflow-sync'] as Record<string, unknown> | undefined;
    expect(hook, 'the installed named hook must exist').toBeDefined();
    hook!['enabled'] = false;
    const bytes = `${JSON.stringify(data, null, 2)}\n`;
    await writeFile(path, bytes);

    const report = await verifyInstallation(home, antigravityHosts);
    const check = report.checks.find((item) => item.status === 'warn' && item.detail.includes(relative));

    expect(check, 'a disabled hook must produce a warning').toBeDefined();
    expect(check!.detail).toMatch(/disabled/i);
    expectRecovery(check!);
    expect(await readFile(path, 'utf8'), 'verification must not rewrite the disabling configuration').toBe(bytes);
  });

  it('passes a .gemini/config/skills symlink that resolves to the shared skills tree', async () => {
    const home = await installedHome(antigravityHosts);
    const relative = '.gemini/config/skills';
    const path = join(home, relative);
    await mkdir(join(home, '.gemini/config'), { recursive: true });
    await rm(path, { force: true });
    await symlink(join(home, '.agents/skills'), path, 'dir');

    const report = await verifyInstallation(home, antigravityHosts);
    const check = report.checks.find((item) => item.id === 'install.skills-link.antigravity');

    expect(check, 'a skills symlink must be checked').toBeDefined();
    expect(check!.status).toBe('pass');
  });

  it('fails a broken .gemini/config/skills symlink with its exact path and ln -sfn recovery', async () => {
    const home = await installedHome(antigravityHosts);
    const relative = '.gemini/config/skills';
    const path = join(home, relative);
    await mkdir(join(home, '.gemini/config'), { recursive: true });
    await rm(path, { force: true });
    await symlink(join(home, '.agents/skills-missing'), path, 'dir');

    const report = await verifyInstallation(home, antigravityHosts);
    const check = report.checks.find((item) => item.id === 'install.skills-link.antigravity');

    expect(report.valid).toBe(false);
    expect(check!.status).toBe('fail');
    expect(check!.detail).toContain(path);
    expect(check!.recovery).toContain('ln -sfn');
  });

  it('fails a .gemini/config/skills symlink pointing at a mismatched directory', async () => {
    const home = await installedHome(antigravityHosts);
    const other = await temporary('ai-workflow-antigravity-wrong-skills-');
    homes.push(other);
    await mkdir(join(other, 'sync-ai-workflow'), { recursive: true });
    await writeFile(join(other, 'sync-ai-workflow/SKILL.md'), '# other skills\n');
    const relative = '.gemini/config/skills';
    const path = join(home, relative);
    await mkdir(join(home, '.gemini/config'), { recursive: true });
    await rm(path, { force: true });
    await symlink(other, path, 'dir');

    const report = await verifyInstallation(home, antigravityHosts);
    const check = report.checks.find((item) => item.id === 'install.skills-link.antigravity');

    expect(report.valid).toBe(false);
    expect(check!.status).toBe('fail');
    expect(check!.detail).toContain(path);
    expect(check!.recovery).toContain('ln -sfn');
  });

  it('emits no skills-link check when .gemini/config/skills is absent or not a symlink', async () => {
    const home = await installedHome(antigravityHosts);
    const without = await verifyInstallation(home, antigravityHosts);
    expect(without.checks.some((item) => item.id === 'install.skills-link.antigravity')).toBe(false);

    const path = join(home, '.gemini/config/skills');
    await mkdir(path, { recursive: true });
    const withDirectory = await verifyInstallation(home, antigravityHosts);
    expect(withDirectory.checks.some((item) => item.id === 'install.skills-link.antigravity')).toBe(false);
  });
});
