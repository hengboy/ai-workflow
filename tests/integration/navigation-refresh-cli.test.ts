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

function navigationWithOtherRoot(): NavigationIndex {
  return {
    ...structuredClone(navigation),
    module_roots: [...navigation.module_roots, { id: 'other', path: 'src/other', owner_role: 'frontend', responsibility: 'other runtime', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [...navigation.features, {
      id: 'other-parsing', name: 'other parsing', aliases: [], module_root: 'other', entries: ['src/other/other.ts'],
      symbols: [{ file: 'src/other/other.ts', name: 'readOther', kind: 'function', visibility: 'public' }], related_files: [], tests: ['tests/unit/frozen-protocol.test.ts'], depends_on: [], relations: [],
      owner_role: 'frontend', responsibility: 'other validation', read_scope: ['src/other/other.ts', 'tests/unit/frozen-protocol.test.ts'], shared_entry: false
    }]
  };
}

async function projectWithIndex(index = navigation): Promise<string> {
  const project = await temporary('ai-workflow-navigation-refresh-');
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, 'tests/unit'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'src/workflow/parse.ts'), 'import { digestPlan } from \'./digest.js\';\nexport function readPlan(): void { digestPlan(); }\n');
  await writeFile(join(project, 'src/workflow/digest.ts'), 'export function digestPlan(): void {}\n');
  await writeFile(join(project, 'tests/unit/frozen-protocol.test.ts'), '');
  if (index.module_roots.some((root) => root.id === 'other')) {
    await mkdir(join(project, 'src/other'), { recursive: true });
    await writeFile(join(project, 'src/other/other.ts'), 'export function readOther(): void {}\n');
  }
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));
  return project;
}

async function writeCandidate(project: string, value: Record<string, unknown>, extension = 'json'): Promise<string> {
  const path = join(project, `.ai-workflow/candidate.${extension}`);
  await writeFile(path, extension === 'json' ? `${JSON.stringify(value)}\n` : '# candidate\n');
  return path;
}

function cliFrom(project: string, arguments_: string[]): Promise<{ stdout: string }> {
  const root = process.cwd();
  return exec(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), ...arguments_], { cwd: project });
}

describe('context refresh CLI', () => {
  it('preserves navigation outside the authorized module roots when generating a candidate', async () => {
    const project = await projectWithIndex(navigationWithOtherRoot());
    await writeFile(join(project, 'src/other/unclassified.ts'), 'export function unclassified(): void {}\n');

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'candidate', '--project', project, '--output', '.ai-workflow/candidate.json', '--task-target', 'task-001-navigation', '--root', 'src/workflow', '--path', 'src/workflow/parse.ts']);
    const generated = JSON.parse(await readFile(join(project, '.ai-workflow/candidate.json'), 'utf8')) as { navigation: NavigationIndex };

    expect(generated.navigation.features.find((feature) => feature.id === 'other-parsing')?.entries).toEqual(['src/other/other.ts']);
  });

  it('rejects candidate navigation changes outside the authorized module roots', async () => {
    const index = navigationWithOtherRoot();
    const project = await projectWithIndex(index);
    const changed = structuredClone(index);
    const other = changed.features.find((feature) => feature.id === 'other-parsing');
    if (!other) throw new Error('Test fixture must contain other-parsing');
    other.responsibility = 'unrelated change';
    const path = await writeCandidate(project, candidate({ authorized_module_roots: ['src/workflow'], navigation: changed }));

    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--candidate', path, '--write'])).rejects.toThrow(/other-parsing: changes outside authorized module roots/i);
  });

  it('uses the current project directory for --project . across candidate, refresh, validate and locate', async () => {
    const project = await projectWithIndex();

    await cliFrom(project, ['context', 'candidate', '--project', '.', '--output', '.ai-workflow/candidate.json', '--task-target', 'task-001-navigation', '--root', 'src/workflow', '--path', 'src/workflow/parse.ts']);
    expect((await cliFrom(project, ['context', 'refresh', '--project', '.', '--candidate', '.ai-workflow/candidate.json', '--write'])).stdout).toContain('navigation.json');
    expect((await cliFrom(project, ['context', 'validate', '--project', '.', '--all'])).stdout).toContain('"valid": true');
    expect((await cliFrom(project, ['context', 'locate', '--project', '.', '--feature', 'workflow-parsing', '--verify'])).stdout).toContain('"read_order"');
  });

  it('promotes a generated candidate from an absolute project path when its path is project-relative', async () => {
    const project = await projectWithIndex();

    await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'candidate', '--project', project, '--output', '.ai-workflow/candidate.json', '--task-target', 'task-001-navigation', '--root', 'src', '--path', 'src/workflow/parse.ts']);
    const generated = JSON.parse(await readFile(join(project, '.ai-workflow/candidate.json'), 'utf8')) as { navigation: NavigationIndex };
    expect(generated.navigation.features).toMatchObject([{ entries: ['src/workflow/digest.ts', 'src/workflow/parse.ts'] }]);
    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--candidate', '.ai-workflow/candidate.json', '--write']);

    expect(JSON.parse(stdout)).toEqual({ updated: ['.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'] });
  });

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

  it.each([
    ['a missing required changed_paths array', (() => { const value = candidate(); delete value.changed_paths; return value; })(), /candidate\.json: \/ must have required property 'changed_paths'/i],
    ['a non-array navigation features field', candidate({ navigation: { version: 1, module_roots: [], features: {} } }), /candidate\.json: \/navigation\/features must be array/i]
  ])('reports a field-path validation error for %s', async (_label, value, error) => {
    const project = await projectWithIndex();
    const path = await writeCandidate(project, value);

    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'refresh', '--project', project, '--candidate', path, '--write'])).rejects.toThrow(error);
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
