import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exists } from '../utils/fs.js';
import { validateWorkspaceManifest, type WorkspaceRepository } from '../workflow/workspace.js';
import { classifySlice, computeSliceFiles, resolveWorkspacePlan, type ResolvedWorkspacePlan } from './distribute.js';
import { commitExists, gitCommonDirectory, symbolicHead } from './git.js';
import {
  RESERVED_ROOT,
  errorMessage,
  implementationRecordPath,
  readWorkspaceRecord,
  type WorkspaceExecutionRecord,
} from './record.js';

const execFileAsync = promisify(execFile);

/** One participating repository as reported by the audit, with its manifest identity. */
export interface WorkspaceAuditRepository {
  name: string;
  path: string;
}

/**
 * The read-only workspace audit report: whether the recorded evidence agrees, the participating
 * repositories, the checks that ran, and the exact blockers and warnings found.
 */
export interface WorkspaceAuditResult {
  valid: boolean;
  plan_id?: string;
  repositories: WorkspaceAuditRepository[];
  checks: string[];
  blockers: string[];
  warnings: string[];
}

/** A record paired with the repository whose Git objects own its recorded SHAs. */
interface AuditedRecord {
  name: string;
  repositoryPath: string;
  repository: WorkspaceRepository | undefined;
  record: WorkspaceExecutionRecord | undefined;
}

/**
 * Read one repository's implementation record. A malformed record is reported as a blocker naming
 * its repository instead of aborting the audit; an absent record stays `undefined`.
 */
async function readRecordForAudit(recordPath: string, planId: string, repository: string, blockers: string[]): Promise<WorkspaceExecutionRecord | undefined> {
  try {
    return await readWorkspaceRecord(recordPath, planId);
  } catch (error) {
    blockers.push(`Implementation record for repository "${repository}" is invalid: ${errorMessage(error)}`);
    return undefined;
  }
}

/** Run one read-only Git command and return its non-empty output lines, or undefined on failure. */
async function gitLines(repository: string, arguments_: string[]): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repository, ...arguments_]);
    return stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, '').trim())
      .filter((line) => line !== '');
  } catch {
    return undefined;
  }
}

/** Every commit SHA a record names as evidence, without deduplication. */
function recordedCommits(record: WorkspaceExecutionRecord): string[] {
  const commits: string[] = [];
  if (record.commit !== undefined) commits.push(record.commit);
  if (record.root_tasks_commit !== undefined) commits.push(record.root_tasks_commit);
  if (record.reviewed_commit !== undefined) commits.push(record.reviewed_commit);
  for (const checkpoint of Object.values(record.task_checkpoints ?? {})) {
    commits.push(checkpoint.kind === 'commit' ? checkpoint.commit : checkpoint.head);
  }
  return commits;
}

/** Verify that every commit SHA a record names exists in its owning repository. */
async function checkRecordedCommits(entry: AuditedRecord, blockers: string[]): Promise<void> {
  const record = entry.record;
  if (record === undefined) return;
  const evidence: { sha: string; label: string }[] = [];
  if (record.status === 'completed' && record.commit !== undefined) evidence.push({ sha: record.commit, label: 'delivery commit' });
  if (record.root_tasks_commit !== undefined) evidence.push({ sha: record.root_tasks_commit, label: 'root tasks commit' });
  if (record.reviewed_commit !== undefined) evidence.push({ sha: record.reviewed_commit, label: 'reviewed commit' });
  for (const checkpoint of Object.values(record.task_checkpoints ?? {})) {
    evidence.push(
      checkpoint.kind === 'commit'
        ? { sha: checkpoint.commit, label: 'task checkpoint commit' }
        : { sha: checkpoint.head, label: 'no-change checkpoint head' },
    );
  }
  const seen = new Set<string>();
  for (const { sha, label } of evidence) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (!(await commitExists(entry.repositoryPath, sha))) {
      blockers.push(`Recorded ${label} ${sha} for repository "${entry.name}" does not exist in ${entry.repositoryPath}`);
    }
  }
}

/** Require every task a repository owns to carry a checkpoint once its record claims completion. */
function checkTaskCoverage(entry: AuditedRecord, tasks: { id: string; repo?: string }[], blockers: string[]): void {
  const record = entry.record;
  if (record === undefined) return;
  const isRoot = entry.name === RESERVED_ROOT;
  const requiresCoverage = isRoot ? record.status === 'completed' || record.root_tasks_commit !== undefined : record.status === 'completed';
  if (!requiresCoverage) return;
  const assigned = tasks.filter((task) => task.repo === entry.name);
  if (assigned.length === 0) return;
  const checkpoints = record.task_checkpoints ?? {};
  const missing = assigned.filter((task) => checkpoints[task.id] === undefined).map((task) => task.id);
  if (missing.length === 0) return;
  blockers.push(`Record for repository "${entry.name}" is missing task checkpoints for: ${missing.join(', ')}`);
}

/** Compare a completed repository's distributed slice with the frozen plan slice. */
async function checkSliceConsistency(
  resolved: ResolvedWorkspacePlan,
  entry: AuditedRecord,
  blockers: string[],
): Promise<void> {
  const record = entry.record;
  if (record === undefined || record.status !== 'completed' || entry.name === RESERVED_ROOT || entry.repository === undefined) return;
  const expected = await computeSliceFiles(resolved, entry.repository);
  const sliceDirectory = join(resolved.root, entry.repository.path, '.ai-workflow', 'plans', resolved.plan.planId);
  const states = await classifySlice(sliceDirectory, expected);
  for (const [relativePath, state] of states) {
    if (state === 'identical') continue;
    blockers.push(`Completed record for repository "${entry.name}" has a ${state} slice file at ${join(sliceDirectory, relativePath)}`);
  }
}

