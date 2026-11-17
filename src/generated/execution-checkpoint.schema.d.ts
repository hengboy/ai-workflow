/* Generated from authoritative JSON Schemas. Do not edit. */

export type Timestamp = string;

export interface ExecutionCheckpoint {
  checkpoint_id: string;
  run_id: string;
  plan_id: string;
  plan_digest: string;
  task_states: {
    [k: string]: TaskState;
  };
  attempt_counts: {
    [k: string]: number;
  };
  created_at: Timestamp;
  repository?: string;
  phase?: string;
  agent_binding?: AgentBinding;
  last_persisted_event_id?: string;
}
export interface TaskState {
  status: "pending" | "running" | "completed" | "failed";
  commit?: string;
  head?: string;
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
