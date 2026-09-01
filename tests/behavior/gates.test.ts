import { describe, expect, it } from 'vitest';
import { initializeProject } from '../../src/install/index.js';
import { temporary } from '../helpers.js';
import { exists } from '../../src/utils/fs.js';
import { join } from 'node:path';

describe('write gates', () => {
  it('initializes both JSON-authoritative navigation files', async () => {
    const root = await temporary();

    const created = await initializeProject(root);

    expect(created).toContain('.ai-workflow/index/navigation.json');
    expect(await exists(join(root, '.ai-workflow/index/navigation.json'))).toBe(true);
    expect(await exists(join(root, '.ai-workflow/index/navigation.md'))).toBe(true);
  });
  it('init preflights conflicts without partial writes', async () => { const root = await temporary(); const { writeFile } = await import('node:fs/promises'); await writeFile(join(root, 'MEMORY.md'), 'existing'); await expect(initializeProject(root)).rejects.toThrow(/no files written/); expect(await exists(join(root, 'AGENTS.md'))).toBe(false); expect(await exists(join(root, '.ai-workflow/config.yaml'))).toBe(false); });
  it('init reports merge content for every conflict', async () => { const root = await temporary(); const { writeFile } = await import('node:fs/promises'); await writeFile(join(root, 'MEMORY.md'), 'existing'); await expect(initializeProject(root)).rejects.toThrow(/MEMORY\.md.*---/s); });
});
