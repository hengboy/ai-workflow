import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureWorktreeAudit,
  compareWorktreeAudits,
  isWorktreeQuarantined,
  quarantineWorktree,
} from '../../src/security/audit.js';
import { temporary } from '../helpers.js';

describe('full worktree audit', () => {
  it('detects every tree change, including hidden and ignored paths, without following symlinks', async () => {
    const root = await temporary('ai-workflow-audit-');
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'config'), '[core]\n');
    await writeFile(join(root, '.gitignore'), '.cache/\n');
    await writeFile(join(root, 'tracked.txt'), 'before\n');
    await writeFile(join(root, 'deleted.txt'), 'gone\n');
    await writeFile(join(root, 'mode.txt'), 'mode\n');
    await writeFile(join(root, 'target-before.txt'), 'target\n');
    await symlink('target-before.txt', join(root, 'link.txt'));
    await mkdir(join(root, '.cache'));
    await writeFile(join(root, '.cache', 'ignored.txt'), 'before\n');
    await writeFile(join(root, '.agent-hidden'), 'before\n');
    const before = await captureWorktreeAudit(root);

    await writeFile(join(root, 'tracked.txt'), 'after\n');
    await chmod(join(root, 'mode.txt'), 0o755);
    await mkdir(join(root, 'type-change'));
    await writeFile(join(root, 'type-change', 'child.txt'), 'directory now\n');
    await writeFile(join(root, 'new.txt'), 'untracked\n');
    await writeFile(join(root, '.cache', 'ignored.txt'), 'after\n');
    await writeFile(join(root, '.agent-hidden'), 'after\n');
    await writeFile(join(root, '.git', 'config'), '[core]\nrepositoryformatversion = 1\n');
    await symlink('target-after.txt', join(root, 'link-after.txt'));
    await writeFile(join(root, 'target-after.txt'), 'new target\n');
    await (await import('node:fs/promises')).rm(join(root, 'deleted.txt'));
    await (await import('node:fs/promises')).rm(join(root, 'link.txt'));

    const after = await captureWorktreeAudit(root);
    const comparison = compareWorktreeAudits(before, after, ['tracked.txt', 'mode.txt', 'type-change'], ['.ai-workflow/plans/plan/screenshot']);

    expect(comparison.status).toBe('audit_failed');
    expect(comparison.changed_paths).toEqual(expect.arrayContaining([
      'tracked.txt', 'deleted.txt', 'mode.txt', 'new.txt', '.cache/ignored.txt', '.agent-hidden', '.git/config', 'link.txt', 'link-after.txt', 'type-change', 'target-after.txt',
    ]));
    expect(comparison.out_of_scope_paths).toEqual(expect.arrayContaining(['new.txt', '.cache/ignored.txt', '.agent-hidden', '.git/config', 'link.txt', 'link-after.txt', 'target-after.txt']));
    expect(comparison.digest).not.toBe(before.digest);
    expect(comparison.followed_symlinks).toBe(false);
  });

  it('records mode and file type changes as path changes', async () => {
    const root = await temporary('ai-workflow-audit-');
    await writeFile(join(root, 'entry'), 'file\n');
    const before = await captureWorktreeAudit(root);
    await (await import('node:fs/promises')).rm(join(root, 'entry'));
    await mkdir(join(root, 'entry'));
    const after = await captureWorktreeAudit(root);

    expect(compareWorktreeAudits(before, after, ['entry']).changed_paths).toEqual(['entry']);
    expect(after.entries.entry?.type).toBe('directory');
  });

  it('quarantines a worktree after audit failure and exposes durable evidence', async () => {
    const root = await temporary('ai-workflow-audit-');
    const evidence = await quarantineWorktree(root, 'undeclared .git mutation');

    expect(evidence.reason).toBe('undeclared .git mutation');
    expect(evidence.marker).toBe('.ai-workflow/quarantine.json');
    expect(await isWorktreeQuarantined(root)).toBe(true);
    expect(JSON.parse(await readFile(join(root, evidence.marker), 'utf8'))).toMatchObject({ reason: evidence.reason });
    expect((await lstat(join(root, evidence.marker))).isFile()).toBe(true);
  });
});
