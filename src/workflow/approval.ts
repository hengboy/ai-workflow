import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ApprovalReceipt } from '../generated/receipt.schema.js';
import type { Workflow } from './types.js';
import { objectDigest } from '../utils/hash.js';
import { writeJson, readJson, exists } from '../utils/fs.js';
import { gitBaseline } from '../git/operator.js';
import { relative } from 'node:path';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';

export function receiptPath(workflowPath: string): string { return join(dirname(workflowPath), 'approval.receipt.json'); }
async function baselineDigest(project: string, receipt: string): Promise<string> {
  const baseline = await gitBaseline(project); const ignored = relative(project, receipt).replaceAll('\\', '/');
  const status = baseline.status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter((entry) => entry !== ignored && !entry.startsWith('ai-workflow/') && !entry.startsWith('.ai-workflow/')).sort();
  return objectDigest({ branch: baseline.branch, head: baseline.head, status });
}
export async function approveWorkflow(workflowPath: string, project = process.cwd()): Promise<ApprovalReceipt> {
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8')) as Workflow;
  const receipt: ApprovalReceipt = { receipt_version: '1.0.0', workflow_digest: objectDigest(workflow), baseline_digest: await baselineDigest(project, receiptPath(workflowPath)), plan_id: workflow.plan_id, host: workflow.host, approved_at: new Date().toISOString() };
  const validate = await schemaValidator('receipt.schema.json'); if (!validate(receipt)) throw new Error(formatSchemaErrors(validate.errors));
  await writeJson(receiptPath(workflowPath), receipt); return receipt;
}
export async function verifyApproval(workflowPath: string, workflow: Workflow, project = process.cwd()): Promise<ApprovalReceipt> {
  const path = receiptPath(workflowPath); if (!(await exists(path))) throw new Error('Missing approval receipt'); const receipt = await readJson<ApprovalReceipt>(path);
  const validate = await schemaValidator('receipt.schema.json'); if (!validate(receipt)) throw new Error(`Invalid approval receipt: ${formatSchemaErrors(validate.errors)}`);
  if (receipt.workflow_digest !== objectDigest(workflow) || receipt.plan_id !== workflow.plan_id || receipt.host !== workflow.host) throw new Error('Approval receipt does not match workflow'); if (receipt.baseline_digest !== await baselineDigest(project, path)) throw new Error('Approval baseline changed'); return receipt;
}
