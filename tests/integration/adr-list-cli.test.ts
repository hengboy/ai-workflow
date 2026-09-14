import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;

const EXPECTED = [
  '# ADR list',
  '',
  '| # | Status | Date | Supersedes | Superseded-by | Summary |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 0001 | accepted | 2026-01-01 | - | - | First decision |',
  '| 0002 | superseded-by | 2026-01-02 | - | ADR-0003 | Second decision |',
  '| 0003 | accepted | 2026-01-03 | ADR-0002 | - | Third decision |',
  '',
].join('\n');

async function fixture(): Promise<string> {
  const root = await temporary('ai-workflow-adr-list-');
  const directory = join(root, '.ai-workflow/adr');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '0003-third-decision.md'), '# 0003 Third decision\n\nStatus: accepted\nDate: 2026-01-03\nSummary: Third decision\nSupersedes: ADR-0002\n\n## Context\n\nThird.\n');
  await writeFile(join(directory, '0001-first-decision.md'), '# 0001 First decision\n\nStatus: accepted\nDate: 2026-01-01\nSummary: First decision\n\n## Context\n\nFirst.\n');
  await writeFile(join(directory, '0002-second-decision.md'), '# 0002 Second decision\n\nStatus: superseded-by ADR-0003\nDate: 2026-01-02\nSummary: Second decision\n\n## Context\n\nSecond.\n');
  await writeFile(join(directory, 'notes.md'), 'arbitrary notes\n');
  return root;
}

describe('adr list CLI', () => {
  it('prints a deterministic index derived from ADR headers and ignores non-ADR files', async () => {
    const project = await fixture();

    const { stdout } = await exec('pnpm', [...cli, 'adr', 'list', '--project', project]);

    expect(stdout.trimEnd()).toBe(EXPECTED.trimEnd());
    expect(stdout).not.toContain('notes');
  });

  it('writes no index file to disk', async () => {
    const project = await fixture();

    await exec('pnpm', [...cli, 'adr', 'list', '--project', project]);

    expect((await readdir(join(project, '.ai-workflow/adr'))).sort()).toEqual([
      '0001-first-decision.md',
      '0002-second-decision.md',
      '0003-third-decision.md',
      'notes.md',
    ]);
  });

  it('sorts entries by number regardless of file creation order', async () => {
    const project = await fixture();

    const first = (await exec('pnpm', [...cli, 'adr', 'list', '--project', project])).stdout;
    const second = (await exec('pnpm', [...cli, 'adr', 'list', '--project', project])).stdout;

    expect(first.trimEnd()).toBe(EXPECTED.trimEnd());
    expect(second).toBe(first);
  });

  it('prints an empty table for a project with no ADRs', async () => {
    const project = await temporary('ai-workflow-adr-empty-');

    const { stdout } = await exec('pnpm', [...cli, 'adr', 'list', '--project', project]);

    expect(stdout).toContain('# ADR list');
    expect(stdout).not.toContain('| 0001 |');
  });

  it('does not depend on a stored index even when one is left behind', async () => {
    const project = await fixture();
    await writeFile(join(project, '.ai-workflow/adr/INDEX.md'), '# hand-written stale index\n');

    const { stdout } = await exec('pnpm', [...cli, 'adr', 'list', '--project', project]);

    expect(stdout.trimEnd()).toBe(EXPECTED.trimEnd());
    expect(await readFile(join(project, '.ai-workflow/adr/INDEX.md'), 'utf8')).toBe('# hand-written stale index\n');
  });
});
