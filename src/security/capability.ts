import type { AgentPacket } from '../generated/packet.schema.js';
import type { CodingActionCapability, CodingTaskCapability, HostExecution } from '../generated/coding-manifest.schema.js';
import type { ScopeLease, ScopeScheduler } from '../runtime/scheduler.js';

export type Host = HostExecution['adapter'];
export type HostExecutionMode = HostExecution['mode'];

export interface ActionCapability extends Pick<CodingActionCapability, 'action_id' | 'task_id' | 'operation' | 'role' | 'locator_read_order' | 'read_scope' | 'write_scope' | 'new_module_directories' | 'allowed_commands' | 'test_commands' | 'requires_actions' | 'max_attempts' | 'optional' | 'write_access' | 'host_only' | 'concurrency_group_id'> {
  output_schema?: string;
  action_digest?: string;
}

export interface TaskCapability extends Partial<Pick<CodingTaskCapability, 'depends_on' | 'required_actions' | 'optional_actions' | 'finalization_action'>> {
  task_id: string;
  feature?: string;
}

export interface ActionCapabilityManifest {
  plan_id: string;
  host: Host;
  host_execution: HostExecution;
  tasks: readonly TaskCapability[];
  actions: readonly ActionCapability[];
}

export type TaskState = 'pending' | 'ready' | 'running' | 'done' | 'blocked' | 'failed' | 'cancelled' | 'finalized';
export type ActionState = 'prepared' | 'dispatch_intent' | 'running' | 'observed' | 'checkpointed' | 'transient_failed' | 'retry_scheduled' | 'business_failed' | 'blocked' | 'cancelled' | 'reconcile_required' | 'done';

export interface ActionAdmissionRequest {
  manifest: ActionCapabilityManifest;
  action_id: string;
  run_id: string;
  cwd: string;
  attempt: number;
  task_states: Readonly<Record<string, TaskState>>;
  action_states: Readonly<Record<string, ActionState>>;
  active_hosts: readonly Host[];
  overrides?: Readonly<Record<string, unknown>>;
}

export interface ActionAdmission {
  run_id: string;
  plan_id: string;
  cwd: string;
  host: Host;
  mode: HostExecutionMode;
  attempt: number;
  attempt_id: string;
  action: Readonly<ActionCapability>;
  task: Readonly<TaskCapability>;
  capability_digest: string;
}

export interface AgentPacketInput {
  admission: ActionAdmission;
  objective: string;
  evidence: readonly string[];
  screenshot_dir: string;
  timeout_ms: number;
}

export interface ScheduledActionAdmission {
  admission: ActionAdmission;
  lease: ScopeLease;
}

const permissionFields = new Set([
  'model', 'role', 'operation', 'cwd', 'host', 'task_id', 'action_id', 'scope', 'read_scope',
  'write_scope', 'write_paths', 'allowed_commands', 'commands', 'output_schema', 'result_schema',
]);

export class ActionAdmissionError extends Error {
  readonly name = 'ActionAdmissionError';

  constructor(readonly code: 'ACTION_NOT_AUTHORIZED' | 'TASK_NOT_AUTHORIZED' | 'ACTION_NOT_READY' | 'ACTION_SCOPE_VIOLATION' | 'ACTION_SANDBOX_UNAVAILABLE', message: string) {
    super(message);
  }
}

function reject(code: ActionAdmissionError['code'], message: string): never {
  throw new ActionAdmissionError(code, message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
  }
  return value;
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) reject('ACTION_SCOPE_VIOLATION', `${label} must be non-empty`);
}

function needsBrokeredSandbox(action: ActionCapability): boolean {
  return action.write_access || action.operation === 'test' || action.host_only;
}

function validateOverrides(overrides: Readonly<Record<string, unknown>> | undefined): void {
  if (!overrides) return;
  for (const field of Object.keys(overrides)) {
    if (permissionFields.has(field)) reject('ACTION_SCOPE_VIOLATION', `permission override is not allowed: ${field}`);
    reject('ACTION_SCOPE_VIOLATION', `agent override is not allowed: ${field}`);
  }
}

function validateHostCapability(manifest: ActionCapabilityManifest, action: ActionCapability): void {
  const execution = manifest.host_execution;
  if (execution.adapter !== manifest.host) reject('ACTION_SANDBOX_UNAVAILABLE', 'manifest host and execution adapter differ');
  if (!needsBrokeredSandbox(action)) {
    if (execution.mode === 'unsupported') reject('ACTION_SANDBOX_UNAVAILABLE', 'host execution mode is unsupported');
    return;
  }
  if (execution.mode !== 'brokered-sandbox'
    || !execution.model_transport.network_allowed
    || execution.model_transport.project_write_allowed
    || execution.model_transport.credential_visibility !== 'broker-only'
    || !execution.action_executor.process_group
    || execution.action_executor.network_allowed
    || !execution.action_executor.project_write_enforced
    || execution.action_executor.git_metadata_write_allowed) {
    reject('ACTION_SANDBOX_UNAVAILABLE', `action ${action.action_id} lacks brokered sandbox capability`);
  }
}

