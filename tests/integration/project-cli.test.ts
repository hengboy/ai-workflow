import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

const generatedTargets = [
  '.ai-workflow/AGENTS.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
] as const;

describe('project CLI', () => {
  it('initializes the current directory with the five markerless generated documents, a local MEMORY skeleton and no root contract or manifest', async () => {
    const project = await temporary('ai-workflow-project-cli-current-');

    await exec(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), join(process.cwd(), 'src/cli.ts'), 'init'], { cwd: project });

    expect(await exists(join(project, '.ai-workflow/project-manifest.json'))).toBe(false);
    expect(await exists(join(project, 'AGENTS.md'))).toBe(false);
    expect(await exists(join(project, 'CLAUDE.md'))).toBe(false);

    // Exactly the five generated workflow documents are published, markerless and titled.
    for (const path of generatedTargets) {
      expect(await exists(join(project, path)), `${path} must be generated`).toBe(true);
      const contents = await readFile(join(project, path), 'utf8');
      expect(contents, `${path} must be markerless`).not.toMatch(/ai-workflow:section/);
      expect(contents, `${path} must carry a level-one title`).toMatch(/^# /m);
    }

    // Local MEMORY bootstrap, derived navigation and the empty archive manifest.
    expect(await exists(join(project, 'MEMORY.md'))).toBe(true);
    const memory = await readFile(join(project, 'MEMORY.md'), 'utf8');
    expect(memory, 'MEMORY must be local scaffolding without embedded workflow sections').not.toMatch(/ai-workflow:section/);
    expect(await exists(join(project, '.ai-workflow/index/navigation.json'))).toBe(true);
    expect(await exists(join(project, '.ai-workflow/index/navigation.md'))).toBe(true);
    expect(JSON.parse(await readFile(join(project, '.ai-workflow/notes/archived/manifest.json'), 'utf8'))).toEqual({ version: 1, files: {} });
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

  it('ignores only .ai-workflow/plans on init', async () => {
    const project = await temporary('ai-workflow-project-cli-ignore-');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);

    const ignore = await readFile(join(project, '.gitignore'), 'utf8');
    const lines = ignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain('.ai-workflow/plans/');
    expect(lines).toContain('.worktrees/');
    expect(lines).not.toContain('.ai-workflow/');
    expect(lines).not.toContain('MEMORY.md');
    expect(lines).not.toContain('*.log');
  });

  it('does not duplicate .ai-workflow/plans or .worktrees entries if already present in .gitignore', async () => {
    const project = await temporary('ai-workflow-project-cli-ignore-dup-');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(project, '.gitignore'), 'node_modules/\n.ai-workflow/plans/\n.worktrees/\n');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);

    const ignore = await readFile(join(project, '.gitignore'), 'utf8');
    const lines = ignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines.filter((line) => line === '.ai-workflow/plans' || line === '.ai-workflow/plans/')).toHaveLength(1);
    expect(lines.filter((line) => line === '.worktrees' || line === '.worktrees/')).toHaveLength(1);
  });

  it('migrates a legacy whole-tree .ai-workflow and MEMORY.md ignore to plans-only', async () => {
    const project = await temporary('ai-workflow-project-cli-ignore-legacy-');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(project, '.gitignore'), 'node_modules/\n.ai-workflow/\n*.log\nMEMORY.md\n');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);

    const ignore = await readFile(join(project, '.gitignore'), 'utf8');
    const lines = ignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).not.toContain('.ai-workflow');
    expect(lines).not.toContain('.ai-workflow/');
    expect(lines).not.toContain('MEMORY.md');
    expect(lines).toContain('.ai-workflow/plans/');
    expect(lines).toContain('.worktrees/');
    expect(lines).toContain('node_modules/');
    expect(lines).toContain('*.log');
  });
});
