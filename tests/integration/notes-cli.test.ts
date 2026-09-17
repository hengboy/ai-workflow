import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/install/index.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;
const notesFiles = [
  '.ai-workflow/AGENTS.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
  '.ai-workflow/notes/archived/manifest.json',
] as const;

async function noteBytes(root: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(notesFiles.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
}

describe('notes CLI', () => {
  it('AC-004 validates an initialized empty notes tree without changing its files', async () => {
    const project = await temporary('ai-workflow-notes-validate-');
    await initializeProject(project);
    const before = await noteBytes(project);

    const { stdout } = await exec('pnpm', [...cli, 'notes', 'validate', '--project', project]);

    expect(JSON.parse(stdout)).toEqual({ valid: true, errors: [] });
    expect(await noteBytes(project)).toEqual(before);
  });
});
