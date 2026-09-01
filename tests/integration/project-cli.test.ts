import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

describe('project CLI', () => {
  it('initializes a project with managed history and reports an unchanged update', async () => {
    const project = await temporary('ai-workflow-project-cli-');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', project]);
    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'update', project]);

    expect(await exists(join(project, '.ai-workflow/project-manifest.json'))).toBe(true);
    expect(JSON.parse(stdout)).toMatchObject({
      updated: [],
      skipped: [],
      unchanged: ['AGENTS.md', 'MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md', '.ai-workflow/config.yaml']
    });
  });
});
