import { materializeFromRealm } from './realm.js';

export const PROTOCOL_VERSION = '2.0.0' as const;
export type ProtocolDirection = 'host-to-worker' | 'worker-to-host';

export interface WorkflowErrorInfo {
  code: string;
  message: string;
  fatal: true;
}

export interface CodingAgentResult {
  result_version: '2.0.0';
  status: 'done' | 'blocked' | 'failed';
  summary: string;
  changed_paths: unknown[];
  evidence: unknown[];
  tests: unknown[];
  findings: unknown[];
  git_refs: unknown[];
  support_requests: unknown[];
  value?: unknown;
}

export interface WorkflowResult {
  value: unknown;
  stop_reason: 'completed' | 'cancelled' | 'error' | 'blocked';
  error?: string;
  agents_started: number;
  completed_tasks: string[];
  blocked_tasks: string[];
}

export interface CallDescriptor {
  call_id: string;
  call_ordinal: number;
  action_id: string;
  task_id: string;
  prompt: string;
  label?: string;
  phase?: string;
  pipeline_item_key?: string;
  manifest_digest: string;
  script_digest: string;
  args_digest: string;
  action_digest: string;
  descriptor_digest: string;
}

export interface TaskControlDescriptor {
  control_id: string;
  control_ordinal: number;
  operation: 'finalize-task' | 'skip-action' | 'skip-task';
  task_id?: string;
  action_id?: string;
  reason?: string;
  manifest_digest: string;
  script_digest: string;
  args_digest: string;
  descriptor_digest: string;
}

interface MessageBase {
  protocol_version: typeof PROTOCOL_VERSION;
  run_id: string;
  message_id: number;
}

export type WorkerToHostMessage = MessageBase & (
  | { type: 'ready' }
  | { type: 'agent-start'; request_id: string; descriptor: CallDescriptor }
  | { type: 'agent-dispose'; request_id: string; call_id: string }
  | { type: 'task-control'; request_id: string; control_descriptor: TaskControlDescriptor }
  | { type: 'phase'; title: string }
  | { type: 'log'; message: string }
  | { type: 'result'; result: WorkflowResult }
);

export type HostToWorkerMessage = MessageBase & (
  | { type: 'go' }
  | { type: 'cancel'; reason: string }
  | { type: 'agent-started'; request_id: string; call_id: string; child_id: string }
  | { type: 'agent-settled'; request_id: string; call_id: string; result: CodingAgentResult }
  | { type: 'agent-start-error'; request_id: string; call_id: string; error: WorkflowErrorInfo }
  | { type: 'agent-disposed'; request_id: string; call_id: string }
  | { type: 'task-control-settled'; request_id: string; control_id: string; state: 'finalized' | 'committed' | 'skipped'; receipt_digest: string }
  | { type: 'task-control-error'; request_id: string; control_id: string; error: WorkflowErrorInfo }
);

export type ProtocolMessage = WorkerToHostMessage | HostToWorkerMessage;

export interface DecodeOptions {
  direction: ProtocolDirection;
  runId: string;
  maxBytes?: number;
}

export class ProtocolError extends Error {
  readonly name = 'ProtocolError';
}

const callIdPattern = /^[a-zA-Z][a-zA-Z0-9._/-]*$/;
const runIdPattern = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const errorCodes = new Set([
  'SCRIPT_API_FORBIDDEN', 'SCRIPT_PARSE', 'ACTION_NOT_AUTHORIZED', 'TASK_NOT_AUTHORIZED',
  'ACTION_NOT_READY', 'REPLAY_DIVERGED', 'PARALLEL_SCOPE_CONFLICT', 'PROTOCOL_VIOLATION',
  'CANCEL_UNAUTHORIZED', 'CANCEL_CONTROL_STALE', 'NAVIGATION_DIGEST_MISMATCH', 'NAVIGATION_INVALID',
  'ACTION_SANDBOX_UNAVAILABLE', 'AUDIT_SYMLINK_CHANGE', 'V2_ADJUSTMENTS_UNSUPPORTED',
  'CLEANUP_OWNERSHIP_UNPROVEN', 'WORKFLOW_RECEIPT_MISMATCH', 'FROZEN_INPUT_DRIFT',
  'EXECUTION_ROUTE_DRIFT', 'GIT_BASELINE_DRIFT', 'APPROVAL_IDENTITY_MISMATCH', 'TASK_SKIP_FORBIDDEN',
  'OUTPUT_CONTRACT_INVALID', 'ACTION_SCOPE_VIOLATION', 'LEASE_LOST', 'WORKER_DEAD',
  'WORKFLOW_VERSION_UNSUPPORTED', 'RUN_VERSION_UNSUPPORTED', 'LEGACY_CANCEL_UNAVAILABLE',
  'LEGACY_RESUME_UNSUPPORTED',
]);

