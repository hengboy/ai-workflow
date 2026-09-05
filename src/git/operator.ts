import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { EventLog } from '../runtime/events.js';
import { ProjectGitMutex, RunGitQueue } from '../runtime/scheduler.js';
import { objectDigest } from '../utils/hash.js';
import { canonicalPath } from '../utils/paths.js';
import { writeJson, exists } from '../utils/fs.js';

const exec = promisify(execFile);
const allowedReadOnly = new Set(['branch', 'rev-parse', 'status', 'worktree', 'merge-tree', 'show']);
const forbidden = new Set(['push', 'pull', 'fetch', 'rebase', 'reset', 'clean', 'stash', 'tag', 'remote', 'config', 'submodule']);
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function assertLocalGitCommand(args: string[]): void {
  const command = args[0];
  if (!command || forbidden.has(command)) throw new Error(`Git operation is forbidden: ${command ?? '<missing command>'}`);
  if (args.some((arg) => /^(?:origin|upstream|https?:|ssh:|git@)/i.test(arg)) || args.includes('--set-upstream-to') || args.includes('--track') || args.includes('--remote')) throw new Error('Git operation is forbidden: remote or upstream mutation');
  if (command === 'branch' && args.some((arg) => ['-f', '-M', '-m', '--force', '--move', '--set-upstream-to', '--track'].includes(arg))) throw new Error('Git operation is forbidden: local branch mutation');
  if (command === 'worktree' && args[1] === 'remove') throw new Error('Git operation is forbidden: worktree removal');
  if (command === 'branch' && args.includes('-vv')) throw new Error('Git operation is forbidden: upstream inspection');
  if (allowedReadOnly.has(command)) return;
  if (command === 'add' && args[1] === '--') return;
  if (command === 'commit' && args.includes('-m')) return;
  if (command === 'merge' && args.includes('--no-ff') && args.includes('--no-edit')) return;
  if (command === 'branch' && (args[1] === '-D' || args[1] === '--delete')) return;
  throw new Error(`Git operation is not in the local allowlist: ${command}`);
}

export async function git(project: string, args: string[]): Promise<string> {
  assertLocalGitCommand(args);
  const { stdout } = await exec('git', args, { cwd: project, maxBuffer: 1_000_000 });
  return stdout.trim();
}

export async function gitBaseline(project: string): Promise<{ branch: string; head: string | null; status: string }> {
  const branch = await git(project, ['branch', '--show-current']);
  let head: string | null = null;
  try { head = await git(project, ['rev-parse', 'HEAD']); } catch { /* unborn HEAD */ }
  return { branch, head, status: await git(project, ['status', '--porcelain=v1']) };
}

export interface Worktree { path: string; branch: string; base: string }

function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, '-'); }

export async function createPlanWorktree(project: string, runId: string, baseBranch: string, baseHead?: string | null): Promise<Worktree> {
  const path = resolve(project, '.ai-workflow/runs', runId, 'plan-worktree');
  const branch = `ai-workflow/${safeName(runId)}/plan`;
  await mkdir(resolve(project, '.ai-workflow/runs', runId), { recursive: true });
  const base = baseHead ?? await git(project, ['rev-parse', baseBranch]);
  await git(project, ['worktree', 'add', '-b', branch, path, base]);
  return { path, branch, base };
}

export async function createTaskWorktree(project: string, plan: Worktree, runId: string, taskId: string): Promise<Worktree> {
  const path = resolve(project, '.ai-workflow/runs', runId, `task-${safeName(taskId)}`);
  const branch = `ai-workflow/${safeName(runId)}/${safeName(taskId)}`;
  await git(plan.path, ['worktree', 'add', '-b', branch, path, plan.branch]);
  return { path, branch, base: plan.branch };
}

export async function commitTask(worktree: string, taskId: string, paths: string[]): Promise<string> {
  if (!paths.length) throw new Error(`Task ${taskId} has no write scope`);
  const present: string[] = [];
  for (const path of paths) {
    try { await lstat(resolve(worktree, path)); present.push(path); } catch { /* an empty task may still have a recorded commit */ }
  }
  if (present.length) await git(worktree, ['add', '--', ...present]);
  await git(worktree, ['commit', '--allow-empty', '-m', `ai-workflow: ${taskId}`]);
  return git(worktree, ['rev-parse', 'HEAD']);
}

