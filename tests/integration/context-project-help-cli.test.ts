import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

describe('context CLI project help', () => {
  it.each(['validate', 'refresh', 'candidate', 'locate', 'discover'])('describes --project as a project root directory path for context %s', async (command) => {
    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', command, '--help']);

    expect(stdout).toContain('project root directory path; use . or an absolute path');
  });
});
