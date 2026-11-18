import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type {
  ExecutionCheckpoint,
  ExecutionEvent,
  ExecutionLock,
  ExecutionRun,
} from '../../src/execution/types.js';

const schemasDirectory = fileURLToPath(new URL('../../schemas/', import.meta.url));

const RUN_SCHEMA = 'execution-run.schema.json';
const EVENT_SCHEMA = 'execution-event.schema.json';
const CHECKPOINT_SCHEMA = 'execution-checkpoint.schema.json';
const LOCK_SCHEMA = 'execution-lock.schema.json';

const EXPECTED_RUN_STATUSES = [
  'CREATED',
  'RUNNING',
  'PAUSED',
  'INTERRUPTED',
  'RESUMING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

const EXPECTED_EVENT_TYPES = [
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

const EXPECTED_FAILURE_CATEGORIES = [
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

const EXPECTED_TASK_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;

const RUN_REQUIRED = [
  'run_id',
  'plan_id',
  'plan_digest',
  'status',
  'plan_created_at',
  'created_at',
  'updated_at',
  'failure_count',
] as const;

const RUN_OPTIONAL = [
  'repository',
  'phase',
  'started_at',
  'completed_at',
  'last_failure',
  'tasks',
  'agent',
] as const;

const EVENT_REQUIRED = ['event_id', 'run_id', 'plan_id', 'type', 'timestamp'] as const;
const EVENT_OPTIONAL = ['task_id', 'invocation_id', 'payload'] as const;

const CHECKPOINT_REQUIRED = [
  'checkpoint_id',
  'run_id',
  'plan_id',
  'plan_digest',
  'task_states',
  'attempt_counts',
  'created_at',
] as const;

const CHECKPOINT_OPTIONAL = ['repository', 'phase', 'agent_binding', 'last_persisted_event_id'] as const;

const LOCK_REQUIRED = ['owner_id', 'pid', 'host', 'acquired_at', 'command'] as const;

const PLAN_DIGEST = 'sha256:0973e59f59deba459c92e7f095cac26e3a6b2d26899ba81642b642f284ec4483';

const RUN_FIXTURE = {
  run_id: 'run-0001',
  plan_id: '20261117-execution-observability-resilience',
  plan_digest: PLAN_DIGEST,
  status: 'CREATED',
  plan_created_at: '2026-11-17T07:10:35Z',
  created_at: '2026-11-17T07:20:00Z',
  updated_at: '2026-11-17T07:20:00Z',
  failure_count: 0,
} satisfies ExecutionRun;

const EVENT_FIXTURE = {
  event_id: 'event-0001',
  run_id: 'run-0001',
  plan_id: '20261117-execution-observability-resilience',
  type: 'workflow.started',
  timestamp: '2026-11-17T07:20:00Z',
} satisfies ExecutionEvent;

const CHECKPOINT_FIXTURE = {
  checkpoint_id: 'checkpoint-0001',
  run_id: 'run-0001',
  plan_id: '20261117-execution-observability-resilience',
  plan_digest: PLAN_DIGEST,
  task_states: {},
  attempt_counts: {},
  created_at: '2026-11-17T07:20:00Z',
} satisfies ExecutionCheckpoint;

const LOCK_FIXTURE = {
  owner_id: 'owner-0001',
  pid: 4242,
  host: 'test-host',
  acquired_at: '2026-11-17T07:20:00Z',
  command: 'ai-workflow execution start',
} satisfies ExecutionLock;

interface RootSchema {
  type?: unknown;
  additionalProperties?: unknown;
  required?: unknown;
  properties?: unknown;
}

interface CompiledSchema {
  schema: RootSchema;
  validate: ValidateFunction;
}

async function compileSchema(name: string): Promise<CompiledSchema> {
  const schema = JSON.parse(await readFile(join(schemasDirectory, name), 'utf8')) as RootSchema;
  const Ajv = AjvModule as unknown as new (options: object) => import('ajv').default;
  const addFormats = addFormatsModule as unknown as (ajv: import('ajv').default) => void;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return { schema, validate: ajv.compile(schema as Parameters<typeof ajv.compile>[0]) };
}

function requiredOf(schema: RootSchema): string[] {
  return Array.isArray(schema.required) ? (schema.required as string[]) : [];
}

function propertiesOf(schema: RootSchema): Record<string, unknown> {
  return (schema.properties ?? {}) as Record<string, unknown>;
}

function expectSameSet(actual: Iterable<string>, expected: readonly string[]): void {
  expect(new Set(actual)).toEqual(new Set(expected));
}

function errorText(validate: ValidateFunction): string {
  return JSON.stringify(validate.errors ?? []);
}

function expectValid(validate: ValidateFunction, value: unknown, label: string): void {
  expect(validate(value), `${label}: ${errorText(validate)}`).toBe(true);
}

function expectKeyword(validate: ValidateFunction, value: unknown, keyword: string, path: string): void {
  expect(validate(value), `expected ${keyword} at ${path || '/'}: ${errorText(validate)}`).toBe(false);
  expect(validate.errors ?? []).toContainEqual(expect.objectContaining({ keyword, instancePath: path }));
}

function expectRequiredField(validate: ValidateFunction, value: unknown, field: string): void {
  expect(validate(value), `expected ${field} to be required: ${errorText(validate)}`).toBe(false);
  expect(validate.errors ?? []).toContainEqual(
    expect.objectContaining({
      keyword: 'required',
      params: expect.objectContaining({ missingProperty: field }),
    }),
  );
}

function expectInvalidAt(validate: ValidateFunction, value: unknown, path: string): void {
  expect(validate(value), `expected a violation at ${path}: ${errorText(validate)}`).toBe(false);
  expect(validate.errors ?? []).toContainEqual(expect.objectContaining({ instancePath: path }));
}

function omit(value: object, key: string): Record<string, unknown> {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

describe('execution schema contracts', () => {
  it('defines canonical strict root object schemas', async () => {
    for (const name of [RUN_SCHEMA, EVENT_SCHEMA, CHECKPOINT_SCHEMA, LOCK_SCHEMA]) {
      const { schema } = await compileSchema(name);
      expect(schema.type, name).toBe('object');
      expect(schema.additionalProperties, name).toBe(false);
    }
  });

  it('validates run records against required fields, statuses and strict roots', async () => {
    const { schema, validate } = await compileSchema(RUN_SCHEMA);

    expectSameSet(requiredOf(schema), RUN_REQUIRED);
    expectSameSet(Object.keys(propertiesOf(schema)), [...RUN_REQUIRED, ...RUN_OPTIONAL]);
    const statusSchema = propertiesOf(schema).status as { enum?: unknown };
    expect(Array.isArray(statusSchema.enum)).toBe(true);
    expectSameSet(statusSchema.enum as string[], EXPECTED_RUN_STATUSES);

    expectValid(validate, RUN_FIXTURE, 'minimal run');
    for (const status of EXPECTED_RUN_STATUSES) {
      expectValid(validate, { ...RUN_FIXTURE, status }, `status ${status}`);
    }
    for (const field of RUN_REQUIRED) {
      expectRequiredField(validate, omit(RUN_FIXTURE, field), field);
    }

    expectKeyword(validate, { ...RUN_FIXTURE, status: 'IN_PROGRESS' }, 'enum', '/status');
    expectKeyword(validate, { ...RUN_FIXTURE, unexpected_root_field: true }, 'additionalProperties', '');
  });

  it('validates events against the fixed type enum, strict roots and UTC timestamps', async () => {
    const { schema, validate } = await compileSchema(EVENT_SCHEMA);

    expectSameSet(requiredOf(schema), EVENT_REQUIRED);
    expectSameSet(Object.keys(propertiesOf(schema)), [...EVENT_REQUIRED, ...EVENT_OPTIONAL]);
    const typeSchema = propertiesOf(schema).type as { enum?: unknown };
    expect(Array.isArray(typeSchema.enum)).toBe(true);
    expectSameSet(typeSchema.enum as string[], EXPECTED_EVENT_TYPES);

    expectValid(validate, EVENT_FIXTURE, 'minimal event');
    for (const type of EXPECTED_EVENT_TYPES) {
      expectValid(validate, { ...EVENT_FIXTURE, type }, `type ${type}`);
    }
    for (const field of EVENT_REQUIRED) {
      expectRequiredField(validate, omit(EVENT_FIXTURE, field), field);
    }

    expectKeyword(validate, { ...EVENT_FIXTURE, type: 'task.retried' }, 'enum', '/type');
    expectKeyword(validate, { ...EVENT_FIXTURE, unexpected_root_field: true }, 'additionalProperties', '');
    expectInvalidAt(validate, { ...EVENT_FIXTURE, timestamp: '2026-11-17T15:20:00+09:00' }, '/timestamp');
    expectValid(validate, { ...EVENT_FIXTURE, timestamp: '2026-11-17T23:59:59Z' }, 'UTC timestamp');
  });

  it('validates recovery checkpoints against required fields and a strict root', async () => {
    const { schema, validate } = await compileSchema(CHECKPOINT_SCHEMA);

    expectSameSet(requiredOf(schema), CHECKPOINT_REQUIRED);
    expectSameSet(Object.keys(propertiesOf(schema)), [...CHECKPOINT_REQUIRED, ...CHECKPOINT_OPTIONAL]);

    expectValid(validate, CHECKPOINT_FIXTURE, 'minimal checkpoint');
    for (const field of CHECKPOINT_REQUIRED) {
      expectRequiredField(validate, omit(CHECKPOINT_FIXTURE, field), field);
    }

    expectKeyword(
      validate,
      { ...CHECKPOINT_FIXTURE, unexpected_root_field: true },
      'additionalProperties',
      '',
    );
  });

  it('accepts UTC+08:00 timestamps in all four schemas and rejects an unrelated offset', async () => {
    const PLUS8 = '2026-11-17T15:20:00+08:00';
    const PLUS9 = '2026-11-17T16:20:00+09:00';

    const run = await compileSchema(RUN_SCHEMA);
    expectValid(
      run.validate,
      { ...RUN_FIXTURE, plan_created_at: PLUS8, created_at: PLUS8, updated_at: PLUS8, started_at: PLUS8, completed_at: PLUS8 },
      'run +08:00',
    );
    expectInvalidAt(run.validate, { ...RUN_FIXTURE, plan_created_at: PLUS9 }, '/plan_created_at');
    expectInvalidAt(run.validate, { ...RUN_FIXTURE, created_at: PLUS9 }, '/created_at');
    expectInvalidAt(run.validate, { ...RUN_FIXTURE, updated_at: PLUS9 }, '/updated_at');
    expectInvalidAt(run.validate, { ...RUN_FIXTURE, started_at: PLUS9 }, '/started_at');
    expectInvalidAt(run.validate, { ...RUN_FIXTURE, completed_at: PLUS9 }, '/completed_at');

    const event = await compileSchema(EVENT_SCHEMA);
    expectValid(event.validate, { ...EVENT_FIXTURE, timestamp: PLUS8 }, 'event +08:00');
    expectInvalidAt(event.validate, { ...EVENT_FIXTURE, timestamp: PLUS9 }, '/timestamp');

    const checkpoint = await compileSchema(CHECKPOINT_SCHEMA);
    expectValid(checkpoint.validate, { ...CHECKPOINT_FIXTURE, created_at: PLUS8 }, 'checkpoint +08:00');
    expectInvalidAt(checkpoint.validate, { ...CHECKPOINT_FIXTURE, created_at: PLUS9 }, '/created_at');

    const lock = await compileSchema(LOCK_SCHEMA);
    expectValid(lock.validate, { ...LOCK_FIXTURE, acquired_at: PLUS8 }, 'lock +08:00');
    expectInvalidAt(lock.validate, { ...LOCK_FIXTURE, acquired_at: PLUS9 }, '/acquired_at');
  });

  it('validates execution locks with a positive integer pid and a strict root', async () => {
    const { schema, validate } = await compileSchema(LOCK_SCHEMA);

    expectSameSet(requiredOf(schema), LOCK_REQUIRED);
    expectSameSet(Object.keys(propertiesOf(schema)), LOCK_REQUIRED);

    expectValid(validate, LOCK_FIXTURE, 'minimal lock');
    expectValid(validate, { ...LOCK_FIXTURE, pid: 1 }, 'pid 1');
    for (const field of LOCK_REQUIRED) {
      expectRequiredField(validate, omit(LOCK_FIXTURE, field), field);
    }

    for (const pid of [0, -1, 1.5, '4242']) {
      expectInvalidAt(validate, { ...LOCK_FIXTURE, pid }, '/pid');
    }
    expectKeyword(validate, { ...LOCK_FIXTURE, unexpected_root_field: true }, 'additionalProperties', '');
  });

  it('exports runtime constants that match the canonical schema enums', async () => {
    const types = await import('../../src/execution/types.js');

    expect(Array.isArray(types.RUN_STATUSES)).toBe(true);
    expect(Array.isArray(types.EXECUTION_EVENT_TYPES)).toBe(true);
    expect(Array.isArray(types.FAILURE_CATEGORIES)).toBe(true);
    expect(Array.isArray(types.TASK_STATUSES)).toBe(true);

    expectSameSet(types.RUN_STATUSES as string[], EXPECTED_RUN_STATUSES);
    expectSameSet(types.EXECUTION_EVENT_TYPES as string[], EXPECTED_EVENT_TYPES);
    expectSameSet(types.FAILURE_CATEGORIES as string[], EXPECTED_FAILURE_CATEGORIES);
    expectSameSet(types.TASK_STATUSES as string[], EXPECTED_TASK_STATUSES);

    expect(types.RUN_STATUSES).toHaveLength(EXPECTED_RUN_STATUSES.length);
    expect(types.EXECUTION_EVENT_TYPES).toHaveLength(EXPECTED_EVENT_TYPES.length);
    expect(types.FAILURE_CATEGORIES).toHaveLength(EXPECTED_FAILURE_CATEGORIES.length);
    expect(types.TASK_STATUSES).toHaveLength(EXPECTED_TASK_STATUSES.length);

    const runSchema = await compileSchema(RUN_SCHEMA);
    const statusEnum = (propertiesOf(runSchema.schema).status as { enum?: unknown }).enum as string[];
    expectSameSet(types.RUN_STATUSES as string[], statusEnum);

    const eventSchema = await compileSchema(EVENT_SCHEMA);
    const typeEnum = (propertiesOf(eventSchema.schema).type as { enum?: unknown }).enum as string[];
    expectSameSet(types.EXECUTION_EVENT_TYPES as string[], typeEnum);
    expectSameSet(
      typeEnum.filter((value) => value.startsWith('failure.')).map((value) => value.slice('failure.'.length)),
      types.FAILURE_CATEGORIES as string[],
    );
  });
});
