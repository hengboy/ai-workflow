import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeJson } from '../../src/utils/fs.js';
import { generateWorkflow } from '../../src/workflow/generate.js';
import { approveWorkflow } from '../../src/workflow/approval.js';
import { cancelRun, cleanupRun, resumeRun, startRun } from '../../src/runtime/runner.js';
import { exists } from '../../src/utils/fs.js';
import { frozenPlan, gitInit, temporary } from '../helpers.js';

describe('runtime lifecycle', () => {
  it('requires a matching receipt and completes nodes idempotently', async () => { const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'codex'); const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await expect(startRun({ workflowPath: path, host: 'codex', project: root })).rejects.toThrow(/receipt/); await approveWorkflow(path); const calls: string[] = []; const run = await startRun({ workflowPath: path, host: 'codex', project: root, executor: async (id) => { calls.push(id); return { ok: true }; } }); expect(run.state).toBe('complete'); expect(calls).toHaveLength(workflow.nodes.length); expect(await exists(join(root, '.ai-workflow/runs', run.run_id, 'summary.md'))).toBe(true); await cleanupRun(root, run.run_id); expect(await exists(join(root, '.ai-workflow/runs', `${run.run_id}.final.json`))).toBe(true); });
  it('pauses after retries and resumes without repeating success', async () => { const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'claude'); workflow.nodes[0]!.retry = 0; const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await approveWorkflow(path); const run = await startRun({ workflowPath: path, host: 'claude', project: root, executor: async () => { throw new Error('boom'); } }); expect(run.state).toBe('paused'); const resumed = await resumeRun(root, run.run_id, async () => ({ ok: true })); expect(resumed.state).toBe('complete'); });
  it('cancels and then permits cleanup', async () => { const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'opencode'); const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await approveWorkflow(path); const run = await startRun({ workflowPath: path, host: 'opencode', project: root, defer: true }); const cancelled = await cancelRun(root, run.run_id); expect(cancelled.state).toBe('cancelled'); await cleanupRun(root, run.run_id); });
});
