import { describe, expect, it } from 'vitest';
import { initializeProject } from '../../src/install/index.js';
import { temporary } from '../helpers.js';
import { exists } from '../../src/utils/fs.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('write gates', () => {
  it('initializes both JSON-authoritative navigation files', async () => {
    const root = await temporary();

    const created = await initializeProject(root);

    expect(created).toContain('.ai-workflow/index/navigation.json');
    expect(await exists(join(root, '.ai-workflow/index/navigation.json'))).toBe(true);
    expect(await exists(join(root, '.ai-workflow/index/navigation.md'))).toBe(true);
  });
  it('AC-001 initializes without writing or creating root-level contract files', async () => {
    const root = await temporary();

    const created = await initializeProject(root);

    expect(created).not.toContain('AGENTS.md');
    expect(created).not.toContain('CLAUDE.md');
    expect(await exists(join(root, 'AGENTS.md'))).toBe(false);
    expect(await exists(join(root, 'CLAUDE.md'))).toBe(false);
    expect(created).toContain('MEMORY.md');
    expect(created).toContain('.ai-workflow/index/navigation.json');
    expect(created).toContain('.ai-workflow/index/navigation.md');
    expect(await exists(join(root, 'MEMORY.md'))).toBe(true);
  });
  it('AC-002 initializes a project that already has a hand-written AGENTS.md and preserves it', async () => {
    const root = await temporary();
    const agentsBytes = '# Project agents\n\nHand-written constraints.\n';
    await writeFile(join(root, 'AGENTS.md'), agentsBytes);

    const created = await initializeProject(root);

    expect(created).not.toContain('AGENTS.md');
    expect(created).not.toContain('CLAUDE.md');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(agentsBytes);
    expect(await exists(join(root, 'MEMORY.md'))).toBe(true);
    const ignoreLines = (await readFile(join(root, '.gitignore'), 'utf8')).split(/\r?\n/).map((line) => line.trim());
    expect(ignoreLines).toContain('.ai-workflow/plans/');
    expect(ignoreLines).toContain('.worktrees/');
  });
  it('init preflights conflicts without partial writes', async () => {
    const root = await temporary();
    await writeFile(join(root, 'MEMORY.md'), 'existing');
    await expect(initializeProject(root)).rejects.toThrow(/no files written/);
    expect(await exists(join(root, 'AGENTS.md'))).toBe(false);
  });
  it('init reports merge content for every conflict', async () => {
    const root = await temporary();
    await writeFile(join(root, 'MEMORY.md'), 'existing');
    await expect(initializeProject(root)).rejects.toThrow(/MEMORY\.md.*---/s);
  });
});
