import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeProject } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

const lifecycleDirectories = ['proposed', 'implemented', 'rejected', 'archived'] as const;
const noteClasses = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing'] as const;

describe('notes initialization', () => {
  it('AC-003 initializes a complete empty notes tree without notes or ADRs', async () => {
    const root = await temporary('ai-workflow-notes-init-');

    await initializeProject(root);

    const managementFiles = [
      '.ai-workflow/AGENTS.md',
      '.ai-workflow/notes/AGENTS.md',
      '.ai-workflow/notes/README.md',
      '.ai-workflow/notes/implemented/AGENTS.md',
      '.ai-workflow/notes/archived/AGENTS.md',
    ];
    for (const path of managementFiles) expect(await exists(join(root, path))).toBe(true);

    expect(JSON.parse(await readFile(join(root, '.ai-workflow/notes/archived/manifest.json'), 'utf8'))).toEqual({
      version: 1,
      files: {},
    });

    const categoryDirectories = lifecycleDirectories.flatMap((lifecycle) =>
      noteClasses.map((noteClass) => `${lifecycle}/${noteClass}`),
    );
    expect(categoryDirectories).toHaveLength(24);
    for (const path of categoryDirectories) expect(await exists(join(root, '.ai-workflow/notes', path))).toBe(true);

    expect(await exists(join(root, '.ai-workflow/adr'))).toBe(false);
    for (const lifecycle of lifecycleDirectories) {
      const entries = await readdir(join(root, '.ai-workflow/notes', lifecycle));
      const noteFiles = entries.filter((entry) => entry.endsWith('.md') && entry !== 'AGENTS.md');
      expect(noteFiles).toEqual([]);
    }
  });
});
