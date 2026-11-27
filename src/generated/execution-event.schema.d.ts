/* Generated from authoritative JSON Schemas. Do not edit. */

export type Timestamp = string;

export interface ExecutionEvent {
  event_id: string;
  run_id: string;
  plan_id: string;
  type:
    | "workflow.started"
    | "workflow.completed"
    | "workflow.failed"
    | "workflow.paused"
    | "workflow.cancelled"
    | "task.started"
    | "task.completed"
    | "task.failed"
    | "agent.invoked"
    | "agent.completed"
    | "validation.completed"
    | "review.started"
    | "review.completed"
    | "repair.completed"
    | "delivery.completed"
    | "execution.interrupted"
    | "execution.resumed"
    | "execution.reconciled"
    | "failure.quota"
    | "failure.authentication"
    | "failure.rate_limit"
    | "failure.model_unavailable"
    | "failure.network_timeout"
    | "failure.network_disconnect"
    | "failure.agent_process_exit"
    | "failure.session_lost"
    | "failure.task_execution";
  timestamp: Timestamp;
  task_id?: string;
  invocation_id?: string;
  payload?: {
    [k: string]: unknown;
  };
}
