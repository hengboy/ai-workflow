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
      read_scope: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/frozen-protocol.test.ts'], shared_entry: false
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
      read_order: ['src/workflow/parse.ts', 'src/workflow/digest.ts', 'tests/unit/frozen-protocol.test.ts'], fallback_required: false
    });
  });

  it('resolves an exact task alias without scanning task files', async () => {
    const project = await projectWithNavigation();

    await expect(locate(project, '--task', 'task-001-frozen-plan-digest')).resolves.toMatchObject({ status: 'hit', feature: 'workflow-parsing', fallback_required: false });
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

    await expect(locate(project, '--symbol', 'readPlan', '--verify')).resolves.toEqual({
      status: 'stale', resolution_mode: 'index', reason: 'Navigation index is stale: src/workflow/parse.ts no longer contains readPlan', fallback_required: true
    });
  });

  it('reports a missing navigation index without discovery', async () => {
    const project = await temporary('ai-workflow-navigation-missing-');

    await expect(locate(project, '--feature', 'workflow-parsing')).resolves.toEqual({ status: 'missing_index', resolution_mode: 'index', fallback_required: true });
  });

  it('reports stale verification when a declared symbol is absent', async () => {
    const project = await projectWithNavigation(navigation(), 'export function parsePlan(): void {}\n');

    await expect(locate(project, '--feature', 'workflow-parsing', '--verify')).resolves.toEqual({
      status: 'stale', resolution_mode: 'index', reason: 'Navigation index is stale: src/workflow/parse.ts no longer contains readPlan', fallback_required: true
    });
  });

  it('reports stale verification when an indexed file is missing', async () => {
    const index = navigation();
    index.features[0]!.related_files = ['src/workflow/missing.ts'];
    index.features[0]!.read_scope = ['src/workflow/parse.ts', 'src/workflow/missing.ts', 'tests/unit/frozen-protocol.test.ts'];
    const project = await projectWithNavigation(index);
    await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));

    await expect(locate(project, '--feature', 'workflow-parsing', '--verify')).resolves.toEqual({
      status: 'stale', resolution_mode: 'index', reason: 'src/workflow/missing.ts: expected an exact regular file', fallback_required: true
    });
  });

  it('reports stale verification when the Markdown review view drifts from JSON', async () => {
    const project = await projectWithNavigation();
    await writeFile(join(project, '.ai-workflow/index/navigation.md'), 'drifted\n');

    await expect(locate(project, '--feature', 'workflow-parsing', '--verify')).resolves.toEqual({
      status: 'stale', resolution_mode: 'index', reason: 'Navigation index is stale: navigation.md does not match navigation.json', fallback_required: true
    });
  });
});
