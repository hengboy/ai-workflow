import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { packagePath } from '../../src/utils/schema.js';
import { realWorkspaceFixture } from '../helpers.js';

const exec = promisify(execFile);
const TIMEOUT = 120_000;
const PIN_COMMAND = 'git update-index --cacheinfo 160000,<sha>,<path>';
const EXISTENCE_CHECK = 'git cat-file -e';
const UNREACHABLE_SHA = '0123456789abcdef0123456789abcdef01234567';

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

const deliveryCommand = (checkout: string, sha: string): string[] => ['-C', checkout, 'cat-file', '-e', `${sha}^{commit}`];

/**
 * The documented finalization procedure for one pointer: verify the delivery commit
 * read-only in its source repository first, then run the index-only pin. An unreachable
 * commit returns before `update-index` ever runs.
 */
async function finalizePointer(worktree: string, checkout: string, sha: string, path: string): Promise<'pinned' | 'unreachable'> {
  const exists = await git(deliveryCommand(checkout, sha));
  if (exists.code !== 0) return 'unreachable';
  const pinned = await git(['-C', worktree, 'update-index', '--cacheinfo', `160000,${sha},${path}`]);
  if (pinned.code !== 0) throw new Error(`pin failed for ${path}: ${outputOf(pinned)}`);
  return 'pinned';
}

describe('workspace finalization pins delivery commits with real Git (REQ-009 / AC-018, AC-019)', () => {
  it('runs the documented pointer procedure and stops before update-index for an unreachable commit', async () => {
    // 1. The Git Operator documents the exact pin command and an existence check that
    //    runs before it. This assertion is the RED anchor against the unmodified template.
    const operator = await readFile(packagePath('templates', 'agents', 'git-operator.md'), 'utf8');
    expect(operator, 'the git-operator agent documents the exact pin command').toContain(PIN_COMMAND);
    expect(operator, 'the git-operator agent documents the existence check').toContain(EXISTENCE_CHECK);
    const checkAt = operator.indexOf(EXISTENCE_CHECK);
    const pinAt = operator.indexOf(PIN_COMMAND);
    expect(checkAt, 'the existence check is documented before the pin command').toBeGreaterThanOrEqual(0);
    expect(pinAt, 'the pin command is documented after the existence check').toBeGreaterThan(checkAt);

    // 2. A real two-submodule workspace.
    const { root, repos } = await realWorkspaceFixture([
      { name: 'app', path: 'packages/app' },
      { name: 'lib', path: 'packages/lib' },
    ]);
    const worktreeParent = await mkdtemp(join(tmpdir(), 'ai-workflow-finalize-'));
    const worktree = join(worktreeParent, 'workspace-wt');

    try {
      // 3. Create a delivery commit inside each submodule working tree and read its SHA.
      const delivery = new Map<string, { sha: string; path: string; checkout: string }>();
      for (const repo of repos) {
        await git(['config', 'user.email', 'test@example.com'], repo.absolute);
        await git(['config', 'user.name', 'Test'], repo.absolute);
        await git(['config', 'commit.gpgsign', 'false'], repo.absolute);
        await writeFile(join(repo.absolute, 'delivery.txt'), `delivery ${repo.name}\n`);
        const added = await git(['add', 'delivery.txt'], repo.absolute);
        expect(added.code, outputOf(added)).toBe(0);
        const committed = await git(['commit', '-m', `delivery ${repo.name}`], repo.absolute);
        expect(committed.code, outputOf(committed)).toBe(0);
        const head = await git(['rev-parse', 'HEAD'], repo.absolute);
        expect(head.code, outputOf(head)).toBe(0);
        const sha = head.stdout.trim();
        expect(sha, `${repo.name} delivery commit is a 40-hex SHA`).toMatch(/^[0-9a-f]{40}$/);
        delivery.set(repo.name, { sha, path: repo.path, checkout: repo.absolute });
      }

      // 4. The workspace worktree starts clean with empty submodule directories.
      const addedWorktree = await git(['worktree', 'add', worktree, '-b', 'finalize-workspace'], root);
      expect(addedWorktree.code, outputOf(addedWorktree)).toBe(0);
      const status = await git(['status', '--porcelain'], worktree);
      expect(status.stdout.trim(), 'the workspace worktree starts clean').toBe('');
      for (const repo of repos) {
        let entries: string[] = ['<missing>'];
        try {
          entries = await readdir(join(worktree, repo.path));
        } catch {
          entries = [];
        }
        expect(entries, `the submodule directory ${repo.path} starts empty (or absent)`).toEqual([]);
      }

      // 5. Execute the documented procedure with real Git inside the workspace worktree,
      //    verifying each delivery commit read-only in its source repository first.
      for (const [, entry] of delivery) {
        const exists = await git(deliveryCommand(entry.checkout, entry.sha));
        expect(exists.code, `delivery commit for ${entry.path} exists in its source repository`).toBe(0);
        const pinned = await finalizePointer(worktree, entry.checkout, entry.sha, entry.path);
        expect(pinned, `${entry.path} is pinned`).toBe('pinned');
      }
      const committed = await git(['commit', '-m', 'finalize workspace pointers'], worktree);
      expect(committed.code, outputOf(committed)).toBe(0);
      for (const [, entry] of delivery) {
        const tree = await git(['ls-tree', 'HEAD', entry.path], worktree);
        expect(tree.code, outputOf(tree)).toBe(0);
        const columns = tree.stdout.trim().split(/\s+/);
        expect(columns[0], `${entry.path} is a gitlink`).toBe('160000');
        expect(columns[1], `${entry.path} is a commit pointer`).toBe('commit');
        expect(columns[2], `the pointer for ${entry.path} equals its recorded delivery commit`).toBe(entry.sha);
      }

      // 6. Failure path: a fabricated 40-hex SHA that does not exist stops the procedure
      //    before `update-index`, leaving the pointer at the previously recorded commit.
      expect(UNREACHABLE_SHA).toMatch(/^[0-9a-f]{40}$/);
      const target = delivery.get('app');
      expect(target, 'the app delivery pointer is recorded').toBeTruthy();
      const before = await git(['ls-files', '-s', '--', target?.path ?? ''], worktree);
      expect(before.stdout, 'the pointer starts at the recorded delivery commit').toContain(target?.sha);

      const missing = await git(deliveryCommand(target?.checkout ?? '', UNREACHABLE_SHA));
      expect(missing.code, 'the existence check fails for an unreachable commit').not.toBe(0);
      const stopped = await finalizePointer(worktree, target?.checkout ?? '', UNREACHABLE_SHA, target?.path ?? '');
      expect(stopped, 'the procedure stops before update-index').toBe('unreachable');

      const after = await git(['ls-files', '-s', '--', target?.path ?? ''], worktree);
      expect(after.stdout, 'the pointer still points at the previously recorded commit').toContain(target?.sha);
      expect(after.stdout, 'no unreachable commit was staged').not.toContain(UNREACHABLE_SHA);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktreeParent, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
