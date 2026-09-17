import { describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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

  it('AC-012 preserves historical ADR files without treating them as current notes', async () => {
    const root = await temporary('ai-workflow-notes-historical-adr-');
    const historyPath = join(root, '.ai-workflow/adr/0001-history.md');
    const historyBytes = 'Status: accepted\n\nHistorical user data.\n';
    await mkdir(join(root, '.ai-workflow/adr'), { recursive: true });
    await writeFile(historyPath, historyBytes);

    await initializeProject(root);

    expect(await readFile(historyPath, 'utf8')).toBe(historyBytes);
    expect(await exists(join(root, '.ai-workflow/notes'))).toBe(true);
  });

  it('AC-014 removes this call\'s generated files and notes directories after a navigation write failure', async () => {
    const root = await temporary('ai-workflow-notes-init-recovery-');
    const blockerPath = join(root, '.ai-workflow/index');
    const blockerBytes = 'user file blocking navigation output\n';
    await mkdir(join(root, '.ai-workflow'), { recursive: true });
    await writeFile(blockerPath, blockerBytes);

    await expect(initializeProject(root)).rejects.toThrow();

    expect(await readFile(blockerPath, 'utf8')).toBe(blockerBytes);
    expect(await readdir(join(root, '.ai-workflow'))).toEqual(['index']);
    expect(await exists(join(root, 'MEMORY.md'))).toBe(false);
    expect(await exists(join(root, '.gitignore'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/AGENTS.md'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/notes'))).toBe(false);
  });

  it('AC-014 rejects a category path occupied by a user file before writing managed outputs', async () => {
    const root = await temporary('ai-workflow-notes-init-conflict-');
    const conflictPath = join(root, '.ai-workflow/notes/proposed/architecture');
    const conflictBytes = 'user file\n';
    await mkdir(join(root, '.ai-workflow/notes/proposed'), { recursive: true });
    await writeFile(conflictPath, conflictBytes);

    await expect(initializeProject(root)).rejects.toThrow(/conflict|no files written/i);

    expect(await readFile(conflictPath, 'utf8')).toBe(conflictBytes);
    expect(await exists(join(root, 'MEMORY.md'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/AGENTS.md'))).toBe(false);
  });
});
