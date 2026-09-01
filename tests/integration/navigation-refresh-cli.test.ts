import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);
const navigation: NavigationIndex = {
  version: 1,
  module_roots: [{ id: 'workflow', path: 'src/workflow', owner_role: 'frontend', responsibility: 'workflow runtime', language: 'typescript', entry_kinds: ['exported-symbol'] }],
  features: [{
    id: 'workflow-parsing', name: 'workflow parsing', aliases: [], module_root: 'workflow',
    entries: ['src/workflow/parse.ts'],
    symbols: [
      { file: 'src/workflow/parse.ts', name: 'readPlan', kind: 'function', visibility: 'public' },
      { file: 'src/workflow/digest.ts', name: 'digestPlan', kind: 'function', visibility: 'public' }
    ],
    related_files: ['src/workflow/digest.ts'], tests: ['tests/unit/frozen-protocol.test.ts'], depends_on: [],
    relations: [{ kind: 'imports', from: 'src/workflow/parse.ts#readPlan', to: 'src/workflow/digest.ts#digestPlan' }],
    owner_role: 'frontend', responsibility: 'frozen-plan validation',
    read_scope: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/frozen-protocol.test.ts'], shared_entry: false
  }]
};

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    task_target: 'task-001-frozen-plan',
    authorized_module_roots: ['src/workflow', 'tests/unit'],
    changed_paths: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/frozen-protocol.test.ts'],
    maintenance_authorized: true,
    navigation,
    ...overrides
  };
}

async function projectWithIndex(): Promise<string> {
  const project = await temporary('ai-workflow-navigation-refresh-');
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, 'tests/unit'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'src/workflow/parse.ts'), 'import { digestPlan } from \'./digest.js\';\nexport function readPlan(): void { digestPlan(); }\n');
  await writeFile(join(project, 'src/workflow/digest.ts'), 'export function digestPlan(): void {}\n');
  await writeFile(join(project, 'tests/unit/frozen-protocol.test.ts'), '');
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), '{"version":1,"module_roots":[],"features":[]}\n');
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation({ version: 1, module_roots: [], features: [] }));
  return project;
}

async function writeCandidate(project: string, value: Record<string, unknown>, extension = 'json'): Promise<string> {
  const path = join(project, `.ai-workflow/candidate.${extension}`);
  await writeFile(path, extension === 'json' ? `${JSON.stringify(value)}\n` : '# candidate\n');
  return path;
}

describe('context refresh CLI', () => {
  it('atomically promotes an authorized JSON candidate with entries, symbols, relations and tests', async () => {
    const project = await projectWithIndex();
    const path = await writeCandidate(project, candidate());

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--candidate', path, '--write']);

    expect(JSON.parse(stdout)).toEqual({ updated: ['.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'] });
    await expect(readFile(join(project, '.ai-workflow/index/navigation.json'), 'utf8')).resolves.toBe(`${JSON.stringify(navigation, null, 2)}\n`);
    await expect(readFile(join(project, '.ai-workflow/index/navigation.md'), 'utf8')).resolves.toBe(renderNavigation(navigation));
  });

  it('writes a JSON-only candidate from an authorized module root', async () => {
    const project = await projectWithIndex();
    const output = join(project, '.ai-workflow/candidate.json');

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'candidate', '--project', project, '--output', output, '--task-target', 'task-001-navigation', '--root', 'src', '--path', 'src/workflow/parse.ts']);

    expect(JSON.parse(stdout)).toEqual({ candidate: output });
    await expect(readFile(output, 'utf8')).resolves.toContain('"maintenance_authorized": true');
  });

  it('leaves both formal index files unchanged when candidate validation fails', async () => {
    const project = await projectWithIndex();
    const path = await writeCandidate(project, candidate({ changed_paths: ['src/'] }));
    const jsonPath = join(project, '.ai-workflow/index/navigation.json');
    const markdownPath = join(project, '.ai-workflow/index/navigation.md');
    const before = await Promise.all([readFile(jsonPath, 'utf8'), readFile(markdownPath, 'utf8')]);

    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--candidate', path, '--write'])).rejects.toThrow(/exact regular file/i);

    await expect(Promise.all([readFile(jsonPath, 'utf8'), readFile(markdownPath, 'utf8')])).resolves.toEqual(before);
  });

  it('does not accept Markdown as a candidate input', async () => {
    const project = await projectWithIndex();
    const path = await writeCandidate(project, candidate(), 'md');
    const jsonPath = join(project, '.ai-workflow/index/navigation.json');
    const markdownPath = join(project, '.ai-workflow/index/navigation.md');
    const before = await Promise.all([readFile(jsonPath, 'utf8'), readFile(markdownPath, 'utf8')]);

    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--candidate', path, '--write'])).rejects.toThrow(/candidate must be a JSON file/i);

    await expect(Promise.all([readFile(jsonPath, 'utf8'), readFile(markdownPath, 'utf8')])).resolves.toEqual(before);
  });

  it('keeps the formal index directory unchanged when a staged file write fails', async () => {
    const project = await projectWithIndex();
    const path = await writeCandidate(project, candidate());
    const jsonPath = join(project, '.ai-workflow/index/navigation.json');
    const before = await readFile(jsonPath, 'utf8');
    await rm(join(project, '.ai-workflow/index/navigation.md'));
    await mkdir(join(project, '.ai-workflow/index/navigation.md'));

    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--candidate', path, '--write'])).rejects.toThrow();

    await expect(readFile(jsonPath, 'utf8')).resolves.toBe(before);
    expect((await lstat(join(project, '.ai-workflow/index/navigation.md'))).isDirectory()).toBe(true);
  });
});
