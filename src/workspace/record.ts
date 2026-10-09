import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { atomicWrite } from '../utils/fs.js';

/** The reserved repository name that owns the workspace root record. */
export const RESERVED_ROOT = 'workspace';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A full lowercase 40- or 64-hex commit SHA. */
export function isFullSha(value: unknown): value is string {
  return typeof value === 'string' && FULL_SHA.test(value);
}

export interface ExecutionAnchor {
  purpose: 'tasks' | 'finalization';
  source_root: string;
  repository: string;
  worktree: string;
  branch: string;
  target_branch: string;
  base_commit: string;
}

export type TaskCheckpoint =
  | { kind: 'commit'; commit: string }
  | { kind: 'no-change'; head: string };

export interface WorkspaceExecutionRecord {
  plan_id: string;
  status: 'in-progress' | 'completed';
  started_at: string;
  completed_at?: string;
  commit?: string;
  root_tasks_commit?: string;
  reviewed_commit?: string;
  execution?: ExecutionAnchor;
  task_checkpoints?: Record<string, TaskCheckpoint>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Malformed implementation record at ${path}: field "${field}" must be a non-empty string`);
  return value;
}

function asSha(value: unknown, field: string, path: string): string {
  if (!isFullSha(value)) throw new Error(`Malformed implementation record at ${path}: field "${field}" must be a full lowercase 40- or 64-hex SHA`);
  return value;
}

function parseExecution(raw: unknown, path: string): ExecutionAnchor {
  if (!isPlainObject(raw)) throw new Error(`Malformed implementation record at ${path}: field "execution" must be an object`);
  const purpose = raw.purpose;
  if (purpose !== 'tasks' && purpose !== 'finalization') throw new Error(`Malformed implementation record at ${path}: field "execution.purpose" must be "tasks" or "finalization"`);
  return {
    purpose,
    source_root: asString(raw.source_root, 'execution.source_root', path),
    repository: asString(raw.repository, 'execution.repository', path),
    worktree: asString(raw.worktree, 'execution.worktree', path),
    branch: asString(raw.branch, 'execution.branch', path),
    target_branch: asString(raw.target_branch, 'execution.target_branch', path),
    base_commit: asSha(raw.base_commit, 'execution.base_commit', path),
  };
}

function parseCheckpoint(raw: unknown, taskId: string, path: string): TaskCheckpoint {
  if (!isPlainObject(raw)) throw new Error(`Malformed implementation record at ${path}: task checkpoint "${taskId}" must be an object`);
  if (raw.kind === 'commit') return { kind: 'commit', commit: asSha(raw.commit, `task_checkpoints.${taskId}.commit`, path) };
  if (raw.kind === 'no-change') return { kind: 'no-change', head: asSha(raw.head, `task_checkpoints.${taskId}.head`, path) };
  throw new Error(`Malformed implementation record at ${path}: task checkpoint "${taskId}" must declare kind "commit" or "no-change"`);
}

/**
 * Strictly parse one implementation record. Unknown extra fields are ignored; a present record with a
 * wrong `plan_id`, an unknown status or a malformed typed field throws so callers can treat it as a blocker
 * instead of a fresh or missing record.
 */
export function parseWorkspaceRecord(source: string, path: string, planId: string): WorkspaceExecutionRecord {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    throw new Error(`Malformed implementation record YAML at ${path}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`Malformed implementation record at ${path}: expected a YAML object`);
  if (parsed.plan_id !== planId) throw new Error(`Implementation record at ${path} declares plan_id "${String(parsed.plan_id)}", expected "${planId}"`);
  const status = parsed.status;
  if (status !== 'in-progress' && status !== 'completed') throw new Error(`Malformed implementation record at ${path}: field "status" must be "in-progress" or "completed"`);
  const record: WorkspaceExecutionRecord = { plan_id: planId, status, started_at: asString(parsed.started_at, 'started_at', path) };
  if (parsed.completed_at !== undefined) record.completed_at = asString(parsed.completed_at, 'completed_at', path);
  if (parsed.commit !== undefined) record.commit = asSha(parsed.commit, 'commit', path);
  if (parsed.root_tasks_commit !== undefined) record.root_tasks_commit = asSha(parsed.root_tasks_commit, 'root_tasks_commit', path);
  if (parsed.reviewed_commit !== undefined) record.reviewed_commit = asSha(parsed.reviewed_commit, 'reviewed_commit', path);
  if (parsed.execution !== undefined) record.execution = parseExecution(parsed.execution, path);
  if (parsed.task_checkpoints !== undefined) {
    if (!isPlainObject(parsed.task_checkpoints)) throw new Error(`Malformed implementation record at ${path}: field "task_checkpoints" must be a map`);
    const checkpoints: Record<string, TaskCheckpoint> = {};
    for (const [taskId, raw] of Object.entries(parsed.task_checkpoints)) checkpoints[taskId] = parseCheckpoint(raw, taskId, path);
    record.task_checkpoints = checkpoints;
  }
  return record;
}

/** Read and strictly parse a repository implementation record; `undefined` when the file is absent. */
export async function readWorkspaceRecord(path: string, planId: string): Promise<WorkspaceExecutionRecord | undefined> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseWorkspaceRecord(source, path, planId);
}

/** Render the record with a deterministic field order so repeated identical updates stay byte-identical. */
export function renderWorkspaceRecord(record: WorkspaceExecutionRecord): string {
  const output: Record<string, unknown> = { plan_id: record.plan_id, status: record.status, started_at: record.started_at };
  if (record.completed_at !== undefined) output.completed_at = record.completed_at;
  if (record.commit !== undefined) output.commit = record.commit;
  if (record.root_tasks_commit !== undefined) output.root_tasks_commit = record.root_tasks_commit;
  if (record.reviewed_commit !== undefined) output.reviewed_commit = record.reviewed_commit;
  if (record.execution !== undefined) {
    output.execution = {
      purpose: record.execution.purpose,
      source_root: record.execution.source_root,
      repository: record.execution.repository,
      worktree: record.execution.worktree,
      branch: record.execution.branch,
      target_branch: record.execution.target_branch,
      base_commit: record.execution.base_commit,
    };
  }
  if (record.task_checkpoints !== undefined) {
    output.task_checkpoints = Object.fromEntries(
      Object.entries(record.task_checkpoints).map(([taskId, checkpoint]) => [taskId, checkpoint.kind === 'commit' ? { kind: 'commit', commit: checkpoint.commit } : { kind: 'no-change', head: checkpoint.head }]),
    );
  }
  return stringifyYaml(output);
}

/** Atomically publish a record through the shared `atomicWrite` writer. */
export async function writeWorkspaceRecord(path: string, record: WorkspaceExecutionRecord): Promise<void> {
  await atomicWrite(path, renderWorkspaceRecord(record));
}

/** The absolute implementation-record path for one repository path (`.` is the workspace root). */
export function implementationRecordPath(root: string, repositoryPath: string, planId: string): string {
  return join(root, repositoryPath, '.ai-workflow', 'plans', planId, 'implementation.yaml');
}

/** An ISO 8601 timestamp in the fixed UTC+08:00 planning timezone. */
export function nowCst(): string {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`;
}

export { errorMessage };
