import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

async function discover(project: string, packet: Record<string, unknown>): Promise<unknown> {
  const path = join(project, 'fallback.json');
  await writeFile(path, `${JSON.stringify(packet)}\n`);
  const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'discover', '--project', project, '--packet', path]);
  return JSON.parse(stdout);
}

function packet(roots: string[]): Record<string, unknown> {
  return {
    status: 'miss',
    target: { feature: 'unknown-workflow-feature' },
    reason: 'No indexed feature matches the requested target',
    known_paths: [],
    known_symbols: [],
    module_roots: roots,
    maintenance_authorized: false,
    question: 'Which files and symbols satisfy unknown-workflow-feature?'
  };
}

describe('context fallback CLI', () => {
  it('does not expose a discovery packet for an index hit', async () => {
    const project = await temporary('ai-workflow-navigation-fallback-hit-');
    const index: NavigationIndex = {
      version: 1,
      module_roots: [{ id: 'workflow', path: 'src/workflow', owner_role: 'frontend', responsibility: 'workflow', language: 'typescript', entry_kinds: ['exported-symbol'] }],
      features: [{
        id: 'workflow-parsing', name: 'workflow parsing', aliases: [], module_root: 'workflow', entries: ['src/workflow/parse.ts'],
        symbols: [{ file: 'src/workflow/parse.ts', name: 'readPlan', kind: 'function', visibility: 'public' }], related_files: [], tests: ['tests/unit/workflow.test.ts'], depends_on: [], relations: [], owner_role: 'frontend', responsibility: 'workflow', read_scope: ['src/workflow/parse.ts', 'tests/unit/workflow.test.ts'], shared_entry: false
      }]
    };
    await mkdir(join(project, '.ai-workflow/index'), { recursive: true });
    await mkdir(join(project, 'src/workflow'), { recursive: true });
    await mkdir(join(project, 'tests/unit'), { recursive: true });
    await writeFile(join(project, 'src/workflow/parse.ts'), 'export function readPlan(): void {}\n');
    await writeFile(join(project, 'tests/unit/workflow.test.ts'), '');
    await writeFile(join(project, '.ai-workflow/index/navigation.json'), `${JSON.stringify(index)}\n`);
    await writeFile(join(project, '.ai-workflow/index/navigation.md'), renderNavigation(index));

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'locate', '--project', project, '--feature', 'workflow-parsing']);

    expect(JSON.parse(stdout)).toMatchObject({ status: 'hit', fallback_required: false });
    expect(JSON.parse(stdout)).not.toHaveProperty('fallback');
  });

  it('discovers only files inside packet-authorized roots', async () => {
    const project = await temporary('ai-workflow-navigation-fallback-discover-');
    await mkdir(join(project, 'src/allowed'), { recursive: true });
    await mkdir(join(project, 'src/private'), { recursive: true });
    await writeFile(join(project, 'src/allowed/entry.ts'), 'export const allowed = true;\n');
    await writeFile(join(project, 'src/private/secret.ts'), 'export const secret = true;\n');

    await expect(discover(project, packet(['src/allowed']))).resolves.toEqual({ status: 'discovered', searched_roots: ['src/allowed'], files: ['src/allowed/entry.ts'] });
  });

  it.each([
    ['no root', []],
    ['project root', ['.']]
  ])('blocks %s before discovery', async (_name, roots) => {
    const project = await temporary('ai-workflow-navigation-fallback-blocked-');
    await mkdir(join(project, 'src/allowed'), { recursive: true });
    await writeFile(join(project, 'src/allowed/entry.ts'), 'export const allowed = true;\n');
    const path = join(project, 'fallback.json');
    await writeFile(path, `${JSON.stringify(packet(roots))}\n`);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'discover', '--project', project, '--packet', path]);

    expect(JSON.parse(stdout)).toMatchObject({ status: 'blocked' });
  });

  it('blocks an out-of-project symlink root before discovery', async () => {
    const project = await temporary('ai-workflow-navigation-fallback-symlink-');
    const outside = await temporary('ai-workflow-navigation-outside-');
    await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(join(outside, 'outside.ts'), 'export const outside = true;\n');
    await symlink(outside, join(project, 'src/escape'));
    const path = join(project, 'fallback.json');
    await writeFile(path, `${JSON.stringify(packet(['src/escape']))}\n`);

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'discover', '--project', project, '--packet', path]);

    expect(JSON.parse(stdout)).toMatchObject({ status: 'blocked' });
  });
});