export async function mergeTask(planPath: string, commit: string): Promise<string> {
  await git(planPath, ['merge', '--no-ff', '--no-edit', commit]);
  return git(planPath, ['rev-parse', 'HEAD']);
}

export async function integratePlan(project: string, planBranch: string, targetBranch: string, expectedHead?: string | null): Promise<string> {
  const current = await git(project, ['rev-parse', targetBranch]);
  if (expectedHead !== undefined && current !== expectedHead) throw new Error(`Git baseline drift: expected ${expectedHead}, got ${current}`);
  await git(project, ['merge', '--no-ff', '--no-edit', planBranch]);
  return git(project, ['rev-parse', 'HEAD']);
}

export async function removeOwnedWorktrees(project: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    try { await git(project, ['worktree', 'remove', '--force', path]); }
    catch (error) { if (!String(error).includes('not a working tree')) throw error; }
  }
}

export async function deleteOwnedBranches(project: string, branches: string[]): Promise<void> {
  for (const branch of branches) {
    try { await git(project, ['branch', '-D', branch]); } catch { /* already removed */ }
  }
}

export type GitResourceKind = 'plan-worktree' | 'task-worktree' | 'repair-worktree' | 'repair-test-worktree'
  | 'plan-branch' | 'task-branch' | 'repair-branch' | 'repair-test-branch';

export interface GitResourceReceipt {
  resource_version: '2.0.0';
  resource_type: 'owned-git-resource';
  resource_id: string;
  run_id: string;
  fencing_epoch: number;
  manifest_digest: string;
  git_common_dir_digest: string;
  kind: GitResourceKind;
  canonical_path?: string;
  branch: string;
  base_ref: string;
  created_head: string;
  owner_trailer: string;
  creation_intent_digest: string;
  creation_transaction_id: string;
  committed: boolean;
}

export interface V2Worktree extends Worktree {
  resource: GitResourceReceipt;
  branchResource: GitResourceReceipt;
}

export interface V2GitOperatorOptions {
  project: string;
  runId: string;
  manifestDigest: string;
  fencingEpoch: number;
  targetBranch?: string;
  eventLog?: EventLog;
  startIdentity?: string;
}

export interface CreatePlanOptions { baseBranch?: string; expectedHead?: string | null }
export interface MergeDryRun { clean: boolean; tree?: string; output: string; conflicts: string[] }
export interface GitCommitReceipt { commit: string; tree: string; resource_id: string; transaction_id: string; expected_head: string }
export interface ReconcileResult { resource_id: string; state: 'observed' | 'missing' | 'tampered' | 'already-cleaned'; path?: string; branch?: string }

export class V2GitOperatorError extends Error {
  readonly name = 'V2GitOperatorError';
  constructor(readonly code: 'INVALID_INPUT' | 'BASELINE_DRIFT' | 'RESOURCE_TAMPERED' | 'RESOURCE_DIRTY' | 'RESOURCE_UNKNOWN' | 'MERGE_CONFLICT' | 'GIT_RECONCILE_REQUIRED', message: string) { super(message); }
}

function assertDigest(value: string, label: string): void {
  if (!digestPattern.test(value)) throw new V2GitOperatorError('INVALID_INPUT', `${label} must be a sha256 digest`);
}

function assertRunId(value: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(value)) throw new V2GitOperatorError('INVALID_INPUT', 'runId is invalid');
}

function resourceId(kind: GitResourceKind, runId: string, taskId?: string): string {
  const run = safeName(runId).toLowerCase();
  const task = taskId ? `-${safeName(taskId).toLowerCase()}` : '';
  return `resource-${kind}-${run}${task}`;
}

function transactionId(action: string, resource: string): string { return `tx-${action}-${resource.replaceAll('_', '-')}`; }

