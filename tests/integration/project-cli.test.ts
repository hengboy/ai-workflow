import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

describe('project CLI', () => {
  it('initializes the current directory when no project is provided', async () => {
    const project = await temporary('ai-workflow-project-cli-current-');

    await exec(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), join(process.cwd(), 'src/cli.ts'), 'init'], { cwd: project });

    expect(await exists(join(project, '.ai-workflow/project-manifest.json'))).toBe(true);
  });

  it('initializes a project with managed history and reports an unchanged update', async () => {
    const project = await temporary('ai-workflow-project-cli-');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);
    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'update', project]);

    expect(await exists(join(project, '.ai-workflow/project-manifest.json'))).toBe(true);
    expect(JSON.parse(stdout)).toMatchObject({
      updated: [],
      skipped: ['.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'],
      unchanged: ['AGENTS.md', 'CLAUDE.md', 'MEMORY.md']
    });
  });

  it('adds .ai-workflow/ to .gitignore on init', async () => {
    const project = await temporary('ai-workflow-project-cli-ignore-');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);

    const { readFile } = await import('node:fs/promises');
    const ignore = await readFile(join(project, '.gitignore'), 'utf8');
    const lines = ignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain('.ai-workflow/');
    expect(lines).toContain('*.log');
  });

  it('does not duplicate .ai-workflow entry if already present in .gitignore', async () => {
    const project = await temporary('ai-workflow-project-cli-ignore-dup-');
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(join(project, '.gitignore'), 'node_modules/\n.ai-workflow/\n');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);

    const ignore = await readFile(join(project, '.gitignore'), 'utf8');
    const matches = ignore.split(/\r?\n/).map((line) => line.trim()).filter((line) => line === '.ai-workflow' || line === '.ai-workflow/');
    expect(matches).toHaveLength(1);
  });
});
