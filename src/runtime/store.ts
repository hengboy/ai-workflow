import { join } from 'node:path';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { atomicWrite, exists } from '../utils/fs.js';
import type { RunState } from './state.js';
import type { CodingAgentResult } from '../generated/coding-agent-result.schema.js';
import type { CallLedgerEntry, ControlLedgerEntry } from './ledger.js';

export interface NodeRecord { status: 'pending' | 'running' | 'done' | 'failed' | 'blocked'; attempts: number; idempotency_key: string; result?: unknown }
export interface RunResources { start_branch: string; start_head: string | null; plan_worktree?: string; plan_branch?: string; task_worktrees: Record<string, string>; task_branches: Record<string, string>; commits: Record<string, string>; merge_commit?: string }
export interface RunRecord { record_version?: '1.0.0'; run_id: string; project: string; workflow_path: string; workflow_digest: string; plan_id: string; host: string; state: RunState; resume_state?: RunState; started_at: string; updated_at: string; baseline?: string; cancelled: boolean; resources: RunResources; nodes: Record<string, NodeRecord>; events: Array<{ at: string; state: RunState; message: string }> }
export function runDirectory(project: string, runId: string): string { return join(project, '.ai-workflow/runs', runId); }
export class RunVersionError extends Error {
  readonly name = 'RunVersionError';
  constructor(readonly code: 'RUN_VERSION_MISMATCH' | 'RUN_RECORD_INVALID', message: string) { super(message); }
}
export async function saveRun(record: RunRecord): Promise<void> { const directory = runDirectory(record.project, record.run_id); await mkdir(join(directory, 'checkpoints'), { recursive: true }); record.updated_at = new Date().toISOString(); await atomicWrite(join(directory, 'state.json'), `${JSON.stringify({ ...record, record_version: '1.0.0' }, null, 2)}\n`); }
export async function loadRun(project: string, runId: string): Promise<RunRecord> { const path = join(runDirectory(project, runId), 'state.json'); if (!(await exists(path))) throw new Error(`Unknown run: ${runId}`); const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; if (record.record_version === '2.0.0' || 'call_ledger' in record || 'control_ledger' in record) throw new RunVersionError('RUN_VERSION_MISMATCH', `v1 loader cannot read v2 run: ${runId}`); return { ...record, record_version: '1.0.0' } as unknown as RunRecord; }

export type RunStateV2 = 'preflight' | 'executing' | 'reconciling' | 'validating' | 'reviewing' | 'repairing' | 'integrating' | 'complete' | 'paused' | 'cancelling' | 'cancelled' | 'cancelled-with-retained-resources';
export interface RunRecordV2 {
  record_version: '2.0.0';
  engine: 'worker-thread-trusted';
  run_id: string;
  manifest_digest: string;
  fencing_epoch: number;
  run_state: RunStateV2;
  parent_run: string;
  started_at: string;
  updated_at: string;
  stop_reason?: 'completed' | 'cancelled' | 'error' | 'blocked';
  call_ledger: CallLedgerEntry[];
  control_ledger: ControlLedgerEntry[];
  resources: unknown[];
  completed_tasks?: string[];
  blocked_tasks?: string[];
  pause_reason?: string;
  resume_evidence?: ResumeAuthorityEvidence;
  authority?: V2AuthorityDescriptor;
}

export interface V2AuthorityDescriptor {
  authority_version: '1.0.0';
  manifest_path: string;
  manifest_digest: string;
  script_path: string;
  script_digest: string;
  args_path: string;
  args_digest: string;
  approval_path: string;
  approval_digest: string;
  profile_digest: string;
  sandbox_digest: string;
  baseline_digest: string;
  fencing_epoch: number;
  restart_capability: 'worker-thread-trusted-v2';
}

export interface ResumeAuthorityEvidence {
  manifest_digest: string;
  script_digest: string;
  args_digest: string;
  approval_digest: string;
  profile_digest: string;
  sandbox_digest: string;
  baseline_digest: string;
}

export async function saveV2Run(project: string, record: RunRecordV2): Promise<void> {
  if (record.record_version !== '2.0.0' || record.engine !== 'worker-thread-trusted') throw new RunVersionError('RUN_RECORD_INVALID', 'v2 record discriminator is invalid');
  await ensureRunStorage(runDirectory(project, record.run_id));
  record.updated_at = new Date().toISOString();
  await atomicWrite(join(runDirectory(project, record.run_id), 'state.json'), `${JSON.stringify(record, null, 2)}\n`);
}

export async function loadV2Run(project: string, runId: string): Promise<RunRecordV2> {
  const directory = runDirectory(project, runId);
  const path = join(directory, 'state.json');
  if (!(await exists(path))) throw new Error(`Unknown run: ${runId}`);
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (record.record_version !== '2.0.0' || record.engine !== 'worker-thread-trusted' || 'nodes' in record) throw new RunVersionError('RUN_VERSION_MISMATCH', `v2 loader cannot read v1 run: ${runId}`);
  if (!(await exists(join(directory, 'events.jsonl')))) throw new RunVersionError('RUN_RECORD_INVALID', `v2 run has no event authority: ${runId}`);
  return record as unknown as RunRecordV2;
}

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

export interface ResumeFingerprint {
  workflow: string;
  script: string;
  args: string;
  manifest: string;
  profile: string;
  baseline: string;
}

export class ResumeDivergedError extends Error {
  readonly name = 'ResumeDivergedError';
  constructor(readonly field: keyof ResumeFingerprint, message: string) { super(message); }
}

export function assertResumeFingerprint(expected: ResumeFingerprint, current: ResumeFingerprint): void {
  for (const field of Object.keys(expected) as Array<keyof ResumeFingerprint>) {
    if (expected[field] !== current[field]) throw new ResumeDivergedError(field, `${field} drift prevents resume`);
  }
}
