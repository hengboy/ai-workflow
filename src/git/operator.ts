import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function git(project: string, args: string[]): Promise<string> { const denied = ['push', 'pull', 'fetch', 'rebase', 'reset', 'clean', 'stash', 'tag']; if (args[0] && denied.includes(args[0])) throw new Error(`Git operation is forbidden: ${args[0]}`); const { stdout } = await exec('git', args, { cwd: project, maxBuffer: 1_000_000 }); return stdout.trim(); }
export async function gitBaseline(project: string): Promise<{ branch: string; head: string | null; status: string }> { const branch = await git(project, ['branch', '--show-current']); let head: string | null = null; try { head = await git(project, ['rev-parse', 'HEAD']); } catch { /* unborn HEAD */ } return { branch, head, status: await git(project, ['status', '--porcelain=v1']) }; }
export async function createWorktree(project: string, path: string, branch: string, base: string): Promise<void> { await git(project, ['worktree', 'add', '-b', branch, path, base]); }
export async function removeWorktree(project: string, path: string): Promise<void> { await git(project, ['worktree', 'remove', path]); }
