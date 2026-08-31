/* Generated from authoritative JSON Schemas. Do not edit. */

export interface ApprovalReceipt {
  receipt_version: "1.0.0";
  workflow_digest: string;
  plan_id: string;
  host: "codex" | "claude" | "opencode";
  approved_at: string;
}
