/* Generated from authoritative JSON Schemas. Do not edit. */

export type CodingProtocolMessage = HostToWorker | WorkerToHost;
export type HostToWorker = {
  [k: string]: unknown;
} & {
  type:
    | "go"
    | "cancel"
    | "agent-started"
    | "agent-settled"
    | "agent-start-error"
    | "agent-disposed"
    | "task-control-settled"
    | "task-control-error";
  protocol_version: "2.0.0";
  run_id: RunId;
  message_id: number;
  request_id?: CallId;
  call_id?: CallId;
  child_id?: string;
  control_id?: CallId;
  reason?: string;
  result?: CodingAgentResult;
  error?: WorkflowErrorInfo;
  state?: "finalized" | "committed" | "skipped";
  receipt_digest?: Digest;
};
export type RunId = string;
export type CallId = string;
export type Digest = string;
export type WorkerToHost = {
  [k: string]: unknown;
} & {
  type: "ready" | "agent-start" | "agent-dispose" | "task-control" | "phase" | "log" | "result";
  protocol_version: "2.0.0";
  run_id: RunId;
  message_id: number;
  request_id?: CallId;
  call_id?: CallId;
  descriptor?: CallDescriptor;
  control_id?: CallId;
  control_descriptor?: TaskControlDescriptor;
  title?: string;
  message?: string;
  result?: CodingWorkflowResult;
};
export type ActionId = string;

export interface CodingAgentResult {
  result_version: "2.0.0";
  status: "done" | "blocked" | "failed";
  summary: string;
  changed_paths: unknown[];
  evidence: unknown[];
  tests: unknown[];
  findings: unknown[];
  git_refs: unknown[];
  support_requests: unknown[];
  value?: unknown;
}
export interface WorkflowErrorInfo {
  code:
    | "SCRIPT_API_FORBIDDEN"
    | "SCRIPT_PARSE"
    | "ACTION_NOT_AUTHORIZED"
    | "TASK_NOT_AUTHORIZED"
    | "ACTION_NOT_READY"
    | "REPLAY_DIVERGED"
    | "PARALLEL_SCOPE_CONFLICT"
    | "PROTOCOL_VIOLATION"
    | "CANCEL_UNAUTHORIZED"
    | "CANCEL_CONTROL_STALE"
    | "NAVIGATION_DIGEST_MISMATCH"
    | "NAVIGATION_INVALID"
    | "ACTION_SANDBOX_UNAVAILABLE"
    | "AUDIT_SYMLINK_CHANGE"
    | "V2_ADJUSTMENTS_UNSUPPORTED"
    | "CLEANUP_OWNERSHIP_UNPROVEN"
    | "WORKFLOW_RECEIPT_MISMATCH"
    | "FROZEN_INPUT_DRIFT"
    | "EXECUTION_ROUTE_DRIFT"
    | "GIT_BASELINE_DRIFT"
    | "APPROVAL_IDENTITY_MISMATCH"
    | "TASK_SKIP_FORBIDDEN"
    | "OUTPUT_CONTRACT_INVALID"
    | "ACTION_SCOPE_VIOLATION"
    | "LEASE_LOST"
    | "WORKER_DEAD"
    | "WORKFLOW_VERSION_UNSUPPORTED"
    | "RUN_VERSION_UNSUPPORTED"
    | "LEGACY_CANCEL_UNAVAILABLE"
    | "LEGACY_RESUME_UNSUPPORTED";
  message: string;
  fatal: true;
}
export interface CallDescriptor {
  call_id: CallId;
  call_ordinal: number;
  action_id: ActionId;
  task_id: string;
  prompt: string;
  label?: string;
  phase?: string;
  pipeline_item_key?: string;
  manifest_digest: Digest;
  script_digest: Digest;
  args_digest: Digest;
  action_digest: Digest;
  descriptor_digest: Digest;
}
export interface TaskControlDescriptor {
  control_id: CallId;
  control_ordinal: number;
  operation: "finalize-task" | "skip-action" | "skip-task";
  task_id?: string;
  action_id?: ActionId;
  reason?: string;
  manifest_digest: Digest;
  script_digest: Digest;
  args_digest: Digest;
  descriptor_digest: Digest;
}
export interface CodingWorkflowResult {
  value: unknown;
  stop_reason: "completed" | "cancelled" | "error" | "blocked";
  error?: string;
  agents_started: number;
  completed_tasks: string[];
  blocked_tasks: string[];
}
