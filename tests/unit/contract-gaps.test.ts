import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { generateWorkflow, applyAdjustments } from '../../src/workflow/generate.js';
import { approveWorkflow, verifyApproval } from '../../src/workflow/approval.js';
import { validateContext } from '../../src/context/validate.js';
import { writeJson } from '../../src/utils/fs.js';
import { frozenPlan, gitInit, temporary } from '../helpers.js';

describe('contract and command gaps', () => {
  it('applies gate adjustments and validates the resulting graph', async () => {
    const root = await temporary(); const workflow = await generateWorkflow(await frozenPlan(root), 'codex');
    const adjusted = applyAdjustments(workflow, [{ op: 'add-gate', gate: { id: 'context', after: ['plan-validate'], kind: 'context-valid' } }]);
    expect(adjusted.gates.some((gate) => gate.id === 'context')).toBe(true);
    const removed = applyAdjustments(adjusted, [{ op: 'remove-gate', gate: { id: 'context' } }]);
    expect(removed.gates.some((gate) => gate.id === 'context')).toBe(false);
  });
  it('binds approval to the baseline digest and rejects drift', async () => {
    const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'codex'); const path = join(plan, 'workflow.json'); await writeJson(path, workflow);
    const receipt = await approveWorkflow(path, root); expect(receipt.baseline_digest).toMatch(/^sha256:/); await verifyApproval(path, workflow, root); await writeFile(join(root, 'drift.txt'), 'changed'); await expect(verifyApproval(path, workflow, root)).rejects.toThrow(/baseline/);
  });
  it('validates lifecycle phases as a fixed contract', async () => {
    const root = await temporary(); const workflow = await generateWorkflow(await frozenPlan(root), 'codex'); workflow.phases = ['executing']; const module = await import('../../src/workflow/validate.js'); const result = await module.validateWorkflow(workflow); expect(result.valid).toBe(false); expect(result.errors.join(' ')).toMatch(/phase/i);
  });
});
