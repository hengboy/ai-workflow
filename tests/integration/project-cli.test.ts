import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

describe('project CLI', () => {
  it('initializes the current directory with the .ai-workflow project contract and no root contract or manifest', async () => {
    const project = await temporary('ai-workflow-project-cli-current-');

    await exec(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), join(process.cwd(), 'src/cli.ts'), 'init'], { cwd: project });

    expect(await exists(join(project, '.ai-workflow/project-manifest.json'))).toBe(false);
    expect(await exists(join(project, 'AGENTS.md'))).toBe(false);
    expect(await exists(join(project, 'CLAUDE.md'))).toBe(false);
    expect(await exists(join(project, '.ai-workflow/AGENTS.md'))).toBe(true);
    expect(await exists(join(project, '.ai-workflow/index/navigation.json'))).toBe(true);
    expect(await exists(join(project, 'MEMORY.md'))).toBe(true);
  });

  it('rejects the removed update command as unknown (AC-011)', async () => {
    const project = await temporary('ai-workflow-project-cli-update-');
    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);

    const failure = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'update', project]).then(
      () => undefined,
      (error: unknown) => error as { code?: number; stderr?: string; stdout?: string; message?: string },
    );

    expect(failure).toBeDefined();
    expect(failure?.code).not.toBe(0);
    const output = `${failure?.stderr ?? ''}${failure?.stdout ?? ''}${failure?.message ?? ''}`;
    expect(output).toMatch(/unknown command/i);
    expect(output).toMatch(/update/i);
  });

  it('adds .ai-workflow/ to .gitignore on init', async () => {
    const project = await temporary('ai-workflow-project-cli-ignore-');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);

    const { readFile } = await import('node:fs/promises');
    const ignore = await readFile(join(project, '.gitignore'), 'utf8');
    const lines = ignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain('.ai-workflow/');
    expect(lines).toContain('*.log');
    expect(lines).toContain('MEMORY.md');
  });

  it('does not duplicate .ai-workflow or MEMORY.md entries if already present in .gitignore', async () => {
    const project = await temporary('ai-workflow-project-cli-ignore-dup-');
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(join(project, '.gitignore'), 'node_modules/\n.ai-workflow/\nMEMORY.md\n');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);

    const ignore = await readFile(join(project, '.gitignore'), 'utf8');
    const lines = ignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines.filter((line) => line === '.ai-workflow' || line === '.ai-workflow/')).toHaveLength(1);
    expect(lines.filter((line) => line === 'MEMORY.md')).toHaveLength(1);
  });
});
