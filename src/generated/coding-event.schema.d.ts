/* Generated from authoritative JSON Schemas. Do not edit. */

export type RunId = string;
export type CodingEventType =
  | "run/start"
  | "run/lease-acquired"
  | "run/cancel-requested"
  | "run/cancelling"
  | "run/cancelled"
  | "run/end"
  | "run/error"
  | "workflow/phase"
  | "workflow/log"
  | "agent/start"
  | "agent/end"
  | "call/prepared"
  | "call/dispatch-intent"
  | "call/running"
  | "call/observed"
  | "call/checkpointed"
  | "call/retry-scheduled"
  | "call/business-failed"
  | "call/blocked"
  | "call/audit-failed"
  | "call/reconcile-required"
  | "control/prepared"
  | "control/intent"
  | "control/observed"
  | "control/cancelled"
  | "control/reconcile-required"
  | "action/remediated"
  | "action/skipped"
  | "task/admitted"
  | "task/skipped"
  | "task/blocked"
  | "task/finalize-intent"
  | "task/finalized"
  | "task/commit-intent"
  | "task/committed"
  | "scope/lease-acquired"
  | "scope/lease-released"
  | "scope/queued"
  | "test/result"
  | "review/result"
  | "gate/started"
  | "gate/passed"
  | "gate/failed"
  | "repair/started"
  | "repair/completed"
  | "git/baseline"
  | "git/project-lease-acquired"
  | "git/project-lease-released"
  | "git/worktree-intent"
  | "git/worktree-created"
  | "git/commit-intent"
  | "git/commit-observed"
  | "git/merge-intent"
  | "git/merge-observed"
  | "git/integration-intent"
  | "git/integration-observed"
  | "git/cleanup-intent"
  | "git/cleanup-observed"
  | "resource/create-intent"
  | "resource/created"
  | "resource/retained"
  | "resume/replayed"
  | "resume/diverged";
export type CallId = string;
export type Digest = string;
export type Path = string;

export interface CodingRunEvent {
  event_version: "2.0.0";
  seq: number;
  at: string;
  run_id: RunId;
  fencing_epoch: number;
  type: CodingEventType;
  call_id?: CallId;
  task_id?: string;
  transaction_id?: CallId;
  payload: CodingEventPayload;
}
export interface CodingEventPayload {
  engine?: "worker-thread-trusted";
  manifest_digest?: Digest;
  script_digest?: Digest;
  args_digest?: Digest;
  descriptor_digest?: Digest;
  checkpoint_digest?: Digest;
  receipt_digest?: Digest;
  audit_digest?: Digest;
  repair_diff_digest?: Digest;
  source_review_receipt_digest?: Digest;
  policy_digest?: Digest;
  resource_id?: string;
  child_id?: string;
  action_id?: string;
  original_action_id?: string;
  repair_action_id?: string;
  replacement_test_id?: string;
  control_id?: CallId;
  call_ordinal?: number;
  attempt?: number;
  attempt_id?: CallId;
  admission_ordinal?: number;
  state?: string;
  stop_reason?: "completed" | "cancelled" | "error" | "blocked";
  reason?: string;
  message?: string;
  title?: string;
  code?: string;
  error?: string;
  reconciled?: boolean;
  finding_id?: string;
  finding_ids?: string[];
  evidence_paths?: Path[];
  evidence_digests?: Digest[];
  changed_paths?: Path[];
  branch?: string;
  head?: string;
  target_head?: string;
  expected_head?: string;
  path?: Path;
  kind?: string;
  resource_kinds?: string[];
  findings?: ReviewFindingV2[];
  result?: CodingAgentResult;
  gate_id?: string;
  predicate?: string;
  merge_commit?: string;
  commit?: string;
  tree?: string;
}
export interface ReviewFindingV2 {
  finding_id: string;
  ordinal: number;
  source_gate: "standards-review" | "spec-review";
  severity: "error" | "warning" | "info";
  message: string;
  message_digest: string;
  path?: string;
  applicable_action_ids: string[];
}
export interface CodingAgentResult {
  result_version: "2.0.0";
  status: "done" | "blocked" | "failed";
  summary: string;
  changed_paths: string[];
  evidence: string[];
  tests: TestResult[];
  findings: ReviewFindingDraft[];
  git_refs: string[];
  support_requests: string[];
  value?: unknown;
}
export interface TestResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  output?: string;
}
export interface ReviewFindingDraft {
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  applicable_action_ids: string[];
}
