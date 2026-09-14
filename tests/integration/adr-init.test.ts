import { describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeProject } from '../../src/install/index.js';
import { temporary } from '../helpers.js';
import { exists } from '../../src/utils/fs.js';

describe('ADR lifecycle during project init and update', () => {
  it('AC-001 creates an empty local ADR directory without index, template or docs/adr', async () => {
    const root = await temporary();

    const created = await initializeProject(root);

    expect(created).toContain('.ai-workflow/adr');
    expect(await exists(join(root, '.ai-workflow/adr'))).toBe(true);
    expect((await readdir(join(root, '.ai-workflow/adr'))).length).toBe(0);
    expect(await exists(join(root, '.ai-workflow/adr/README.md'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/adr/template.md'))).toBe(false);
    expect(await exists(join(root, 'docs/adr'))).toBe(false);
    const ignoreLines = (await readFile(join(root, '.gitignore'), 'utf8')).split(/\r?\n/).map((line) => line.trim());
    expect(ignoreLines).toContain('.ai-workflow/');
  });

  it('AC-002 rejects init before any managed write when ADR files already exist', async () => {
    const root = await temporary();
    await mkdir(join(root, '.ai-workflow/adr'), { recursive: true });
    await writeFile(join(root, '.ai-workflow/adr/0001-record.md'), 'Status: accepted\n');

    const failure = await initializeProject(root).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/ADR/);
    expect(failure?.message).toMatch(/conflict|merge/i);
    expect(await exists(join(root, 'AGENTS.md'))).toBe(false);
    expect(await exists(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('AC-002 counterexample: an empty ADR directory is not a conflict', async () => {
    const root = await temporary();
    await mkdir(join(root, '.ai-workflow/adr'), { recursive: true });

    await expect(initializeProject(root)).resolves.toContain('.ai-workflow/adr');
  });

  it('AC-002 counterexample: a non-ADR file does not block init and is preserved', async () => {
    const root = await temporary();
    await mkdir(join(root, '.ai-workflow/adr'), { recursive: true });
    await writeFile(join(root, '.ai-workflow/adr/notes.md'), 'arbitrary user notes\n');

    await expect(initializeProject(root)).resolves.toBeDefined();
    expect(await exists(join(root, '.ai-workflow/adr/notes.md'))).toBe(true);
    expect(await readFile(join(root, '.ai-workflow/adr/notes.md'), 'utf8')).toBe('arbitrary user notes\n');
  });

  it('AC-003 / REQ-009 init leaves numbering undecided by keeping the ADR directory empty', async () => {
    const root = await temporary();
    await initializeProject(root);

    expect(await readdir(join(root, '.ai-workflow/adr'))).toEqual([]);
  });

  it('rolls back a newly created ADR directory when the init transaction fails', async () => {
    const root = await temporary();
    await mkdir(join(root, '.ai-workflow'), { recursive: true });
    await writeFile(join(root, '.ai-workflow/index'), 'not a directory\n');

    await expect(initializeProject(root)).rejects.toThrow();
    expect(await exists(join(root, '.ai-workflow/adr'))).toBe(false);
    expect(await exists(join(root, 'AGENTS.md'))).toBe(false);
  });
});
