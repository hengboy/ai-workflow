/* Generated from authoritative JSON Schemas. Do not edit. */

export type Timestamp = string;

export interface ExecutionRun {
  run_id: string;
  plan_id: string;
  plan_digest: string;
  status: "CREATED" | "RUNNING" | "PAUSED" | "INTERRUPTED" | "RESUMING" | "COMPLETED" | "FAILED" | "CANCELLED";
  plan_created_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  failure_count: number;
  repository?: string;
  phase?: string;
  started_at?: Timestamp;
  completed_at?: Timestamp;
  last_failure?: Failure;
  tasks?: {
    [k: string]: TaskState;
  };
  agent?: AgentBinding;
}
export interface Failure {
  category:
    | "quota"
    | "authentication"
    | "rate_limit"
    | "model_unavailable"
    | "network_timeout"
    | "network_disconnect"
    | "agent_process_exit"
    | "session_lost"
    | "task_execution";
  action: "retry" | "pause" | "repair";
  summary: string;
  recorded_at: Timestamp;
}
export interface TaskState {
  status: "pending" | "running" | "completed" | "failed";
  commit?: string;
  head?: string;
  started_at?: Timestamp;
  completed_at?: Timestamp;
}
export interface AgentBinding {
  invocation_id: string;
  host: string;
  session_id: string;
  parent_session_id?: string;
  role?: string;
  model?: string;
  tokens?: number;
  cost?: number;
}
