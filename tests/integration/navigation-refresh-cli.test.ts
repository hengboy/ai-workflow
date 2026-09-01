import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);
const navigation = {
  version: 1,
  module_roots: [{ id: 'workflow', path: 'src/workflow', owner_role: 'frontend', responsibility: 'workflow runtime', language: 'typescript', entry_kinds: ['exported-symbol'] }],
  features: [{
    id: 'workflow-parsing', name: 'workflow parsing', aliases: ['frozen plan digest'], module_root: 'workflow',
    entries: ['src/workflow/parse.ts'],
    symbols: [{ file: 'src/workflow/parse.ts', name: 'readPlan', kind: 'function', visibility: 'public' }],
    related_files: ['src/workflow/digest.ts'], tests: ['tests/unit/frozen-protocol.test.ts'], depends_on: [], relations: [],
    owner_role: 'frontend', responsibility: 'frozen-plan validation',
    read_scope: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/frozen-protocol.test.ts'], shared_entry: false
  }]
};

const expectedMarkdown = `# Feature navigation

| Feature | Entries | Public Symbols | Related Files | Tests | Read Scope | Owner | Responsibility |
| --- | --- | --- | --- | --- | --- | --- | --- |
| workflow parsing | src/workflow/parse.ts | src/workflow/parse.ts#readPlan | src/workflow/digest.ts | tests/unit/frozen-protocol.test.ts | src/workflow/parse.ts, src/workflow/digest.ts, tests/unit/frozen-protocol.test.ts | frontend | frozen-plan validation |
`;

async function projectWithIndex(index: unknown = navigation): Promise<string> {
  const project = await temporary('ai-workflow-navigation-refresh-');
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, 'tests/unit'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'src/workflow/parse.ts'), 'export function readPlan(): void {}\n');
  await writeFile(join(project, 'src/workflow/digest.ts'), 'export function digestPlan(): void {}\n');
  await writeFile(join(project, 'tests/unit/frozen-protocol.test.ts'), '');
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), 'outdated\n');
  return project;
}

describe('context refresh CLI', () => {
  it('writes deterministic Markdown from a valid navigation JSON index', async () => {
    const project = await projectWithIndex();

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--write']);

    expect(JSON.parse(stdout)).toEqual({ updated: ['.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'] });
    await expect(readFile(join(project, '.ai-workflow/index/navigation.md'), 'utf8')).resolves.toBe(expectedMarkdown);
  });

  it('leaves both index files unchanged when the candidate JSON fails validation', async () => {
    const project = await projectWithIndex({ ...navigation, features: [{ ...navigation.features[0], read_scope: ['src/'] }] });
    const jsonPath = join(project, '.ai-workflow/index/navigation.json');
    const markdownPath = join(project, '.ai-workflow/index/navigation.md');
    const before = await Promise.all([readFile(jsonPath, 'utf8'), readFile(markdownPath, 'utf8')]);

    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--write'])).rejects.toThrow(/exact regular file/i);

    await expect(Promise.all([readFile(jsonPath, 'utf8'), readFile(markdownPath, 'utf8')])).resolves.toEqual(before);
  });

  it('restores navigation JSON when writing the derived Markdown fails', async () => {
    const project = await projectWithIndex();
    const jsonPath = join(project, '.ai-workflow/index/navigation.json');
    const markdownPath = join(project, '.ai-workflow/index/navigation.md');
    const before = await readFile(jsonPath, 'utf8');
    await rm(markdownPath);
    await mkdir(markdownPath);

    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--write'])).rejects.toThrow();

    await expect(readFile(jsonPath, 'utf8')).resolves.toBe(before);
    expect((await lstat(markdownPath)).isDirectory()).toBe(true);
  });
});
