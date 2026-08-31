import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ApprovalReceipt } from '../generated/receipt.schema.js';
import type { Workflow } from './types.js';
import { objectDigest } from '../utils/hash.js';
import { writeJson, readJson, exists } from '../utils/fs.js';

export function receiptPath(workflowPath: string): string { return join(dirname(workflowPath), 'approval.receipt.json'); }
export async function approveWorkflow(workflowPath: string): Promise<ApprovalReceipt> {
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8')) as Workflow;
  const receipt: ApprovalReceipt = { receipt_version: '1.0.0', workflow_digest: objectDigest(workflow), plan_id: workflow.plan_id, host: workflow.host, approved_at: new Date().toISOString() };
  await writeJson(receiptPath(workflowPath), receipt); return receipt;
}
export async function verifyApproval(workflowPath: string, workflow: Workflow): Promise<ApprovalReceipt> {
  const path = receiptPath(workflowPath); if (!(await exists(path))) throw new Error('Missing approval receipt'); const receipt = await readJson<ApprovalReceipt>(path);
  if (receipt.workflow_digest !== objectDigest(workflow) || receipt.plan_id !== workflow.plan_id || receipt.host !== workflow.host) throw new Error('Approval receipt does not match workflow'); return receipt;
}