function validateDependencies(request: ActionAdmissionRequest, action: ActionCapability, task: TaskCapability): void {
  const taskState = request.task_states[task.task_id];
  if (taskState !== 'ready' && taskState !== 'running') reject('TASK_NOT_AUTHORIZED', `task is not ready: ${task.task_id}`);
  for (const dependency of action.requires_actions ?? []) {
    const state = request.action_states[dependency];
    if (state !== 'done' && state !== 'checkpointed' && state !== 'observed') reject('ACTION_NOT_READY', `action dependency is not complete: ${dependency}`);
  }
}

export function admitAction(request: ActionAdmissionRequest): ActionAdmission {
  requireNonEmpty(request.run_id, 'run_id');
  requireNonEmpty(request.cwd, 'cwd');
  validateOverrides(request.overrides);
  const action = request.manifest.actions.find((candidate) => candidate.action_id === request.action_id);
  if (!action) reject('ACTION_NOT_AUTHORIZED', `action is not authorized: ${request.action_id}`);
  const task = request.manifest.tasks.find((candidate) => candidate.task_id === action.task_id);
  if (!task) reject('TASK_NOT_AUTHORIZED', `action references an unknown task: ${action.task_id}`);
  if (!Number.isSafeInteger(request.attempt) || request.attempt < 1 || request.attempt > action.max_attempts) reject('ACTION_NOT_AUTHORIZED', `attempt exceeds action budget: ${request.attempt}`);
  const existingState = request.action_states[action.action_id];
  if (existingState === 'running' || existingState === 'dispatch_intent' || existingState === 'done' || existingState === 'checkpointed') reject('ACTION_NOT_READY', `action is already admitted: ${action.action_id}`);
  if (request.active_hosts.some((host) => host !== request.manifest.host)) reject('ACTION_NOT_READY', `one-host policy prevents ${request.manifest.host} admission`);
  validateDependencies(request, action, task);
  validateHostCapability(request.manifest, action);
  const snapshot = freeze(clone(action));
  const taskSnapshot = freeze(clone(task));
  return {
    run_id: request.run_id,
    plan_id: request.manifest.plan_id,
    cwd: request.cwd,
    host: request.manifest.host,
    mode: request.manifest.host_execution.mode,
    attempt: request.attempt,
    attempt_id: `${action.action_id}/attempt-${request.attempt}`,
    action: snapshot,
    task: taskSnapshot,
    capability_digest: request.manifest.host_execution.capability_digest,
  };
}

export async function admitActionWithScheduler(request: ActionAdmissionRequest, scheduler: ScopeScheduler): Promise<ScheduledActionAdmission> {
  const admission = admitAction(request);
  const lease = await scheduler.submit({
    admission_id: admission.attempt_id,
    call_ordinal: request.attempt,
    action_id: admission.action.action_id,
    task_id: admission.task.task_id,
    read_scope: admission.action.read_scope,
    write_scope: admission.action.write_scope,
    ...(admission.action.concurrency_group_id === undefined ? {} : { concurrency_group_id: admission.action.concurrency_group_id }),
  });
  return { admission, lease };
}

export function buildAgentPacket(input: AgentPacketInput): AgentPacket {
  const { admission, objective, evidence, screenshot_dir, timeout_ms } = input;
  requireNonEmpty(objective, 'objective');
  requireNonEmpty(screenshot_dir, 'screenshot_dir');
  if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 1000 || timeout_ms > 3_600_000) reject('ACTION_SCOPE_VIOLATION', 'timeout_ms is outside packet limits');
  const action = admission.action;
  return {
    packet_version: '1.0.0',
    run_id: admission.run_id,
    plan_id: admission.plan_id,
    task_id: action.task_id,
    ...(admission.task.feature === undefined ? {} : { feature: admission.task.feature }),
    role: action.role,
    objective,
    cwd: admission.cwd,
    read_paths: [...action.read_scope],
    write_paths: [...action.write_scope],
    evidence: [...evidence],
    screenshot_dir,
    allowed_commands: [...action.allowed_commands],
    timeout_ms,
    result_schema: 'schemas/result.schema.json',
  };
}
