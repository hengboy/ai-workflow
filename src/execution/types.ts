export type { ExecutionCheckpoint } from '../generated/execution-checkpoint.schema.js';
export type { ExecutionEvent } from '../generated/execution-event.schema.js';
export type { ExecutionLock } from '../generated/execution-lock.schema.js';
export type { ExecutionRun } from '../generated/execution-run.schema.js';

const RUN_STATUS_VALUES = [
  'CREATED',
  'RUNNING',
  'PAUSED',
  'INTERRUPTED',
  'RESUMING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunStatus = (typeof RUN_STATUS_VALUES)[number];
/** Lifecycle statuses recorded for one repository execution run. */
export const RUN_STATUSES: RunStatus[] = Object.freeze([...RUN_STATUS_VALUES]) as RunStatus[];

const EXECUTION_EVENT_TYPE_VALUES = [
  'workflow.started',
  'workflow.completed',
  'workflow.failed',
  'workflow.paused',
  'workflow.cancelled',
  'task.started',
  'task.completed',
  'task.failed',
  'agent.invoked',
  'agent.completed',
  'validation.completed',
  'review.started',
  'review.completed',
  'repair.completed',
  'delivery.completed',
  'execution.interrupted',
  'execution.resumed',
  'execution.reconciled',
  'failure.quota',
  'failure.authentication',
  'failure.rate_limit',
  'failure.model_unavailable',
  'failure.network_timeout',
  'failure.network_disconnect',
  'failure.agent_process_exit',
  'failure.session_lost',
  'failure.task_execution',
] as const;
export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPE_VALUES)[number];
/** Event types emitted by the execution recorder. */
export const EXECUTION_EVENT_TYPES: ExecutionEventType[] = Object.freeze([...EXECUTION_EVENT_TYPE_VALUES]) as ExecutionEventType[];

const FAILURE_CATEGORY_VALUES = [
  'quota',
  'authentication',
  'rate_limit',
  'model_unavailable',
  'network_timeout',
  'network_disconnect',
  'agent_process_exit',
  'session_lost',
  'task_execution',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORY_VALUES)[number];
/** Failure categories used to classify an interrupted run. */
export const FAILURE_CATEGORIES: FailureCategory[] = Object.freeze([...FAILURE_CATEGORY_VALUES]) as FailureCategory[];

const TASK_STATUS_VALUES = ['pending', 'running', 'completed', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];
/** Per-task states recorded in a run and its recovery checkpoints. */
export const TASK_STATUSES: TaskStatus[] = Object.freeze([...TASK_STATUS_VALUES]) as TaskStatus[];
