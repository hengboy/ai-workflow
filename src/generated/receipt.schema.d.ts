/* Generated from authoritative JSON Schemas. Do not edit. */

export type ApprovalReceipt = (
  | ApprovalReceiptV2
  | {
      [k: string]: unknown;
    }
) & {
  [k: string]: unknown;
} & {
  receipt_version: "1.0.0" | "2.0.0";
  workflow_digest?: string;
  baseline_digest?: string;
  plan_id?: string;
  host?: "codex" | "claude" | "opencode";
  engine?: "worker-thread-trusted";
  manifest_digest?: string;
  script_digest?: string;
  args_digest?: string;
  input_artifacts_digest?: string;
  profile_route_digest?: string;
  sandbox_policy_digest?: string;
  target_branch?: string;
  target_head?: string;
  approval_identity?: ApprovalIdentity;
  approved_at?: string;
};
export type Digest = string;

export interface ApprovalReceiptV2 {
  receipt_version: "2.0.0";
  plan_id: string;
  host: "codex" | "claude" | "opencode";
  engine: "worker-thread-trusted";
  manifest_digest: Digest;
  script_digest: Digest;
  args_digest: Digest;
  input_artifacts_digest: Digest;
  profile_route_digest: Digest;
  sandbox_policy_digest: Digest;
  baseline_digest: Digest;
  target_branch: string;
  target_head: string;
  approval_identity: ApprovalIdentity;
  approved_at: string;
}
export interface ApprovalIdentity {
  kind: "local-user";
  subject_digest: Digest;
}
