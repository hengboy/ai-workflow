import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

function navigation(): NavigationIndex {
  return {
    version: 1,
    module_roots: [{ id: 'workflow', path: 'src/workflow', owner_role: 'frontend', responsibility: 'workflow runtime', language: 'typescript', entry_kinds: ['exported-symbol'] }],
    features: [{
      id: 'workflow-parsing', name: 'workflow parsing', aliases: ['frozen plan digest', 'task-001-frozen-plan-digest'], module_root: 'workflow',
      entries: ['src/workflow/parse.ts'],
      symbols: [{ file: 'src/workflow/parse.ts', name: 'readPlan', kind: 'function', visibility: 'public' }],
      related_files: ['src/workflow/digest.ts'], tests: ['tests/unit/frozen-protocol.test.ts'], depends_on: [], relations: [],
      owner_role: 'frontend', responsibility: 'frozen-plan validation',
      read_scope: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/frozen-protocol.test.ts'], shared_entry: false,
      task_ids: ['task-001-frozen-plan-digest'], requirement_ids: ['REQ-001'], acceptance_criteria_ids: ['AC-001']
    }]
  };
}

async function projectWithNavigation(index = navigation(), parse = 'export function readPlan(): void {}\n'): Promise<string> {
  const project = await temporary('ai-workflow-navigation-locate-');
  await mkdir(join(project, 'src/workflow'), { recursive: true });
  await mkdir(join(project, 'tests/unit'), { recursive: true });
  await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
  await writeFile(join(project, 'src/workflow/parse.ts'), parse);
  await writeFile(join(project, 'src/workflow/digest.ts'), 'export function digestPlan(): void {}\n');
  await writeFile(join(project, 'tests/unit/frozen-protocol.test.ts'), '');
  await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
  await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));
  return project;
}

async function locate(project: string, ...query: string[]): Promise<unknown> {
  const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'locate', '--project', project, ...query]);
  return JSON.parse(stdout);
}