function fail(message: string): never {
  throw new ProtocolError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) fail(`${label} is invalid`);
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive integer`);
  return value as number;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  const keys = new Set(Object.keys(value));
  for (const key of keys) if (!allowed.includes(key)) fail(`unknown protocol field: ${key}`);
  for (const key of required) if (!keys.has(key)) fail(`missing protocol field: ${key}`);
}

function digest(value: unknown, label: string): string {
  return stringValue(value, label, digestPattern);
}

function validateError(value: unknown, label: string): WorkflowErrorInfo {
  const error = record(value, label);
  exactKeys(error, ['code', 'message', 'fatal'], ['code', 'message', 'fatal']);
  const code = stringValue(error.code, `${label}.code`);
  if (!errorCodes.has(code)) fail(`${label}.code is unknown`);
  if (typeof error.message !== 'string' || error.message.length === 0 || error.message.length > 20_000) fail(`${label}.message is invalid`);
  if (error.fatal !== true) fail(`${label}.fatal must be true`);
  return { code, message: error.message, fatal: true };
}

function validateDescriptor(value: unknown): CallDescriptor {
  const descriptor = record(value, 'descriptor');
  exactKeys(descriptor, ['call_id', 'call_ordinal', 'action_id', 'task_id', 'prompt', 'label', 'phase', 'pipeline_item_key', 'manifest_digest', 'script_digest', 'args_digest', 'action_digest', 'descriptor_digest'], ['call_id', 'call_ordinal', 'action_id', 'task_id', 'prompt', 'manifest_digest', 'script_digest', 'args_digest', 'action_digest', 'descriptor_digest']);
  const result = descriptor as unknown as CallDescriptor;
  stringValue(result.call_id, 'descriptor.call_id', callIdPattern);
  integerValue(result.call_ordinal, 'descriptor.call_ordinal');
  stringValue(result.action_id, 'descriptor.action_id', /^[a-z][a-z0-9-]*$/);
  stringValue(result.task_id, 'descriptor.task_id');
  stringValue(result.prompt, 'descriptor.prompt');
  for (const key of ['label', 'phase', 'pipeline_item_key'] as const) if (descriptor[key] !== undefined) stringValue(descriptor[key], `descriptor.${key}`);
  for (const key of ['manifest_digest', 'script_digest', 'args_digest', 'action_digest', 'descriptor_digest'] as const) digest(descriptor[key], `descriptor.${key}`);
  return result;
}

function validateControlDescriptor(value: unknown): TaskControlDescriptor {
  const descriptor = record(value, 'control_descriptor');
  exactKeys(descriptor, ['control_id', 'control_ordinal', 'operation', 'task_id', 'action_id', 'reason', 'manifest_digest', 'script_digest', 'args_digest', 'descriptor_digest'], ['control_id', 'control_ordinal', 'operation', 'manifest_digest', 'script_digest', 'args_digest', 'descriptor_digest']);
  const result = descriptor as unknown as TaskControlDescriptor;
  stringValue(result.control_id, 'control_descriptor.control_id', callIdPattern);
  integerValue(result.control_ordinal, 'control_descriptor.control_ordinal');
  if (!['finalize-task', 'skip-action', 'skip-task'].includes(result.operation)) fail('control_descriptor.operation is invalid');
  for (const key of ['task_id', 'action_id', 'reason'] as const) if (descriptor[key] !== undefined) stringValue(descriptor[key], `control_descriptor.${key}`);
  for (const key of ['manifest_digest', 'script_digest', 'args_digest', 'descriptor_digest'] as const) digest(descriptor[key], `control_descriptor.${key}`);
  return result;
}

function validateAgentResult(value: unknown): CodingAgentResult {
  const result = record(value, 'result');
  exactKeys(result, ['result_version', 'status', 'summary', 'changed_paths', 'evidence', 'tests', 'findings', 'git_refs', 'support_requests', 'value'], ['result_version', 'status', 'summary', 'changed_paths', 'evidence', 'tests', 'findings', 'git_refs', 'support_requests']);
  if (result.result_version !== '2.0.0' || !['done', 'blocked', 'failed'].includes(result.status)) fail('agent result version or status is invalid');
  if (typeof result.summary !== 'string' || !Array.isArray(result.changed_paths) || !Array.isArray(result.evidence) || !Array.isArray(result.tests) || !Array.isArray(result.findings) || !Array.isArray(result.git_refs) || !Array.isArray(result.support_requests)) fail('agent result shape is invalid');
  return result as unknown as CodingAgentResult;
}

function validateWorkflowResult(value: unknown): WorkflowResult {
  const result = record(value, 'result');
  exactKeys(result, ['value', 'stop_reason', 'error', 'agents_started', 'completed_tasks', 'blocked_tasks'], ['value', 'stop_reason', 'agents_started', 'completed_tasks', 'blocked_tasks']);
  if (!['completed', 'cancelled', 'error', 'blocked'].includes(result.stop_reason)) fail('workflow result stop_reason is invalid');
  integerValue(result.agents_started === 0 ? 1 : result.agents_started, 'result.agents_started');
  if (typeof result.agents_started !== 'number' || result.agents_started < 0 || !Array.isArray(result.completed_tasks) || !Array.isArray(result.blocked_tasks)) fail('workflow result shape is invalid');
  if (result.error !== undefined && typeof result.error !== 'string') fail('workflow result error is invalid');
  return result as unknown as WorkflowResult;
}

function validateMessage(value: unknown, direction: ProtocolDirection, options: DecodeOptions): ProtocolMessage {
  const message = record(value, 'message');
  exactKeys(message, direction === 'worker-to-host'
    ? ['type', 'protocol_version', 'run_id', 'message_id', 'request_id', 'call_id', 'descriptor', 'control_id', 'control_descriptor', 'title', 'message', 'result']
    : ['type', 'protocol_version', 'run_id', 'message_id', 'request_id', 'call_id', 'child_id', 'control_id', 'reason', 'result', 'error', 'state', 'receipt_digest'], ['type', 'protocol_version', 'run_id', 'message_id']);
  if (message.protocol_version !== PROTOCOL_VERSION) fail('unsupported protocol version');
  const runId = stringValue(message.run_id, 'run_id', runIdPattern);
  if (runId !== options.runId) fail(`wrong run_id: expected ${options.runId}, received ${runId}`);
  integerValue(message.message_id, 'message_id');
  const type = stringValue(message.type, 'type');
  if (direction === 'worker-to-host') {
    if (!['ready', 'agent-start', 'agent-dispose', 'task-control', 'phase', 'log', 'result'].includes(type)) fail(`unknown worker-to-host message tag: ${type}`);
    if (type === 'agent-start') { stringValue(message.request_id, 'request_id', callIdPattern); validateDescriptor(message.descriptor); }
    if (type === 'agent-dispose') { stringValue(message.request_id, 'request_id', callIdPattern); stringValue(message.call_id, 'call_id', callIdPattern); }
    if (type === 'task-control') { stringValue(message.request_id, 'request_id', callIdPattern); validateControlDescriptor(message.control_descriptor); }
    if (type === 'phase') stringValue(message.title, 'title');
    if (type === 'log') stringValue(message.message, 'message');
    if (type === 'result') validateWorkflowResult(message.result);
  } else {
    if (!['go', 'cancel', 'agent-started', 'agent-settled', 'agent-start-error', 'agent-disposed', 'task-control-settled', 'task-control-error'].includes(type)) fail(`unknown host-to-worker message tag: ${type}`);
    if (type === 'cancel') stringValue(message.reason, 'reason');
    if (['agent-started', 'agent-settled', 'agent-start-error', 'agent-disposed'].includes(type)) {
      stringValue(message.request_id, 'request_id', callIdPattern); stringValue(message.call_id, 'call_id', callIdPattern);
    }
    if (type === 'agent-started') stringValue(message.child_id, 'child_id');
    if (type === 'agent-settled') validateAgentResult(message.result);
    if (type === 'agent-start-error') validateError(message.error, 'error');
    if (type === 'task-control-settled') { stringValue(message.request_id, 'request_id', callIdPattern); stringValue(message.control_id, 'control_id', callIdPattern); if (!['finalized', 'committed', 'skipped'].includes(message.state as string)) fail('state is invalid'); digest(message.receipt_digest, 'receipt_digest'); }
    if (type === 'task-control-error') { stringValue(message.request_id, 'request_id', callIdPattern); stringValue(message.control_id, 'control_id', callIdPattern); validateError(message.error, 'error'); }
  }
  return value as ProtocolMessage;
}

export function encodeMessage(message: ProtocolMessage, options: { maxBytes?: number } = {}): string {
  let materialized: unknown;
  try { materialized = materializeFromRealm(message, 'message'); } catch (error) { fail(`message is not plain JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const hostToWorker = new Set(['go', 'cancel', 'agent-started', 'agent-settled', 'agent-start-error', 'agent-disposed', 'task-control-settled', 'task-control-error']);
  const direction: ProtocolDirection = hostToWorker.has(message.type) ? 'host-to-worker' : 'worker-to-host';
  validateMessage(materialized, direction, { direction, runId: message.run_id });
  const encoded = JSON.stringify(materialized);
  if (encoded === undefined) fail('message could not be encoded');
  if (options.maxBytes !== undefined && Buffer.byteLength(encoded, 'utf8') > options.maxBytes) fail('encoded message exceeds size limit');
  return encoded;
}

export function decodeMessage(encoded: string, options: DecodeOptions): ProtocolMessage {
  if (options.maxBytes !== undefined && Buffer.byteLength(encoded, 'utf8') > options.maxBytes) fail('encoded message exceeds size limit');
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { fail('encoded message is not valid JSON'); }
  return validateMessage(value, options.direction, options);
}

export class MessageLedger {
  private lastMessageId = 0;
  constructor(private readonly options: DecodeOptions) {}

  accept(encoded: string): ProtocolMessage {
    const message = decodeMessage(encoded, this.options);
    if (message.message_id <= this.lastMessageId) fail(`duplicate or replayed message_id: ${message.message_id}`);
    this.lastMessageId = message.message_id;
    return message;
  }
}
