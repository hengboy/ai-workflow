import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { readWorkspaceManifest } from '../../src/workflow/workspace.js';
import {
  changedPaths,
  realWorkspaceFixture,
  snapshotTree,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
} from '../helpers.js';

const exec = promisify(execFile);
const TIMEOUT = 90_000;
const PLAN_ID = '20260930-workspace-slice';
const OTHER_PLAN_ID = '20260930-workspace-other';

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args], { maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function outputOf(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function parseJson<T>(result: CliResult): T {
  expect(result.stdout.trim(), outputOf(result)).toMatch(/^\{/);
  return JSON.parse(result.stdout.trim()) as T;
}

function refusalErrors(result: CliResult): string {
  const parsed = parseJson<{ valid?: boolean; errors?: unknown }>(result);
  expect(parsed.valid, outputOf(result)).toBe(false);
  expect(Array.isArray(parsed.errors), outputOf(result)).toBe(true);
  return (parsed.errors as string[]).join('\n');
}

interface DistributeSlice { name: string; path: string; state: string }
interface DistributeOutput {
  valid: boolean;
  plan_id: string;
  workspace_root: string;
  slices: DistributeSlice[];
  workspace_root_entry: { name: string; path: string; state: string };
}

const WORKSPACE_REPO = { name: 'workspace' as const, path: '.', dependsOn: [] };
const APP_REPO = { name: 'app' as const, path: 'packages/app', dependsOn: [] };
const LIB_REPO = { name: 'lib' as const, path: 'packages/lib', dependsOn: ['app'] };

const PLANNING_FILES = ['spec.md', 'spec.zh.md', 'spec.i18n.yaml', 'plan.md', 'plan.zh.md', 'plan.i18n.yaml'] as const;

function taskSidecars(id: string): string[] {
  return [`${id}.md`, `${id}.zh.md`, `${id}.i18n.yaml`];
}

function baseSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-001', 'REQ-002', 'REQ-003'],
    acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003'],
    workspaceRepos: [WORKSPACE_REPO, APP_REPO, LIB_REPO],
    tasks: [
      { id: 'task-001-workspace', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/workspace.ts'] },
      { id: 'task-002-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
      { id: 'task-003-lib', repo: 'lib', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], writeScope: ['src/lib.ts'] },
    ],
    phases: [['task-001-workspace'], ['task-002-app'], ['task-003-lib']],
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { ...APP_REPO, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { ...LIB_REPO, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
      ],
    },
  };
}

/** A child-participating workspace plan with the optional `workspace_finalization` declaration. */
function finalizationSpec(): WorkspacePlanFixtureSpec {
  return {
    planId: PLAN_ID,
    requirements: ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-100'],
    acceptanceCriteria: ['AC-001', 'AC-002', 'AC-003', 'AC-100'],
    workspaceRepos: [WORKSPACE_REPO, APP_REPO, LIB_REPO],
    tasks: [
      { id: 'task-001-workspace', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/workspace.ts'] },
      { id: 'task-002-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
      { id: 'task-003-lib', repo: 'lib', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], writeScope: ['src/lib.ts'] },
    ],
    phases: [['task-001-workspace'], ['task-002-app'], ['task-003-lib']],
    workspaceFinalization: {
      requirements: ['REQ-100'],
      acceptanceCriteria: ['AC-100'],
      readScope: [{ repo: 'app', paths: ['src/app.ts'] }],
      writeScope: ['README.md'],
      testCommands: ['pnpm test'],
    },
    manifest: {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-001', 'REQ-100'], acceptanceCriteria: ['AC-001', 'AC-100'] },
        { ...APP_REPO, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { ...LIB_REPO, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
      ],
    },
  };
}

interface Workspace { root: string; directory: string; app: string; lib: string }

async function buildWorkspace(
  spec: WorkspacePlanFixtureSpec = baseSpec(),
  repoSpecs: { name: string; path: string; init?: boolean }[] = [
    { name: 'app', path: 'packages/app' },
    { name: 'lib', path: 'packages/lib' },
  ],
): Promise<Workspace> {
  const { root, repos } = await realWorkspaceFixture(repoSpecs);
  const directory = await workspacePlanFixture(root, spec);
  const app = repos.find((repo) => repo.name === 'app')?.absolute;
  const lib = repos.find((repo) => repo.name === 'lib')?.absolute;
  if (!app || !lib) throw new Error('fixture is missing app or lib');
  return { root, directory, app, lib };
}

function expectWorkspaceRoot(output: { workspace_root: string }, root: string, resolved: string): void {
  expect([root, resolved]).toContain(output.workspace_root);
}

describe('workspace distribute', () => {
  it('writes one slice per submodule, skips the reserved root entry and validates standalone', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const resolved = await realpath(root);
    const rootBefore = await snapshotTree(directory);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const output = parseJson<DistributeOutput>(result);
    expect(output.valid).toBe(true);
    expect(output.plan_id).toBe(PLAN_ID);
    expectWorkspaceRoot(output, root, resolved);
    expect(output.slices).toEqual([
      { name: 'app', path: 'packages/app', state: 'written' },
      { name: 'lib', path: 'packages/lib', state: 'written' },
    ]);
    expect(output.workspace_root_entry).toEqual({ name: 'workspace', path: '.', state: 'workspace-root' });

    const appSlice = join(app, '.ai-workflow/plans', PLAN_ID);
    const libSlice = join(lib, '.ai-workflow/plans', PLAN_ID);

    expect((await readdir(appSlice)).sort()).toEqual([...PLANNING_FILES, 'tasks', 'workspace.yaml'].sort());
    expect((await readdir(join(appSlice, 'tasks'))).sort()).toEqual(['execution-order.yaml', ...taskSidecars('task-002-app')].sort());
    expect((await readdir(libSlice)).sort()).toEqual([...PLANNING_FILES, 'tasks', 'workspace.yaml'].sort());
    expect((await readdir(join(libSlice, 'tasks'))).sort()).toEqual(['execution-order.yaml', ...taskSidecars('task-003-lib')].sort());

    for (const relativePath of [...PLANNING_FILES, ...taskSidecars('task-002-app').map((name) => `tasks/${name}`)]) {
      expect(await readFile(join(appSlice, relativePath))).toEqual(await readFile(join(directory, relativePath)));
    }
    for (const relativePath of [...PLANNING_FILES, ...taskSidecars('task-003-lib').map((name) => `tasks/${name}`)]) {
      expect(await readFile(join(libSlice, relativePath))).toEqual(await readFile(join(directory, relativePath)));
    }

    expect(await readWorkspaceManifest(appSlice)).toEqual({
      planId: PLAN_ID,
      role: 'slice',
      repositories: [{ name: 'app', path: 'packages/app', dependsOn: [], requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] }],
    });
    expect(await readWorkspaceManifest(libSlice)).toEqual({
      planId: PLAN_ID,
      role: 'slice',
      repositories: [{ name: 'lib', path: 'packages/lib', dependsOn: ['app'], requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] }],
    });

    const appSchedule = parseYaml(await readFile(join(appSlice, 'tasks/execution-order.yaml'), 'utf8')) as { plan_id: string; phases: { parallel: string[] }[] };
    expect(appSchedule.plan_id).toBe(PLAN_ID);
    expect(appSchedule.phases.map((phase) => phase.parallel)).toEqual([['task-002-app']]);
    const libSchedule = parseYaml(await readFile(join(libSlice, 'tasks/execution-order.yaml'), 'utf8')) as { plan_id: string; phases: { parallel: string[] }[] };
    expect(libSchedule.plan_id).toBe(PLAN_ID);
    expect(libSchedule.phases.map((phase) => phase.parallel)).toEqual([['task-003-lib']]);

    for (const slice of [appSlice, libSlice]) {
      const validated = await runCli(['plan', 'validate', '--plan', slice]);
      expect(validated.code, outputOf(validated)).toBe(0);
      expect(parseJson<{ valid: boolean }>(validated).valid).toBe(true);
    }

    // The reserved root entry keeps its workspace manifest and the whole workspace plan directory is untouched.
    expect((await readWorkspaceManifest(directory))?.role).toBe('workspace');
    expect(changedPaths(rootBefore, await snapshotTree(directory))).toEqual([]);
  }, TIMEOUT);

  it('reports unchanged and rewrites nothing on a second run', async () => {
    const { directory, app, lib } = await buildWorkspace();

    const first = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(first.code, outputOf(first)).toBe(0);

    const appSlice = join(app, '.ai-workflow/plans', PLAN_ID);
    const libSlice = join(lib, '.ai-workflow/plans', PLAN_ID);
    const before = new Map([...await snapshotTree(appSlice), ...await snapshotTree(libSlice)]);
    const frozen = new Date('2000-01-01T00:00:00.000Z');
    const frozenMtimes = new Map<string, number>();
    for (const slice of [appSlice, libSlice]) {
      for (const relativePath of (await snapshotTree(slice)).keys()) {
        const absolute = join(slice, relativePath);
        await utimes(absolute, frozen, frozen);
        frozenMtimes.set(absolute, (await stat(absolute)).mtimeMs);
      }
    }

    const second = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(second.code, outputOf(second)).toBe(0);
    const output = parseJson<DistributeOutput>(second);
    expect(output.slices).toEqual([
      { name: 'app', path: 'packages/app', state: 'unchanged' },
      { name: 'lib', path: 'packages/lib', state: 'unchanged' },
    ]);
    expect(changedPaths(before, new Map([...await snapshotTree(appSlice), ...await snapshotTree(libSlice)]))).toEqual([]);
    for (const [absolute, mtime] of frozenMtimes) {
      expect((await stat(absolute)).mtimeMs).toBe(mtime);
    }
  }, TIMEOUT);

  it('refuses the whole run on a divergent slice file and preserves the mutated bytes', async () => {
    const { root, directory, app, lib } = await buildWorkspace();
    const distributed = await runCli(['workspace', 'distribute', '--plan', directory]);
    expect(distributed.code, outputOf(distributed)).toBe(0);

    const mutatedPath = join(app, '.ai-workflow/plans', PLAN_ID, 'spec.md');
    const mutatedBytes = Buffer.concat([await readFile(mutatedPath), Buffer.from('\n<!-- divergent slice -->\n')]);
    await writeFile(mutatedPath, mutatedBytes);
    const before = await snapshotTree(root);

    const refused = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(refused.code, outputOf(refused)).toBe(1);
    expect(refusalErrors(refused)).toContain('Divergent slice file: app/spec.md');
    expect(await readFile(mutatedPath)).toEqual(mutatedBytes);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
    expect((await readWorkspaceManifest(join(lib, '.ai-workflow/plans', PLAN_ID)))?.role).toBe('slice');
  }, TIMEOUT);

  it('refuses a plan whose directory does not match the workspace plan shape', async () => {
    const { root, directory } = await buildWorkspace();
    const renamed = join(root, '.ai-workflow/plans', OTHER_PLAN_ID);
    await rename(directory, renamed);
    const before = await snapshotTree(root);

    const result = await runCli(['workspace', 'distribute', '--plan', renamed]);

    expect(result.code, outputOf(result)).toBe(1);
    const errors = refusalErrors(result);
    expect(errors).toContain('Workspace plan must live under');
    expect(errors).toContain(renamed);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('refuses a plan without a workspace-role manifest', async () => {
    const spec = baseSpec();
    delete spec.manifest;
    const { root, directory } = await buildWorkspace(spec);
    const before = await snapshotTree(root);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('workspace distribute requires a workspace manifest (role "workspace")');
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('refuses an invalid manifest before any repository check and writes nothing', async () => {
    const spec = baseSpec();
    spec.manifest = {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { ...APP_REPO, requirements: ['REQ-999'], acceptanceCriteria: ['AC-002'] },
        { ...LIB_REPO, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
      ],
    };
    const { root, directory } = await buildWorkspace(spec);
    const before = await snapshotTree(root);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(1);
    const errors = refusalErrors(result);
    expect(errors).toContain('REQ-999');
    expect(errors).not.toContain('is not a declared submodule');
    expect(errors).not.toContain('is not an initialized ai-workflow project');
    expect(errors).not.toContain('detached HEAD');
    expect(errors).not.toContain('has uncommitted changes');
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('reports a repository path that is not a declared submodule', async () => {
    const spec = baseSpec();
    spec.requirements = ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004'];
    spec.acceptanceCriteria = ['AC-001', 'AC-002', 'AC-003', 'AC-004'];
    spec.workspaceRepos = [WORKSPACE_REPO, APP_REPO, LIB_REPO, { name: 'ghost', path: 'packages/ghost', dependsOn: [] }];
    spec.tasks = [
      { id: 'task-001-workspace', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/workspace.ts'] },
      { id: 'task-002-app', repo: 'app', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
      { id: 'task-003-lib', repo: 'lib', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], writeScope: ['src/lib.ts'] },
      { id: 'task-004-ghost', repo: 'ghost', requirements: ['REQ-004'], acceptanceCriteria: ['AC-004'], writeScope: ['src/ghost.ts'] },
    ];
    spec.phases = [['task-001-workspace'], ['task-002-app'], ['task-003-lib'], ['task-004-ghost']];
    spec.manifest = {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { ...APP_REPO, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { ...LIB_REPO, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
        { name: 'ghost', path: 'packages/ghost', dependsOn: [], requirements: ['REQ-004'], acceptanceCriteria: ['AC-004'] },
      ],
    };
    const { root, directory } = await buildWorkspace(spec);
    const before = await snapshotTree(root);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain(`Repository "ghost" path "packages/ghost" is not a declared submodule of ${root}; declare it in .gitmodules or correct the plan's workspace_repos entry`);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('reports a repository whose name does not match the declared submodule', async () => {
    const spec = baseSpec();
    const frontend = { name: 'frontend', path: 'packages/app', dependsOn: [] };
    const libAfterFrontend = { name: 'lib', path: 'packages/lib', dependsOn: ['frontend'] };
    spec.workspaceRepos = [WORKSPACE_REPO, frontend, libAfterFrontend];
    spec.tasks = [
      { id: 'task-001-workspace', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/workspace.ts'] },
      { id: 'task-002-app', repo: 'frontend', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/app.ts'] },
      { id: 'task-003-lib', repo: 'lib', requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], writeScope: ['src/lib.ts'] },
    ];
    spec.manifest = {
      planId: PLAN_ID,
      role: 'workspace',
      repositories: [
        { ...WORKSPACE_REPO, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
        { ...frontend, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        { ...libAfterFrontend, requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'] },
      ],
    };
    const { root, directory } = await buildWorkspace(spec);
    const before = await snapshotTree(root);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain(`Repository "frontend" path "packages/app" does not match the declared submodule "app" at "packages/app"; correct the plan's workspace_repos entry to the declared submodule name`);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('reports an uninitialized participating repository', async () => {
    const { root, directory, app } = await buildWorkspace(baseSpec(), [
      { name: 'app', path: 'packages/app', init: false },
      { name: 'lib', path: 'packages/lib' },
    ]);
    const before = await snapshotTree(root);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain(`Repository "app" is not an initialized ai-workflow project at ${app}; run ai-workflow init ${app} --upgrade`);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('reports a detached HEAD', async () => {
    const { root, directory, app } = await buildWorkspace();
    await exec('git', ['-C', app, 'checkout', '--detach']);
    const before = await snapshotTree(root);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('Repository "app" is in detached HEAD; check out a branch before distributing');
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('reports an uncommitted working tree', async () => {
    const { root, directory, app } = await buildWorkspace();
    await writeFile(join(app, 'src/index.ts'), 'export const childEntry = false;\n');
    const before = await snapshotTree(root);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain('Repository "app" has uncommitted changes; commit or stash them before distributing');
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('reports a missing working tree for a declared submodule path', async () => {
    const { root, directory, lib } = await buildWorkspace();
    await rm(lib, { recursive: true, force: true });
    const before = await snapshotTree(root);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(1);
    expect(refusalErrors(result)).toContain(`Repository "lib" working tree is missing at ${lib}; run git submodule update --init`);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  }, TIMEOUT);

  it('distributes a finalization-declaring workspace without leaking finalization criteria into child slices', async () => {
    const { directory, app } = await buildWorkspace(finalizationSpec());

    const parentValidated = await runCli(['plan', 'validate', '--plan', directory]);
    expect(parentValidated.code, outputOf(parentValidated)).toBe(0);

    const result = await runCli(['workspace', 'distribute', '--plan', directory]);

    expect(result.code, outputOf(result)).toBe(0);
    const output = parseJson<DistributeOutput>(result);
    expect(output.valid).toBe(true);
    expect(output.slices).toEqual([
      { name: 'app', path: 'packages/app', state: 'written' },
      { name: 'lib', path: 'packages/lib', state: 'written' },
    ]);

    const appManifest = await readWorkspaceManifest(join(app, '.ai-workflow/plans', PLAN_ID));
    expect(appManifest?.role).toBe('slice');
    const appCriteria = (appManifest?.repositories ?? []).flatMap((repository) => [...repository.requirements, ...repository.acceptanceCriteria]);
    expect(appCriteria).not.toContain('REQ-100');
    expect(appCriteria).not.toContain('AC-100');

    const validated = await runCli(['plan', 'validate', '--plan', join(app, '.ai-workflow/plans', PLAN_ID)]);
    expect(validated.code, outputOf(validated)).toBe(0);
  }, TIMEOUT);
});