describe('context locate CLI', () => {
  it('returns a deterministic exact read order for a known feature', async () => {
    const project = await projectWithNavigation();

    await expect(locate(project, '--feature', 'workflow-parsing')).resolves.toEqual({
      status: 'hit', resolution_mode: 'index', feature: 'workflow-parsing', entries: ['src/workflow/parse.ts'],
      symbols: ['src/workflow/parse.ts#readPlan'], related_files: ['src/workflow/digest.ts'],
      tests: ['tests/unit/frozen-protocol.test.ts'],
      read_order: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/frozen-protocol.test.ts'], related_features: [], fallback_required: false
    });
  });

  it.each([
    ['task ID', 'task-001-frozen-plan-digest'],
    ['requirement ID', 'REQ-001'],
    ['acceptance criterion ID', 'AC-001'],
    ['pre-registered alias', 'frozen plan digest']
  ])('resolves an exact %s without scanning task files', async (_kind, query) => {
    const project = await projectWithNavigation();

    await expect(locate(project, '--task', query)).resolves.toMatchObject({ status: 'hit', feature: 'workflow-parsing', fallback_required: false });
  });

  it('returns ambiguous for a bare symbol with multiple indexed candidates', async () => {
    const index = navigation();
    index.features.push({
      ...index.features[0]!, id: 'workflow-secondary', name: 'workflow secondary', aliases: [], entries: ['src/workflow/secondary.ts'],
      symbols: [{ file: 'src/workflow/secondary.ts', name: 'readPlan', kind: 'function', visibility: 'public' }], related_files: [], tests: ['tests/unit/frozen-protocol.test.ts'],
      read_scope: ['src/workflow/secondary.ts', 'tests/unit/frozen-protocol.test.ts']
    });
    const project = await projectWithNavigation(index);
    await writeFile(join(project, 'src/workflow/secondary.ts'), 'export function readPlan(): void {}\n');
    await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));

    await expect(locate(project, '--symbol', 'readPlan')).resolves.toEqual({
      status: 'ambiguous', resolution_mode: 'index', candidates: ['src/workflow/parse.ts#readPlan', 'src/workflow/secondary.ts#readPlan'], fallback_required: false
    });
  });

  it('resolves a bare symbol when the index has one candidate', async () => {
    const project = await projectWithNavigation();

    await expect(locate(project, '--symbol', 'readPlan')).resolves.toMatchObject({
      status: 'hit', feature: 'workflow-parsing', symbols: ['src/workflow/parse.ts#readPlan'], fallback_required: false
    });
  });

  it('verifies a single bare symbol against its exact indexed feature', async () => {
    const project = await projectWithNavigation(navigation(), 'export function parsePlan(): void {}\n');

    await expect(locate(project, '--symbol', 'readPlan', '--verify')).resolves.toMatchObject({
      status: 'stale', resolution_mode: 'index', reason: 'Navigation index is stale: src/workflow/parse.ts no longer contains readPlan', fallback_required: true,
      fallback: { status: 'stale', target: { symbol: 'readPlan' }, known_paths: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/frozen-protocol.test.ts'], known_symbols: ['src/workflow/parse.ts#readPlan'], module_roots: ['src/workflow', 'tests/unit'], maintenance_authorized: false }
    });
  });

  it('returns a complete missing-index fallback packet without discovery', async () => {
    const project = await temporary('ai-workflow-navigation-missing-');

    await expect(locate(project, '--feature', 'workflow-parsing')).resolves.toMatchObject({
      status: 'missing_index', resolution_mode: 'index', fallback_required: true,
      fallback: { status: 'missing_index', target: { feature: 'workflow-parsing' }, reason: 'Missing .ai-workflow/index/navigation.json', known_paths: [], known_symbols: [], module_roots: [], maintenance_authorized: false }
    });
  });

  it('reports stale verification when a declared symbol is absent', async () => {
    const project = await projectWithNavigation(navigation(), 'export function parsePlan(): void {}\n');

    await expect(locate(project, '--feature', 'workflow-parsing', '--verify')).resolves.toMatchObject({ status: 'stale', fallback: { known_symbols: ['src/workflow/parse.ts#readPlan'], module_roots: ['src/workflow', 'tests/unit'] } });
  });

  it('reports stale verification when an indexed file is missing', async () => {
    const index = navigation();
    index.features[0]!.related_files = ['src/workflow/missing.ts'];
    index.features[0]!.read_scope = ['src/workflow/parse.ts', 'src/workflow/missing.ts', 'tests/unit/frozen-protocol.test.ts'];
    const project = await projectWithNavigation(index);
    await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));

    const result = await locate(project, '--feature', 'workflow-parsing', '--verify');

    expect(result).toMatchObject({ status: 'stale', reason: 'src/workflow/missing.ts: expected an exact regular file', fallback: { module_roots: ['src/workflow', 'tests/unit'] } });
    expect(result).toHaveProperty('fallback.known_paths');
    expect((result as { fallback: { known_paths: string[] } }).fallback.known_paths).toContain('src/workflow/missing.ts');
  });

  it('reports stale verification when the Markdown review view drifts from JSON', async () => {
    const project = await projectWithNavigation();
    await writeFile(join(project, '.ai-workflow/index/navigation.md'), 'drifted\n');

    await expect(locate(project, '--feature', 'workflow-parsing', '--verify')).resolves.toMatchObject({ status: 'stale', reason: 'Navigation index is stale: navigation.md does not match navigation.json', fallback: { module_roots: ['src/workflow', 'tests/unit'] } });
  });

  it('returns a complete miss fallback packet with only caller-authorized roots', async () => {
    const project = await projectWithNavigation();

    await expect(locate(project, '--feature', 'unknown-feature', '--root', 'src/workflow', '--maintain-index')).resolves.toMatchObject({
      status: 'miss', fallback: { status: 'miss', target: { feature: 'unknown-feature' }, module_roots: ['src/workflow'], maintenance_authorized: true, known_paths: [], known_symbols: [] }
    });
  });

  it('follows direct feature relations by depth without following dependencies', async () => {
    const index = navigation();
    index.features.push(
      {
        ...index.features[0]!, id: 'workflow-digest', name: 'workflow digest', aliases: [], entries: ['src/workflow/digest.ts'],
        symbols: [{ file: 'src/workflow/digest.ts', name: 'digestPlan', kind: 'function', visibility: 'public' }], related_files: [],
        tests: ['tests/unit/frozen-protocol.test.ts'], read_scope: ['src/workflow/digest.ts', 'tests/unit/frozen-protocol.test.ts'],
        task_ids: ['task-002-digest'], requirement_ids: ['REQ-002'], acceptance_criteria_ids: ['AC-002']
      },
      {
        ...index.features[0]!, id: 'workflow-output', name: 'workflow output', aliases: [], entries: ['src/workflow/output.ts'],
        symbols: [{ file: 'src/workflow/output.ts', name: 'writePlan', kind: 'function', visibility: 'public' }], related_files: [],
        tests: ['tests/unit/frozen-protocol.test.ts'], read_scope: ['src/workflow/output.ts', 'tests/unit/frozen-protocol.test.ts'],
        task_ids: ['task-003-output'], requirement_ids: ['REQ-003'], acceptance_criteria_ids: ['AC-003']
      }
    );
    index.features[0]!.relations = [{ kind: 'calls', from: 'src/workflow/parse.ts#readPlan', to: 'src/workflow/digest.ts#digestPlan' }];
    index.features[1]!.relations = [{ kind: 'calls', from: 'src/workflow/digest.ts#digestPlan', to: 'src/workflow/output.ts#writePlan' }];
    index.features[0]!.depends_on = ['workflow-output'];
    const project = await projectWithNavigation(index);
    await writeFile(join(project, 'src/workflow/output.ts'), 'export function writePlan(): void {}\n');
    await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));

    await expect(locate(project, '--feature', 'workflow-parsing', '--depth', '0')).resolves.toMatchObject({ related_features: [] });
    await expect(locate(project, '--feature', 'workflow-parsing', '--depth', '1')).resolves.toMatchObject({ related_features: ['workflow-digest'] });
    await expect(locate(project, '--feature', 'workflow-parsing', '--depth', '2')).resolves.toMatchObject({ related_features: ['workflow-digest', 'workflow-output'] });
  });
});
