/* Generated from authoritative JSON Schemas. Do not edit. */

export type RunId = string;
export type Digest = string;
export type RunStateV2 =
  | "preflight"
  | "executing"
  | "reconciling"
  | "validating"
  | "reviewing"
  | "repairing"
  | "integrating"
  | "complete"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "cancelled-with-retained-resources";
export type CallId = string;
export type ActionId = string;

export interface CodingRunRecord {
  record_version: "2.0.0";
  engine: "worker-thread-trusted";
  run_id: RunId;
  manifest_digest: Digest;
  fencing_epoch: number;
  run_state: RunStateV2;
  parent_run: string;
  started_at: string;
  updated_at: string;
  stop_reason?: "completed" | "cancelled" | "error" | "blocked";
  call_ledger: CallLedgerEntry[];
  control_ledger: ControlLedgerEntry[];
  resources: CodingResource[];
  completed_tasks?: string[];
  blocked_tasks?: string[];
}
export interface CallLedgerEntry {
  call_id: CallId;
  call_ordinal: number;
  action_id: ActionId;
  task_id: string;
  descriptor_digest: Digest;
  attempt: number;
  attempt_id: CallId;
  state:
    | "prepared"
    | "dispatch_intent"
    | "running"
    | "observed"
    | "checkpointed"
    | "transient_failed"
    | "retry_scheduled"
    | "business_failed"
    | "blocked"
    | "cancelled"
    | "reconcile_required";
  checkpoint_digest?: Digest;
  audit_digest?: Digest;
  child_id?: string;
  pid?: number;
  pgid?: number;
}
export interface ControlLedgerEntry {
  control_id: CallId;
  control_ordinal: number;
  operation: "finalize-task" | "skip-action" | "skip-task";
  descriptor_digest: Digest;
  state: "prepared" | "intent" | "observed" | "cancelled" | "reconcile_required";
  receipt_digest?: Digest;
}
export interface CodingResource {
  resource_version: "2.0.0";
  resource_type: "owned-git-resource";
  resource_id: string;
  run_id: string;
  fencing_epoch: number;
  manifest_digest: Digest;
  git_common_dir_digest: Digest;
  kind:
    | "plan-worktree"
    | "task-worktree"
    | "repair-worktree"
    | "repair-test-worktree"
    | "plan-branch"
    | "task-branch"
    | "repair-branch"
    | "repair-test-branch";
  canonical_path?: string;
  branch?: string;
  base_ref: string;
  created_head: string;
  owner_trailer?: string;
  creation_intent_digest: Digest;
  creation_transaction_id: string;
  committed: boolean;
}
