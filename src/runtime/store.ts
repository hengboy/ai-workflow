import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { atomicWrite, exists } from '../utils/fs.js';
import type { RunState } from './state.js';

export interface NodeRecord { status: 'pending' | 'running' | 'done' | 'failed' | 'blocked'; attempts: number; idempotency_key: string; result?: unknown }
export interface RunRecord { run_id: string; project: string; workflow_path: string; workflow_digest: string; plan_id: string; host: string; state: RunState; resume_state?: RunState; started_at: string; updated_at: string; baseline?: string; cancelled: boolean; nodes: Record<string, NodeRecord>; events: Array<{ at: string; state: RunState; message: string }> }
export function runDirectory(project: string, runId: string): string { return join(project, '.ai-workflow/runs', runId); }
export async function saveRun(record: RunRecord): Promise<void> { const directory = runDirectory(record.project, record.run_id); await mkdir(join(directory, 'checkpoints'), { recursive: true }); record.updated_at = new Date().toISOString(); await atomicWrite(join(directory, 'state.json'), `${JSON.stringify(record, null, 2)}\n`); }
export async function loadRun(project: string, runId: string): Promise<RunRecord> { const path = join(runDirectory(project, runId), 'state.json'); if (!(await exists(path))) throw new Error(`Unknown run: ${runId}`); return JSON.parse(await readFile(path, 'utf8')) as RunRecord; }
