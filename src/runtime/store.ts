import { join } from 'node:path';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { atomicWrite, exists } from '../utils/fs.js';
import type { RunState } from './state.js';
import type { CodingAgentResult } from '../generated/coding-agent-result.schema.js';

export interface NodeRecord { status: 'pending' | 'running' | 'done' | 'failed' | 'blocked'; attempts: number; idempotency_key: string; result?: unknown }
export interface RunResources { start_branch: string; start_head: string | null; plan_worktree?: string; plan_branch?: string; task_worktrees: Record<string, string>; task_branches: Record<string, string>; commits: Record<string, string>; merge_commit?: string }
export interface RunRecord { run_id: string; project: string; workflow_path: string; workflow_digest: string; plan_id: string; host: string; state: RunState; resume_state?: RunState; started_at: string; updated_at: string; baseline?: string; cancelled: boolean; resources: RunResources; nodes: Record<string, NodeRecord>; events: Array<{ at: string; state: RunState; message: string }> }
export function runDirectory(project: string, runId: string): string { return join(project, '.ai-workflow/runs', runId); }
export async function saveRun(record: RunRecord): Promise<void> { const directory = runDirectory(record.project, record.run_id); await mkdir(join(directory, 'checkpoints'), { recursive: true }); record.updated_at = new Date().toISOString(); await atomicWrite(join(directory, 'state.json'), `${JSON.stringify(record, null, 2)}\n`); }
export async function loadRun(project: string, runId: string): Promise<RunRecord> { const path = join(runDirectory(project, runId), 'state.json'); if (!(await exists(path))) throw new Error(`Unknown run: ${runId}`); return JSON.parse(await readFile(path, 'utf8')) as RunRecord; }

export interface CallCheckpoint {
  checkpoint_version: '2.0.0';
  call_id: string;
  call_ordinal: number;
  action_id: string;
  task_id: string;
  descriptor_digest: string;
  attempt: number;
  attempt_id: string;
  state: 'checkpointed';
  result: CodingAgentResult;
  audit_digest: string;
  changed_paths?: string[];
}

export async function ensureRunStorage(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const name of ['checkpoints', 'controls', 'task-checkpoints', 'receipts']) {
    const path = join(directory, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}

export async function writeCallCheckpoint(directory: string, checkpoint: CallCheckpoint): Promise<void> {
  await ensureRunStorage(directory);
  await atomicWrite(join(directory, 'checkpoints', `${checkpoint.call_id}.json`), `${JSON.stringify(checkpoint, null, 2)}\n`);
}

export async function readCallCheckpoint(directory: string, callId: string): Promise<CallCheckpoint> {
  const path = join(directory, 'checkpoints', `${callId}.json`);
  if (!(await exists(path))) throw new Error(`Unknown checkpoint: ${callId}`);
  return JSON.parse(await readFile(path, 'utf8')) as CallCheckpoint;
}

export async function writeControlReceipt(directory: string, controlId: string, value: unknown): Promise<void> {
  await ensureRunStorage(directory);
  await atomicWrite(join(directory, 'controls', `${controlId}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

export async function readControlReceipt<T>(directory: string, controlId: string): Promise<T> {
  const path = join(directory, 'controls', `${controlId}.json`);
  if (!(await exists(path))) throw new Error(`Unknown control receipt: ${controlId}`);
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
