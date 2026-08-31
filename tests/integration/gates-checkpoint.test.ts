import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startRun, resumeRun } from '../../src/runtime/runner.js';
import { generateWorkflow } from '../../src/workflow/generate.js';
import { approveWorkflow } from '../../src/workflow/approval.js';
import { writeJson, exists } from '../../src/utils/fs.js';
import { frozenPlan, gitInit, temporary } from '../helpers.js';
const done = { status: 'done' as const, summary: 'ok', changed_paths: [] as string[], evidence: [] as string[], tests: [], findings: [], git_refs: [], support_requests: [] as string[] };
describe('runtime gates and checkpoints', () => {
  it('pauses on blocking review findings instead of completing', async () => { const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'codex'); const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await approveWorkflow(path, root); const run = await startRun({ workflowPath: path, host: 'codex', project: root, executor: async (id, context) => { if (id === 'standards-review') return { ...done, findings: [{ severity: 'error' as const, message: 'bad' }] }; if (id.endsWith('-implement')) { await (await import('node:fs/promises')).mkdir(join(context.cwd, 'src'), { recursive: true }); await writeFile(join(context.cwd, 'src/output.ts'), 'done'); } return done; } }); expect(run.state).toBe('paused'); expect(run.nodes['standards-review']?.status).toBe('failed'); });
  it('records a checkpoint for every successful node', async () => { const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'codex'); const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await approveWorkflow(path, root); const run = await startRun({ workflowPath: path, host: 'codex', project: root, executor: async (id, context) => { if (id.endsWith('-implement')) { await (await import('node:fs/promises')).mkdir(join(context.cwd, 'src'), { recursive: true }); await writeFile(join(context.cwd, 'src/output.ts'), 'done'); } return done; } }); expect(run.state).toBe('complete'); for (const node of workflow.nodes) expect(await exists(join(root, '.ai-workflow/runs', run.run_id, 'checkpoints', `${node.id}.json`))).toBe(true); });
  it('enters repairing before resuming a repair-once failure', async () => { const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'codex'); const explore = workflow.nodes.find((node) => node.id.endsWith('-explore'))!; explore.retry = 0; explore.on_failure = 'repair_once'; const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await approveWorkflow(path, root); const run = await startRun({ workflowPath: path, host: 'codex', project: root, executor: async () => { throw new Error('failure'); } }); expect(run.state).toBe('paused'); expect(run.resume_state).toBe('repairing'); const resumed = await resumeRun(root, run.run_id, async (id, context) => { if (id.endsWith('-implement')) { await (await import('node:fs/promises')).mkdir(join(context.cwd, 'src'), { recursive: true }); await writeFile(join(context.cwd, 'src/output.ts'), 'done'); } return done; }); expect(resumed.state).toBe('complete'); expect(resumed.events.some((event) => event.state === 'repairing')).toBe(true); });
  it('runs spec-review once and skips it after repair on resume', async () => {
    const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'codex'); const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await approveWorkflow(path, root);
    let reviews = 0;
    const first = await startRun({ workflowPath: path, host: 'codex', project: root, executor: async (id, context) => {
      if (id === 'spec-review') { reviews += 1; return { ...done, findings: [{ severity: 'error' as const, message: 'needs repair' }] }; }
      if (id.endsWith('-implement')) { await (await import('node:fs/promises')).mkdir(join(context.cwd, 'src'), { recursive: true }); await writeFile(join(context.cwd, 'src/output.ts'), 'done'); }
      return done;
    } });
    expect(first.state).toBe('paused'); expect(reviews).toBe(1); expect(first.nodes['spec-review']?.status).toBe('failed'); expect(first.nodes['spec-review']?.result).toMatchObject({ reason: 'review_findings' });
    const resumed = await resumeRun(root, first.run_id, async (id) => { if (id === 'spec-review') throw new Error('spec-review must not run twice'); return done; });
    expect(resumed.state).toBe('complete'); expect(reviews).toBe(1); expect(resumed.nodes['spec-review']?.status).toBe('done');
  });
});
