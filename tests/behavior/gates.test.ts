import { describe, expect, it } from 'vitest';
import { initializeProject, updateProject } from '../../src/install/index.js';
import { temporary } from '../helpers.js';
import { exists } from '../../src/utils/fs.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

describe('write gates', () => {
  it('initializes both JSON-authoritative navigation files', async () => {
    const root = await temporary();

    const created = await initializeProject(root);

    expect(created).toContain('.ai-workflow/index/navigation.json');
    expect(await exists(join(root, '.ai-workflow/index/navigation.json'))).toBe(true);
    expect(await exists(join(root, '.ai-workflow/index/navigation.md'))).toBe(true);
  });
  it('updates an initialized project without changing current managed templates', async () => {
    const root = await temporary();
    await initializeProject(root);

    const report = await updateProject(root);

    expect(report.updated).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.unchanged).toEqual([
      'AGENTS.md',
      'MEMORY.md',
      '.ai-workflow/index/navigation.json',
      '.ai-workflow/index/navigation.md',
      '.ai-workflow/config.yaml'
    ]);
  });
  it('skips a managed file that the project user changed', async () => {
    const root = await temporary();
    await initializeProject(root);
    await (await import('node:fs/promises')).writeFile(join(root, 'MEMORY.md'), 'project notes');

    const report = await updateProject(root);

    expect(report.skipped).toEqual(['MEMORY.md']);
    expect(await (await import('node:fs/promises')).readFile(join(root, 'MEMORY.md'), 'utf8')).toBe('project notes');
  });
  it('replaces an unmodified older managed template with the current template', async () => {
    const root = await temporary();
    const oldContents = 'old agents template\n';
    const currentContents = await (await import('node:fs/promises')).readFile(join(process.cwd(), 'templates/project/AGENTS.md'), 'utf8');
    await (await import('node:fs/promises')).mkdir(join(root, '.ai-workflow'), { recursive: true });
    await (await import('node:fs/promises')).writeFile(join(root, 'AGENTS.md'), oldContents);
    await (await import('node:fs/promises')).writeFile(join(root, '.ai-workflow/project-manifest.json'), JSON.stringify({
      version: 1,
      files: { 'AGENTS.md': `sha256:${createHash('sha256').update(oldContents).digest('hex')}` }
    }));

    const report = await updateProject(root);

    expect(report.updated).toEqual(['AGENTS.md']);
    expect(await (await import('node:fs/promises')).readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(currentContents);
  });
  it('rejects updates to a project without managed file history', async () => {
    const root = await temporary();
    await (await import('node:fs/promises')).writeFile(join(root, 'MEMORY.md'), 'existing project notes');

    await expect(updateProject(root)).rejects.toThrow(/Project update requires .ai-workflow\/project-manifest\.json/);
    expect(await exists(join(root, '.ai-workflow/project-manifest.json'))).toBe(false);
  });
  it('init preflights conflicts without partial writes', async () => { const root = await temporary(); const { writeFile } = await import('node:fs/promises'); await writeFile(join(root, 'MEMORY.md'), 'existing'); await expect(initializeProject(root)).rejects.toThrow(/no files written/); expect(await exists(join(root, 'AGENTS.md'))).toBe(false); expect(await exists(join(root, '.ai-workflow/config.yaml'))).toBe(false); });
  it('init reports merge content for every conflict', async () => { const root = await temporary(); const { writeFile } = await import('node:fs/promises'); await writeFile(join(root, 'MEMORY.md'), 'existing'); await expect(initializeProject(root)).rejects.toThrow(/MEMORY\.md.*---/s); });
});
