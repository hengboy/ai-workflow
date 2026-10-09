import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  commitFile,
  gitInit,
  realWorkspaceFixture,
  temporary,
  workspacePlanFixture,
  type WorkspacePlanFixtureSpec,
} from '../helpers.js';
import {
  commitChanges,
  commitExists,
  commitParents,
  gitCommonDirectory,
  scopeViolations,
  treeEntries,
  verifyDeliveryCommits,
  workingTreeStatus,
} from '../../src/workspace/git.js';
import { checkpointWorkspace } from '../../src/workspace/execution.js';

// Real-Git integration for the scoped repository lifecycle (REQ-002, REQ-004, REQ-005,
// REQ-006, REQ-008). These are scripted fixtures that drive only public helpers and real
// local Git; they do not claim native host execution.
const exec = promisify(execFile);
const TIMEOUT = 120_000;

type GitResult = { code: number; stdout: string; stderr: string };

async function git(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function outputOf(result: GitResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

async function headOf(repository: string): Promise<string> {
  const head = await git(['rev-parse', 'HEAD'], repository);
  expect(head.code, outputOf(head)).toBe(0);
  return head.stdout.trim();
}

const UNREACHABLE_SHA = '0123456789abcdef0123456789abcdef01234567';

describe('workspace identity and repository cleanliness (REQ-002)', () => {
  it('resolves a linked worktree to its source common directory, distinct from the parent root', async () => {
    const { root, repos } = await realWorkspaceFixture([{ name: 'app', path: 'packages/app' }]);
    const app = repos[0];
    if (!app) throw new Error('fixture is missing app');
    const worktreeParent = await temporary('ai-workflow-common-dir-');
    const worktree = join(worktreeParent, 'worktree');
    const added = await git(['worktree', 'add', worktree, '-b', 'ai-workflow-identity'], app.absolute);
    expect(added.code, outputOf(added)).toBe(0);

    try {
      const appCommon = await gitCommonDirectory(app.absolute);
      const worktreeCommon = await gitCommonDirectory(worktree);
      const rootCommon = await gitCommonDirectory(root);
      expect(appCommon, 'the child source resolves a common directory').toBeTruthy();
      expect(worktreeCommon, 'the linked worktree resolves a common directory').toBeTruthy();
      expect(rootCommon, 'the parent root resolves a common directory').toBeTruthy();
      expect(await realpath(worktreeCommon as string), 'the child worktree shares the child common directory').toBe(await realpath(appCommon as string));
      expect(await realpath(worktreeCommon as string), 'child identity is not the parent root identity').not.toBe(await realpath(rootCommon as string));

      // A decoy repository whose directory basename matches the child is still a different identity.
      const decoyParent = await temporary('ai-workflow-decoy-');
      const decoy = join(decoyParent, 'app');
      await mkdir(decoy, { recursive: true });
      await gitInit(decoy);
      const decoyCommon = await gitCommonDirectory(decoy);
      expect(decoyCommon, 'the decoy resolves a common directory').toBeTruthy();
      expect(await realpath(decoyCommon as string), 'a matching path name is not a matching identity').not.toBe(await realpath(appCommon as string));
    } finally {
      await git(['worktree', 'remove', '--force', worktree], app.absolute);
      await rm(worktreeParent, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('reads a clean source and treats dirty partial-phase output as a non-resumable state', async () => {
    const { root, repos } = await realWorkspaceFixture([{ name: 'app', path: 'packages/app' }]);
    const app = repos[0];
    if (!app) throw new Error('fixture is missing app');

    try {
      const clean = await workingTreeStatus(app.absolute);
      expect(clean?.trim(), 'the initialized child source is clean').toBe('');

      await writeFile(join(app.absolute, 'partial-task-output.ts'), 'export const pending = true;\n');
      const dirty = await workingTreeStatus(app.absolute);
      expect(dirty?.trim(), 'a dirty partial phase is not a clean resume boundary').toContain('partial-task-output.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe('scoped task commits and merge parentage (REQ-005)', () => {
  it('reads a rename change with both endpoints and flags the old endpoint as out of scope', async () => {
    const repository = await temporary('ai-workflow-scope-');
    try {
      await gitInit(repository);
      await commitFile(repository, 'src/old.ts', 'export const old = true;\n', 'add old');
      const moved = await git(['mv', 'src/old.ts', 'src/new.ts'], repository);
      expect(moved.code, outputOf(moved)).toBe(0);
      const committed = await git(['commit', '-m', 'rename old to new'], repository);
      expect(committed.code, outputOf(committed)).toBe(0);
      const sha = await headOf(repository);

      const changes = await commitChanges(repository, sha);
      expect(changes, 'the commit change set is readable').toBeDefined();
      const rename = (changes ?? []).find((change) => change.path === 'src/new.ts');
      expect(rename, 'the rename is reported at its new path').toBeDefined();
      expect(rename?.status.startsWith('R'), 'the rename status begins with R').toBe(true);
      expect(rename?.fromPath, 'the rename reports its old endpoint').toBe('src/old.ts');

      expect(scopeViolations(changes ?? [], ['src']), 'both rename endpoints inside src are in scope').toEqual([]);
      const violations = scopeViolations(changes ?? [], ['src/new.ts']);
      expect(violations.join('\n'), 'the old endpoint is outside the new-only scope').toContain('src/old.ts');
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('reads both merge parents after a non-fast-forward local merge and no parent for a root commit', async () => {
    const repository = await temporary('ai-workflow-merge-');
    try {
      await gitInit(repository);
      const rootCommit = await headOf(repository);
      expect(await commitParents(repository, rootCommit), 'a root commit has no parents').toEqual([]);

      await git(['checkout', '-b', 'feature'], repository);
      await commitFile(repository, 'feature.ts', 'export const feature = true;\n', 'feature change');
      const featureTip = await headOf(repository);
      await git(['checkout', 'main'], repository);
      await commitFile(repository, 'main.ts', 'export const main = true;\n', 'main change');
      const mainTip = await headOf(repository);

      const merged = await git(['merge', '--no-ff', 'feature', '-m', 'merge feature'], repository);
      expect(merged.code, outputOf(merged)).toBe(0);
      const mergeSha = await headOf(repository);
      const parents = await commitParents(repository, mergeSha);
      expect(parents, 'the merge commit resolves its parents').toBeDefined();
      expect(parents).toHaveLength(2);
      expect(parents).toContain(mainTip);
      expect(parents).toContain(featureTip);

      expect(await commitParents(repository, mainTip), 'a single-parent commit excludes itself').toEqual([rootCommit]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('confirms existing phase commits and rejects a fabricated SHA through commitExists', async () => {
    const repository = await temporary('ai-workflow-resume-');
    try {
      await gitInit(repository);
      const first = await commitFile(repository, 'phase1.ts', 'export const one = 1;\n', 'phase 1');
      const second = await commitFile(repository, 'phase2.ts', 'export const two = 2;\n', 'phase 2');

      expect((await workingTreeStatus(repository))?.trim(), 'the clean phase boundary has no residue').toBe('');
      expect(await commitExists(repository, first)).toBe(true);
      expect(await commitExists(repository, second)).toBe(true);
      expect(await commitExists(repository, UNREACHABLE_SHA)).toBe(false);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe('delivery batch preverification and final-tree pointers (REQ-008 / AC-010)', () => {
  it('preverifies a delivery batch read-only and reports a missing commit without staging anything', async () => {
    const { root, repos } = await realWorkspaceFixture([
      { name: 'app', path: 'packages/app' },
      { name: 'lib', path: 'packages/lib' },
    ]);
    const app = repos.find((repo) => repo.name === 'app');
    const lib = repos.find((repo) => repo.name === 'lib');
    if (!app || !lib) throw new Error('fixture is missing app or lib');

    try {
      const appSha = await commitFile(app.absolute, 'delivery.txt', 'app delivery\n', 'app delivery');
      const libSha = await commitFile(lib.absolute, 'delivery.txt', 'lib delivery\n', 'lib delivery');

      expect(await verifyDeliveryCommits([{ repository: app.absolute, sha: appSha }, { repository: lib.absolute, sha: libSha }])).toEqual([]);

      const before = await git(['status', '--porcelain'], root);
      const errors = await verifyDeliveryCommits([{ repository: app.absolute, sha: appSha }, { repository: lib.absolute, sha: UNREACHABLE_SHA }]);
      expect(errors.length, 'a missing batch member returns an error').toBeGreaterThan(0);
      expect(errors.join('\n')).toContain(UNREACHABLE_SHA);
      const after = await git(['status', '--porcelain'], root);
      expect(after.stdout, 'the read-only batch verification stages nothing').toBe(before.stdout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('pins exactly the checkpoint-recorded deliveries into the final tree via treeEntries', async () => {
    const planId = '20261009-workspace-coding-git';
    const workspaceRepo = { name: 'workspace', path: '.', dependsOn: [] as string[] };
    const appRepo = { name: 'app', path: 'packages/app', dependsOn: [] as string[] };
    const libRepo = { name: 'lib', path: 'packages/lib', dependsOn: [] as string[] };
    const spec: WorkspacePlanFixtureSpec = {
      planId,
      requirements: ['REQ-001', 'REQ-002'],
      acceptanceCriteria: ['AC-001', 'AC-002'],
      workspaceRepos: [workspaceRepo, appRepo, libRepo],
      tasks: [
        { id: 'task-001-app', repo: 'app', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/app.ts'] },
        { id: 'task-002-lib', repo: 'lib', requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/lib.ts'] },
      ],
      phases: [['task-001-app', 'task-002-lib']],
      manifest: {
        planId,
        role: 'workspace',
        repositories: [
          { ...workspaceRepo, requirements: [], acceptanceCriteria: [] },
          { ...appRepo, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] },
          { ...libRepo, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'] },
        ],
      },
    };

    const { root, repos } = await realWorkspaceFixture([
      { name: 'app', path: 'packages/app' },
      { name: 'lib', path: 'packages/lib' },
    ]);
    const app = repos.find((repo) => repo.name === 'app');
    const lib = repos.find((repo) => repo.name === 'lib');
    if (!app || !lib) throw new Error('fixture is missing app or lib');
    const planDirectory = await workspacePlanFixture(root, spec);
    const worktreeParent = await temporary('ai-workflow-final-tree-');
    const worktree = join(worktreeParent, 'workspace-wt');

    try {
      const appBase = await headOf(app.absolute);
      const appSha = await commitFile(app.absolute, 'delivery.txt', 'app delivery\n', 'app delivery');
      const libBase = await headOf(lib.absolute);
      const libSha = await commitFile(lib.absolute, 'delivery.txt', 'lib delivery\n', 'lib delivery');

      // Step 1 checkpoint integration: both slice deliveries are recorded before finalization.
      const start = (repository: string, base: string) => JSON.stringify({
        event: 'start', purpose: 'tasks', source_root: root, repository,
        worktree: join(root, '.worktrees', planId), branch: `ai-workflow/${planId}`, target_branch: 'main', base_commit: base,
      });
      const task = (id: string, commit: string) => JSON.stringify({ event: 'task', task: id, kind: 'commit', commit });
      for (const [repository, id, base, sha] of [
        ['app', 'task-001-app', appBase, appSha],
        ['lib', 'task-002-lib', libBase, libSha],
      ] as const) {
        expect((await checkpointWorkspace(planDirectory, repository, start(repository, base))).valid, `${repository} start`).toBe(true);
        expect((await checkpointWorkspace(planDirectory, repository, task(id, sha))).valid, `${repository} task`).toBe(true);
        expect((await checkpointWorkspace(planDirectory, repository, JSON.stringify({ event: 'reviewed', commit: sha }))).valid, `${repository} reviewed`).toBe(true);
        expect((await checkpointWorkspace(planDirectory, repository, JSON.stringify({ event: 'delivered', commit: sha }))).valid, `${repository} delivered`).toBe(true);
      }

      const rootBase = await headOf(root);
      const addedWorktree = await git(['worktree', 'add', worktree, '-b', `finalize-${planId}`], root);
      expect(addedWorktree.code, outputOf(addedWorktree)).toBe(0);
      expect((await git(['status', '--porcelain'], worktree)).stdout.trim(), 'the finalization worktree starts clean').toBe('');

      expect((await git(['update-index', '--cacheinfo', `160000,${appSha},packages/app`], worktree)).code).toBe(0);
      expect((await git(['update-index', '--cacheinfo', `160000,${libSha},packages/lib`], worktree)).code).toBe(0);
      const committed = await git(['commit', '-m', 'pin deliveries'], worktree);
      expect(committed.code, outputOf(committed)).toBe(0);
      const finalSha = await headOf(worktree);

      const entries = await treeEntries(worktree, finalSha, ['packages/app', 'packages/lib']);
      expect(entries, 'the final tree entries are readable').toBeDefined();
      const byPath = new Map((entries ?? []).map((entry) => [entry.path, entry]));
      const appEntry = byPath.get('packages/app');
      const libEntry = byPath.get('packages/lib');
      expect(appEntry?.mode, 'the app pointer is a gitlink').toBe('160000');
      expect(appEntry?.type, 'the app pointer is a commit').toBe('commit');
      expect(appEntry?.sha, 'the final tree pins the recorded app delivery').toBe(appSha);
      expect(libEntry?.sha, 'the final tree pins the recorded lib delivery').toBe(libSha);

      // The root finalization record reaches completed from the same parent session.
      const finalizationStart = JSON.stringify({
        event: 'start', purpose: 'finalization', source_root: root, repository: 'workspace',
        worktree: join(root, '.worktrees', planId), branch: `ai-workflow/${planId}`, target_branch: 'main', base_commit: rootBase,
      });
      expect((await checkpointWorkspace(planDirectory, 'workspace', finalizationStart)).valid, 'finalization start').toBe(true);
      expect((await checkpointWorkspace(planDirectory, 'workspace', JSON.stringify({ event: 'reviewed', commit: finalSha }))).valid, 'finalization reviewed').toBe(true);
      expect((await checkpointWorkspace(planDirectory, 'workspace', JSON.stringify({ event: 'finalized', commit: finalSha }))).valid, 'finalization finalized').toBe(true);
    } finally {
      await git(['worktree', 'remove', '--force', worktree], root);
      await rm(worktreeParent, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