function isWithinScope(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`);
}

function changedPath(line: string): string {
  const value = (line[2] === ' ' ? line.slice(3) : line.slice(2)).trim();
  const rename = value.lastIndexOf(' -> ');
  return (rename >= 0 ? value.slice(rename + 4) : value).replaceAll('\\', '/');
}

function worktreeEntries(value: string): Array<{ path: string; branch?: string }> {
  const entries: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { current = { path: canonicalPath(line.slice(9)) }; entries.push(current); }
    else if (line.startsWith('branch refs/heads/') && current) current.branch = line.slice('branch refs/heads/'.length);
  }
  return entries;
}

export class V2GitOperator {
  private readonly targetBranch: string;
  private readonly queue = new RunGitQueue();
  private readonly resourcesById = new Map<string, GitResourceReceipt>();
  private readonly eventLog: EventLog;
  private readonly startIdentity: string;
  private commonDir?: string;

  constructor(private readonly options: V2GitOperatorOptions) {
    assertRunId(options.runId);
    assertDigest(options.manifestDigest, 'manifestDigest');
    if (!Number.isSafeInteger(options.fencingEpoch) || options.fencingEpoch < 1) throw new V2GitOperatorError('INVALID_INPUT', 'fencingEpoch must be positive');
    this.targetBranch = options.targetBranch ?? 'main';
    this.eventLog = options.eventLog ?? new EventLog({ path: resolve(options.project, '.ai-workflow/runs', options.runId, 'events.jsonl'), runId: options.runId, fencingEpoch: options.fencingEpoch });
    this.startIdentity = options.startIdentity ?? `${process.pid}:${Date.now()}`;
  }

  get resources(): readonly GitResourceReceipt[] { return [...this.resourcesById.values()].map((resource) => ({ ...resource })); }

  async createPlanWorktree(input: CreatePlanOptions = {}): Promise<V2Worktree> {
    const baseBranch = input.baseBranch ?? this.targetBranch;
    const base = await git(this.options.project, ['rev-parse', baseBranch]);
    if (input.expectedHead !== undefined && base !== input.expectedHead) throw new V2GitOperatorError('BASELINE_DRIFT', `Git baseline drift: expected ${input.expectedHead}, got ${base}`);
    return this.createWorktree('plan', 'plan-worktree', 'plan-branch', resolve(this.options.project, '.ai-workflow/runs', this.options.runId, 'worktrees', 'plan'), base, baseBranch);
  }

  async createTaskWorktree(plan: V2Worktree, taskId: string): Promise<V2Worktree> {
    if (!taskId || safeName(taskId) !== taskId) throw new V2GitOperatorError('INVALID_INPUT', `taskId is invalid: ${taskId}`);
    this.assertOwned(plan.resource);
    const base = await git(plan.path, ['rev-parse', 'HEAD']);
    return this.createWorktree(taskId, 'task-worktree', 'task-branch', resolve(this.options.project, '.ai-workflow/runs', this.options.runId, 'worktrees', 'tasks', taskId), base, plan.branch);
  }

  async createRepairWorktree(baseHead: string): Promise<V2Worktree> {
    return this.createWorktree('repair', 'repair-worktree', 'repair-branch', resolve(this.options.project, '.ai-workflow/runs', this.options.runId, 'worktrees', 'repair'), baseHead, `ai-workflow/v2/${safeName(this.options.runId)}/plan`);
  }

  async createRepairTestWorktree(taskId: string, baseHead: string): Promise<V2Worktree> {
    if (!taskId || safeName(taskId) !== taskId) throw new V2GitOperatorError('INVALID_INPUT', `taskId is invalid: ${taskId}`);
    return this.createWorktree(taskId, 'repair-test-worktree', 'repair-test-branch', resolve(this.options.project, '.ai-workflow/runs', this.options.runId, 'worktrees', 'repair-tests', taskId), baseHead, `ai-workflow/v2/${safeName(this.options.runId)}/plan`);
  }

  async commitTask(task: V2Worktree, taskId: string, paths: string[]): Promise<GitCommitReceipt> {
    this.assertOwned(task.resource);
    if (task.resource.kind !== 'task-worktree' && task.resource.kind !== 'repair-worktree' && task.resource.kind !== 'repair-test-worktree') throw new V2GitOperatorError('RESOURCE_UNKNOWN', `resource is not a task worktree: ${task.resource.resource_id}`);
    if (!paths.length) throw new V2GitOperatorError('INVALID_INPUT', `Task ${taskId} has no write scope`);
    const scope = paths.map((path) => relative(task.path, resolve(task.path, path)).replaceAll('\\', '/'));
    if (scope.some((path) => path === '' || path.startsWith('../') || path === '..')) throw new V2GitOperatorError('INVALID_INPUT', 'write scope escapes worktree');
    const before = await git(task.path, ['rev-parse', 'HEAD']);
    const status = await git(task.path, ['status', '--porcelain=v1', '--untracked-files=all']);
    const changed = status.split(/\r?\n/).filter(Boolean).map(changedPath);
    if (changed.some((path) => !scope.some((allowed) => isWithinScope(path, allowed)))) throw new V2GitOperatorError('RESOURCE_TAMPERED', `changed path is outside task write scope: ${changed.find((path) => !scope.some((allowed) => isWithinScope(path, allowed)))}`);
    const id = task.resource.resource_id;
    const tx = transactionId('commit', id);
    await this.emit('git/commit-intent', { resource_id: id, action_id: taskId, expected_head: before }, tx);
    await this.withGitMutation(async () => {
      await git(task.path, ['add', '--', ...scope]);
      await git(task.path, ['commit', '--allow-empty', '-m', `ai-workflow: ${taskId}`, '-m', `${task.resource.owner_trailer}\nAI-Workflow-Transaction: ${tx}`]);
    });
    const commit = await git(task.path, ['rev-parse', 'HEAD']);
    const tree = await git(task.path, ['rev-parse', `${commit}^{tree}`]);
    task.resource.committed = true;
    task.branchResource.committed = true;
    await this.persist(task.resource);
    await this.persist(task.branchResource);
    await this.emit('git/commit-observed', { resource_id: id, action_id: taskId, commit, tree, expected_head: before }, tx);
    return { commit, tree, resource_id: id, transaction_id: tx, expected_head: before };
  }

  async dryRunMerge(worktreeOrProject: V2Worktree | string, commitOrBranch: string): Promise<MergeDryRun> {
    const cwd = typeof worktreeOrProject === 'string' ? worktreeOrProject : worktreeOrProject.path;
    try {
      const output = await git(cwd, ['merge-tree', '--write-tree', 'HEAD', commitOrBranch]);
      return { clean: true, tree: output.split(/\s+/)[0] ?? '', output, conflicts: [] };
    } catch (error) {
      const output = String(error);
      const conflicts = output.split(/\r?\n/).filter((line) => /CONFLICT|both modified|would be overwritten/i.test(line));
      return { clean: false, output, conflicts: conflicts.length ? conflicts : ['merge-tree reported a conflict'] };
    }
  }

  async mergeTask(plan: V2Worktree, commit: string): Promise<string> {
    this.assertOwned(plan.resource);
    const check = await this.dryRunMerge(plan, commit);
    if (!check.clean) throw new V2GitOperatorError('MERGE_CONFLICT', `merge conflict for ${commit}: ${check.conflicts.join('; ')}`);
    const before = await git(plan.path, ['rev-parse', 'HEAD']);
    const tx = transactionId('merge', plan.resource.resource_id);
    await this.emit('git/merge-intent', { resource_id: plan.resource.resource_id, commit, expected_head: before }, tx);
    await this.withGitMutation(() => git(plan.path, ['merge', '--no-ff', '--no-edit', commit]));
    const head = await git(plan.path, ['rev-parse', 'HEAD']);
    await this.emit('git/merge-observed', { resource_id: plan.resource.resource_id, commit, head, expected_head: before }, tx);
    return head;
  }

  async integratePlan(plan: V2Worktree, input: { targetBranch?: string; expectedHead?: string | null } = {}): Promise<string> {
    this.assertOwned(plan.resource);
    const targetBranch = input.targetBranch ?? this.targetBranch;
    const branch = await git(this.options.project, ['branch', '--show-current']);
    if (branch !== targetBranch) throw new V2GitOperatorError('RESOURCE_TAMPERED', `target branch is not checked out: ${branch}`);
    const current = await git(this.options.project, ['rev-parse', targetBranch]);
    if (input.expectedHead !== undefined && current !== input.expectedHead) throw new V2GitOperatorError('BASELINE_DRIFT', `Git baseline drift: expected ${input.expectedHead}, got ${current}`);
    const baseline = await gitBaseline(this.options.project);
    const externalChanges = baseline.status.split(/\r?\n/).filter(Boolean).filter((line) => !changedPath(line).startsWith('.ai-workflow/'));
    if (externalChanges.length) throw new V2GitOperatorError('RESOURCE_DIRTY', 'target project is dirty; integration is refused');
    const check = await this.dryRunMerge(this.options.project, plan.branch);
    if (!check.clean) throw new V2GitOperatorError('MERGE_CONFLICT', `integration conflict: ${check.conflicts.join('; ')}`);
    const tx = transactionId('integration', plan.resource.resource_id);
    await this.emit('git/integration-intent', { resource_id: plan.resource.resource_id, branch: plan.branch, expected_head: current }, tx);
    await this.withGitMutation(() => git(this.options.project, ['merge', '--no-ff', '--no-edit', plan.branch]));
    const head = await git(this.options.project, ['rev-parse', 'HEAD']);
    plan.resource.committed = true;
    plan.branchResource.committed = true;
    await this.persist(plan.resource);
    await this.persist(plan.branchResource);
    await this.emit('git/integration-observed', { resource_id: plan.resource.resource_id, branch: plan.branch, merge_commit: head, expected_head: current }, tx);
    return head;
  }

  async reconcile(): Promise<ReconcileResult[]> {
    const directory = resolve(this.options.project, '.ai-workflow/runs', this.options.runId, 'receipts', 'resource');
    const results: ReconcileResult[] = [];
    if (await exists(directory)) {
      for (const file of await readdir(directory)) {
        if (!file.endsWith('.json')) continue;
        const receipt = JSON.parse(await readFile(resolve(directory, file), 'utf8')) as GitResourceReceipt;
        this.assertReceipt(receipt);
        this.resourcesById.set(receipt.resource_id, receipt);
        results.push(await this.inspectReceipt(receipt));
      }
    }
    const log = await this.eventLog.read();
    if (log.tail_interrupted) throw new V2GitOperatorError('GIT_RECONCILE_REQUIRED', 'event log has an interrupted tail');
    return results;
  }

  async cleanup(): Promise<void> {
    await this.reconcile();
    const resources = this.resources.filter((resource) => resource.canonical_path);
    const entries = await this.worktrees();
    const projectPath = await realpath(this.options.project).catch(() => this.options.project);
    const toRemove: GitResourceReceipt[] = [];
    for (const resource of resources) {
      this.assertReceipt(resource);
      const resourcePath = resource.canonical_path;
      if (!resourcePath) continue;
      const entry = entries.find((candidate) => candidate.path === canonicalPath(resolve(this.options.project, resourcePath)) || candidate.path === canonicalPath(resolve(projectPath, resourcePath)));
      if (!entry) continue;
      if (entry.branch !== resource.branch) throw new V2GitOperatorError('RESOURCE_TAMPERED', `worktree branch does not match receipt: ${resource.resource_id}`);
      const status = await git(resourcePath.startsWith('.') ? resolve(this.options.project, resourcePath) : canonicalPath(resourcePath), ['status', '--porcelain=v1', '--untracked-files=all']);
      if (status) throw new V2GitOperatorError('RESOURCE_DIRTY', `owned resource is dirty: ${resource.resource_id}`);
      toRemove.push(resource);
    }
    for (const resource of toRemove) {
      const tx = transactionId('cleanup', resource.resource_id);
      await this.emit('git/cleanup-intent', { resource_id: resource.resource_id, path: resource.canonical_path ?? '', branch: resource.branch }, tx);
      const resourcePath = resource.canonical_path;
      if (!resourcePath) continue;
      await this.withGitMutation(() => git(this.options.project, ['worktree', 'remove', resourcePath]));
      await this.emit('git/cleanup-observed', { resource_id: resource.resource_id, path: resource.canonical_path ?? '', branch: resource.branch }, tx);
    }
    const branches = this.resources.filter((resource) => resource.branch && !resource.canonical_path);
    for (const resource of branches) {
      const branch = resource.branch;
      if (!branch) continue;
      if (!branch.startsWith(`ai-workflow/v2/${safeName(this.options.runId)}/`)) throw new V2GitOperatorError('RESOURCE_TAMPERED', `branch is outside ownership namespace: ${resource.resource_id}`);
      try { await this.withGitMutation(() => git(this.options.project, ['branch', '-D', branch])); } catch (error) {
        if (!String(error).includes('not found')) throw error;
      }
    }
  }

  private async createWorktree(name: string, worktreeKind: Extract<GitResourceKind, `${string}-worktree`>, branchKind: Extract<GitResourceKind, `${string}-branch`>, path: string, base: string, baseRef: string): Promise<V2Worktree> {
    const branch = `ai-workflow/v2/${safeName(this.options.runId)}/${worktreeKind === 'plan-worktree' ? 'plan' : worktreeKind === 'task-worktree' ? `task-${safeName(name)}` : worktreeKind === 'repair-worktree' ? 'repair' : `repair-test-${safeName(name)}`}`;
    const worktreeId = resourceId(worktreeKind, this.options.runId, worktreeKind === 'plan-worktree' || worktreeKind === 'repair-worktree' ? undefined : name);
    const branchResourceId = resourceId(branchKind, this.options.runId, worktreeKind === 'plan-worktree' || worktreeKind === 'repair-worktree' ? undefined : name);
    const tx = transactionId('create', worktreeId);
    const intent = { resource_id: worktreeId, kind: worktreeKind, path: relative(this.options.project, path).replaceAll('\\', '/'), branch, expected_head: base };
    await this.emit('resource/create-intent', intent, tx);
    await this.emit('git/worktree-intent', intent, tx);
    if (await exists(path)) throw new V2GitOperatorError('RESOURCE_TAMPERED', `resource path already exists: ${path}`);
    await this.withGitMutation(() => git(this.options.project, ['worktree', 'add', '-b', branch, path, base]));
    const createdHead = await git(path, ['rev-parse', 'HEAD']);
    await this.gitCommonDir();
    const ownerTrailer = `AI-Workflow-Resource: ${worktreeId}`;
    const resource = this.receipt(worktreeId, worktreeKind, path, branch, baseRef, createdHead, ownerTrailer, tx, objectDigest(intent));
    const branchResource = this.receipt(branchResourceId, branchKind, undefined, branch, baseRef, createdHead, ownerTrailer, tx, objectDigest(intent));
    await this.persist(resource);
    await this.persist(branchResource);
    this.resourcesById.set(resource.resource_id, resource);
    this.resourcesById.set(branchResource.resource_id, branchResource);
    await this.emit('git/worktree-created', { resource_id: worktreeId, path: resource.canonical_path ?? '', branch, head: createdHead, tree: await git(path, ['rev-parse', 'HEAD^{tree}']) }, tx);
    await this.emit('resource/created', { resource_id: worktreeId, path: resource.canonical_path ?? '', branch, head: createdHead, kind: worktreeKind }, tx);
    await this.saveResources();
    return { path, branch, base, resource, branchResource };
  }

  private receipt(resource: string, kind: GitResourceKind, path: string | undefined, branch: string, baseRef: string, createdHead: string, ownerTrailer: string, tx: string, intentDigest: string): GitResourceReceipt {
    return { resource_version: '2.0.0', resource_type: 'owned-git-resource', resource_id: resource, run_id: this.options.runId, fencing_epoch: this.options.fencingEpoch, manifest_digest: this.options.manifestDigest, git_common_dir_digest: this.commonDirDigest(), kind, ...(path ? { canonical_path: relative(this.options.project, path).replaceAll('\\', '/') } : {}), branch, base_ref: baseRef, created_head: createdHead, owner_trailer: ownerTrailer, creation_intent_digest: intentDigest, creation_transaction_id: tx, committed: false };
  }

  private commonDirDigest(): string { if (!this.commonDir) throw new V2GitOperatorError('GIT_RECONCILE_REQUIRED', 'Git common directory has not been resolved'); return objectDigest(this.commonDir); }

  private async gitCommonDir(): Promise<string> { return this.commonDir ??= canonicalPath(await git(this.options.project, ['rev-parse', '--git-common-dir'])); }

  private assertReceipt(resource: GitResourceReceipt): void {
    if (resource.resource_version !== '2.0.0' || resource.resource_type !== 'owned-git-resource' || resource.run_id !== this.options.runId || resource.fencing_epoch !== this.options.fencingEpoch || resource.manifest_digest !== this.options.manifestDigest) throw new V2GitOperatorError('RESOURCE_TAMPERED', `resource receipt does not belong to this run: ${resource.resource_id}`);
    if (resource.branch && !resource.branch.startsWith(`ai-workflow/v2/${safeName(this.options.runId)}/`)) throw new V2GitOperatorError('RESOURCE_TAMPERED', `branch is outside ownership namespace: ${resource.resource_id}`);
    if (resource.canonical_path && resource.canonical_path.includes('..')) throw new V2GitOperatorError('RESOURCE_TAMPERED', `resource path is unsafe: ${resource.resource_id}`);
  }

  private assertOwned(resource: GitResourceReceipt): void {
    this.assertReceipt(resource);
    const known = this.resourcesById.get(resource.resource_id);
    if (!known || known.canonical_path !== resource.canonical_path || known.branch !== resource.branch) throw new V2GitOperatorError('RESOURCE_UNKNOWN', `resource is not owned by this operator: ${resource.resource_id}`);
  }

  private async persist(resource: GitResourceReceipt): Promise<void> {
    this.assertReceipt(resource);
    await writeJson(resolve(this.options.project, '.ai-workflow/runs', this.options.runId, 'receipts', 'resource', `${resource.resource_id}.json`), resource);
  }

  private async saveResources(): Promise<void> { await writeJson(resolve(this.options.project, '.ai-workflow/runs', this.options.runId, 'resources.json'), this.resources); }

  private async worktrees(): Promise<Array<{ path: string; branch?: string }>> { return worktreeEntries(await git(this.options.project, ['worktree', 'list', '--porcelain'])); }

  private async inspectReceipt(resource: GitResourceReceipt): Promise<ReconcileResult> {
    if (!resource.canonical_path) {
      const branch = resource.branch;
      if (!branch) throw new V2GitOperatorError('RESOURCE_TAMPERED', `branch is missing: ${resource.resource_id}`);
      try { const head = await git(this.options.project, ['rev-parse', branch]); if (!head) throw new Error('missing'); return { resource_id: resource.resource_id, state: 'observed', branch }; }
      catch { return { resource_id: resource.resource_id, state: 'already-cleaned', branch: resource.branch }; }
    }
    const entries = await this.worktrees();
    const expected = canonicalPath(resolve(this.options.project, resource.canonical_path));
    const resolvedExpected = await realpath(expected).catch(() => expected);
    const entry = entries.find((candidate) => candidate.path === expected || candidate.path === resolvedExpected);
    if (!entry) return { resource_id: resource.resource_id, state: 'already-cleaned', path: resource.canonical_path, branch: resource.branch };
    if (entry.branch !== resource.branch) return { resource_id: resource.resource_id, state: 'tampered', path: resource.canonical_path, branch: entry.branch ?? '' };
    const head = await git(resolvedExpected, ['rev-parse', 'HEAD']);
    if (head !== resource.created_head && !resource.committed) return { resource_id: resource.resource_id, state: 'tampered', path: resource.canonical_path, branch: entry.branch };
    return { resource_id: resource.resource_id, state: 'observed', path: resource.canonical_path, branch: entry.branch };
  }

  private async withGitMutation<T>(operation: () => Promise<T>): Promise<T> {
    const commonDir = await this.gitCommonDir();
    const mutex = new ProjectGitMutex({ root: this.options.project, gitCommonDir: commonDir, targetBranch: this.targetBranch, leaseMs: 30_000 });
    return this.queue.enqueue(async () => {
      const owner = await mutex.acquire({ runId: this.options.runId, pid: process.pid, startIdentity: this.startIdentity }, { wait: true });
      try { return await mutex.withLock(owner, operation); } finally { await mutex.release(owner); }
    }, { runId: this.options.runId, pid: process.pid, startIdentity: this.startIdentity, fencingEpoch: 0, leaseExpiresAt: 0 });
  }

  private async emit(type: Parameters<EventLog['append']>[0]['type'], payload: Parameters<EventLog['append']>[0]['payload'], tx: string): Promise<void> {
    await this.eventLog.append({ type, payload, transaction_id: tx });
  }
}

export const GitOperatorV2 = V2GitOperator;
export const createV2GitOperator = (options: V2GitOperatorOptions): V2GitOperator => new V2GitOperator(options);
