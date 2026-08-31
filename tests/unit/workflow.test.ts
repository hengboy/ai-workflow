import { describe, expect, it } from 'vitest';
import { generateWorkflow, applyAdjustments } from '../../src/workflow/generate.js';
import { validateWorkflow } from '../../src/workflow/validate.js';
import { frozenPlan, temporary } from '../helpers.js';

describe('workflow generation and validation', () => {
  it('deterministically generates a schema-valid task DAG', async () => { const root = await temporary(); const plan = await frozenPlan(root); const first = await generateWorkflow(plan, 'codex'); const second = await generateWorkflow(plan, 'codex'); expect(first).toEqual(second); expect((await validateWorkflow(first)).valid).toBe(true); expect(first.nodes[0]?.task_id).toBe('task-001-example'); });
  it('creates a plan-wide task worker without task files', async () => { const root = await temporary(); const workflow = await generateWorkflow(await frozenPlan(root, false), 'claude'); expect(workflow.nodes.some((node) => node.role === 'task-worker')).toBe(true); });
  it('detects cycles and overlapping parallel write scopes', async () => { const root = await temporary(); const workflow = await generateWorkflow(await frozenPlan(root), 'codex'); const clone = structuredClone(workflow); const first = clone.nodes.find((node) => node.id === 'task-001-example-implement')!; const second = { ...first, id: 'task-002-example-implement', task_id: 'task-002-example', depends_on: ['task-001-example-implement'] }; clone.nodes.push(second); first.depends_on = ['task-002-example-implement']; const result = await validateWorkflow(clone); expect(result.valid).toBe(false); expect(result.errors.join(' ')).toMatch(/Cycle|Overlapping/); });
  it('limits structured adjustments to orchestration fields', async () => { const root = await temporary(); const workflow = await generateWorkflow(await frozenPlan(root), 'opencode'); const adjusted = applyAdjustments(workflow, [{ op: 'set-concurrency', value: 1 }, { op: 'set-retry', node: 'task-001-example', value: 0 }]); expect(adjusted.concurrency).toBe(1); expect(adjusted.nodes[0]?.retry).toBe(0); expect(() => applyAdjustments(workflow, [{ op: 'set-write-scope', node: 'task-001-example', value: [] }])).toThrow(/Unsupported/); });
});
