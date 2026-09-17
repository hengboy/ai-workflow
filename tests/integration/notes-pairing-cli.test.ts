import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/install/index.js';
import { englishSwitcher, metaPathOf, zhPathOf } from '../../src/notes/pairing.js';
import { temporary, writeNoteTriplet } from '../helpers.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;
const notePath = '.ai-workflow/notes/proposed/feature/2026-09-17-pairing-cli.md';

const noteBody = `# Agent Note: pairing-cli

Status: proposed

## Problem

The pairing CLI needs an observable contract.

## Proposal

Check, list and record note pairs.

## Alternatives considered

- Manual hash comparison was declined because it is error-prone.

## Acceptance criteria

- The CLI reports each pair state.

## Risks

- A stale record could hide a divergence.
`;

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', [...cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function fixture(prefix: string): Promise<{ root: string; files: { english: string; chinese: string; meta: string } }> {
  const root = await temporary(prefix);
  await initializeProject(root);
  const files = await writeNoteTriplet(root, notePath, noteBody);
  return { root, files };
}

describe('notes pairing CLI', () => {
  it('verifies a consistent triplet with exit 0 and reports every pair as ok', async () => {
    const { root } = await fixture('ai-workflow-pairing-ok-');

    const verified = await runCli(['notes', 'pairing', '--project', root]);
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout)).toEqual({ valid: true, errors: [] });

    const listed = await runCli(['notes', 'pairing', '--project', root, '--list']);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({ entries: [{ path: notePath, state: 'ok' }] });
  });

  it('reports missing counterparts and stale records without failing --list', async () => {
    const { root, files } = await fixture('ai-workflow-pairing-state-');
    await writeFile(join(root, zhPathOf(notePath)), `${files.chinese}Extra prose.\n`);

    const listed = await runCli(['notes', 'pairing', '--project', root, '--list']);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({ entries: [{ path: notePath, state: 'out-of-sync' }] });

    const missing = await temporary('ai-workflow-pairing-missing-');
    await initializeProject(missing);
    await writeNoteTriplet(missing, notePath, noteBody);
    await rm(join(missing, zhPathOf(notePath)));

    const missingList = await runCli(['notes', 'pairing', '--project', missing, '--list']);
    expect(JSON.parse(missingList.stdout)).toEqual({ entries: [{ path: notePath, state: 'missing' }] });
  });

  it('fails verification with a nonzero exit and names the stale record', async () => {
    const { root, files } = await fixture('ai-workflow-pairing-stale-');
    await writeFile(join(root, notePath), `${files.english}Extra prose.\n`);

    const verified = await runCli(['notes', 'pairing', '--project', root]);

    expect(verified.code).toBe(1);
    const parsed = JSON.parse(verified.stdout) as { valid: boolean; errors: string[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`${metaPathOf(notePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*hash`)),
    ]));
  });

  it('rejects a missing language switcher and a diverging structure', async () => {
    const switcher = await fixture('ai-workflow-pairing-switcher-');
    await writeFile(join(switcher.root, notePath), switcher.files.english.replace(`${englishSwitcher(notePath)}\n\n`, ''));

    const switcherResult = await runCli(['notes', 'pairing', '--project', switcher.root]);
    expect(switcherResult.code).toBe(1);
    expect((JSON.parse(switcherResult.stdout) as { errors: string[] }).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/language switcher/),
    ]));

    const structure = await fixture('ai-workflow-pairing-structure-');
    await writeFile(join(structure.root, zhPathOf(notePath)), `${structure.files.chinese}\n### Extra heading\n\nExtra prose.\n`);

    const structureResult = await runCli(['notes', 'pairing', '--project', structure.root]);
    expect(structureResult.code).toBe(1);
    expect((JSON.parse(structureResult.stdout) as { errors: string[] }).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/heading \(depth\)/),
    ]));
  });

  it('records a named pair from any of its three files and makes verification pass', async () => {
    const { root } = await fixture('ai-workflow-pairing-write-');
    await writeFile(join(root, metaPathOf(notePath)), '');
    expect((await runCli(['notes', 'pairing', '--project', root])).code).toBe(1);

    const written = await runCli(['notes', 'pairing', '--project', root, '--write', zhPathOf(notePath)]);

    expect(written.code).toBe(0);
    expect(JSON.parse(written.stdout)).toEqual({ written: [notePath] });
    expect(await readFile(join(root, metaPathOf(notePath)), 'utf8')).toContain('2026-09-17-pairing-cli.zh.md: ');
    expect((await runCli(['notes', 'pairing', '--project', root])).code).toBe(0);
  });

  it('re-records every complete pair with --write --all', async () => {
    const { root, files } = await fixture('ai-workflow-pairing-all-');
    await writeFile(join(root, notePath), `${files.english}Extra prose.\n`);

    const written = await runCli(['notes', 'pairing', '--project', root, '--write', '--all']);

    expect(written.code).toBe(0);
    expect(JSON.parse(written.stdout)).toEqual({ written: [notePath] });
    expect((await runCli(['notes', 'pairing', '--project', root])).code).toBe(0);
  });

  it('rejects invalid flag combinations and missing counterparts', async () => {
    const { root } = await fixture('ai-workflow-pairing-args-');

    const bareWrite = await runCli(['notes', 'pairing', '--project', root, '--write']);
    expect(bareWrite.code).not.toBe(0);
    expect(bareWrite.stderr).toMatch(/--write requires/);

    const listWithPaths = await runCli(['notes', 'pairing', '--project', root, '--list', notePath]);
    expect(listWithPaths.code).not.toBe(0);
    expect(listWithPaths.stderr).toMatch(/--list takes no other/);

    const allWithoutWrite = await runCli(['notes', 'pairing', '--project', root, '--all']);
    expect(allWithoutWrite.code).not.toBe(0);
    expect(allWithoutWrite.stderr).toMatch(/--all only applies/);

    const missingChinese = await temporary('ai-workflow-pairing-no-zh-');
    await initializeProject(missingChinese);
    await writeNoteTriplet(missingChinese, notePath, noteBody);
    await rm(join(missingChinese, zhPathOf(notePath)));
    const writeMissing = await runCli(['notes', 'pairing', '--project', missingChinese, '--write', notePath]);
    expect(writeMissing.code).not.toBe(0);
    expect(writeMissing.stderr).toMatch(/Chinese counterpart/);
  });
});