/** Check one execution anchor's worktree identity and report unrecorded commits on its branch. */
async function checkExecutionAnchor(entry: AuditedRecord, blockers: string[], warnings: string[]): Promise<void> {
  const record = entry.record;
  const anchor = record?.execution;
  if (record === undefined || anchor === undefined) return;
  if (!(await exists(anchor.worktree))) {
    blockers.push(`Execution anchor for repository "${entry.name}" names worktree ${anchor.worktree}, which does not exist`);
    return;
  }
  const [actual, expected] = await Promise.all([
    gitCommonDirectory(anchor.worktree),
    gitCommonDirectory(entry.repositoryPath),
  ]);
  if (actual === undefined || expected === undefined || actual !== expected) {
    blockers.push(`Execution anchor worktree ${anchor.worktree} for repository "${entry.name}" has Git common directory ${actual ?? 'unresolved'}, expected ${expected ?? 'unresolved'} at ${entry.repositoryPath}`);
    return;
  }
  const head = await symbolicHead(anchor.worktree);
  if (head !== `refs/heads/${anchor.branch}`) return;
  const evidence = new Set<string>(recordedCommits(record));
  evidence.add(anchor.base_commit);
  const unreferenced = await gitLines(anchor.worktree, ['rev-list', anchor.branch, '--not', ...evidence]);
  for (const sha of unreferenced ?? []) {
    warnings.push(`Unreferenced commit ${sha} is reachable from branch "${anchor.branch}" in worktree ${anchor.worktree} but is not part of the recorded evidence`);
  }
}

/**
 * Audit a workspace plan without writing files or Git state. The plan directory must live under
 * `<root>/.ai-workflow/plans/<planId>` and carry a `role: "workspace"` manifest; the manifest is
 * validated against the frozen plan, tasks and execution order before any repository is read.
 * Every finding names the exact path, plan ID or repository it concerns.
 */
export async function auditWorkspace(planDirectory: string): Promise<WorkspaceAuditResult> {
  const result: WorkspaceAuditResult = { valid: false, repositories: [], checks: [], blockers: [], warnings: [] };

  let resolved: ResolvedWorkspacePlan;
  try {
    resolved = await resolveWorkspacePlan(planDirectory);
  } catch (error) {
    result.blockers.push(errorMessage(error));
    return result;
  }

  const { root, directory, plan, tasks, schedule, manifest } = resolved;
  result.plan_id = plan.planId;
  result.checks.push(`Resolved frozen workspace plan "${plan.planId}" at ${directory}`);

  const manifestPath = join(directory, 'workspace.yaml');
  if (manifest === undefined) {
    result.blockers.push(`Missing workspace manifest at ${manifestPath}; a workspace audit requires workspace.yaml`);
    return result;
  }
  if (manifest.role !== 'workspace') {
    result.blockers.push(`Workspace manifest at ${manifestPath} declares plan_id "${manifest.planId}" with role "${manifest.role}"; a workspace audit requires role "workspace"`);
    return result;
  }

  const validationErrors = validateWorkspaceManifest(manifest, plan, tasks, schedule);
  if (validationErrors.length > 0) {
    result.blockers.push(...validationErrors);
    return result;
  }
  result.checks.push(`Validated workspace manifest at ${manifestPath} against the frozen plan, tasks and execution order`);

  const audited: AuditedRecord[] = [];
  for (const repository of manifest.repositories) {
    if (repository.name === RESERVED_ROOT) continue;
    result.repositories.push({ name: repository.name, path: repository.path });
    const recordPath = implementationRecordPath(root, repository.path, plan.planId);
    audited.push({
      name: repository.name,
      repositoryPath: join(root, repository.path),
      repository,
      record: await readRecordForAudit(recordPath, plan.planId, repository.name, result.blockers),
    });
  }
  result.checks.push(`Read the implementation records of ${result.repositories.length} participating repositories`);

  const rootRecordPath = implementationRecordPath(root, '.', plan.planId);
  audited.push({
    name: RESERVED_ROOT,
    repositoryPath: root,
    repository: undefined,
    record: await readRecordForAudit(rootRecordPath, plan.planId, RESERVED_ROOT, result.blockers),
  });

  // A worktree is active only when a written execution anchor names it; an audit before the first
  // worktree therefore warns instead of blocking, and only records need to be consulted.
  const anchors = audited.filter((entry) => entry.record?.execution !== undefined);
  if (anchors.length === 0) {
    result.warnings.push(`No active worktree is recorded under ${root} because no implementation record declares an execution anchor`);
  }
  result.checks.push('Checked recorded execution anchors for an active worktree');

  for (const entry of audited) {
    await checkRecordedCommits(entry, result.blockers);
    checkTaskCoverage(entry, tasks, result.blockers);
    await checkSliceConsistency(resolved, entry, result.blockers);
    await checkExecutionAnchor(entry, result.blockers, result.warnings);
  }
  result.checks.push('Verified recorded commit SHAs against their owning repositories');
  result.checks.push('Checked task checkpoint coverage for completed implementation records');
  result.checks.push('Compared completed implementation records with their distributed slices');
  result.checks.push('Checked recorded branches for commits outside the recorded evidence');

  result.valid = result.blockers.length === 0;
  return result;
}
