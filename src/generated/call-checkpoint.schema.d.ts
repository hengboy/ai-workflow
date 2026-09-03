/* Generated from authoritative JSON Schemas. Do not edit. */

export type CallId = string;
export type ActionId = string;
export type Digest = string;
export type Path = string;

export interface CallCheckpoint {
  checkpoint_version: "2.0.0";
  call_id: CallId;
  call_ordinal: number;
  action_id: ActionId;
  task_id: string;
  descriptor_digest: Digest;
  attempt: number;
  attempt_id: CallId;
  state: "checkpointed";
  result: CodingAgentResult;
  audit_digest: Digest;
  changed_paths?: Path[];
}
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
