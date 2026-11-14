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
