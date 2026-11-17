import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { packagePath } from '../utils/schema.js';

/** The four durable record kinds written by the execution store. */
export type ExecutionRecordKind = 'run' | 'event' | 'checkpoint' | 'lock';

/** Outcome of validating one record against its authoritative schema. */
export interface ExecutionValidationResult {
  valid: boolean;
  errors: string[];
}

const SCHEMA_FILES: Record<ExecutionRecordKind, string> = {
  run: 'execution-run.schema.json',
  event: 'execution-event.schema.json',
  checkpoint: 'execution-checkpoint.schema.json',
  lock: 'execution-lock.schema.json',
};

const validators = new Map<ExecutionRecordKind, ValidateFunction>();

function validatorFor(kind: ExecutionRecordKind): ValidateFunction {
  const cached = validators.get(kind);
  if (cached) return cached;
  const Ajv = AjvModule as unknown as new (options: object) => import('ajv').default;
  const addFormats = addFormatsModule as unknown as (ajv: import('ajv').default) => void;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(packagePath('schemas', SCHEMA_FILES[kind]), 'utf8')) as Record<string, unknown>;
  const compiled = ajv.compile(schema);
  validators.set(kind, compiled);
  return compiled;
}

/** Render schema failures with the offending field name when the schema reports one. */
function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const params = error.params as { additionalProperty?: unknown; missingProperty?: unknown };
    const location = error.instancePath || '/';
    if (typeof params.additionalProperty === 'string') {
      return `${location} unexpected field "${params.additionalProperty}"`;
    }
    if (typeof params.missingProperty === 'string') {
      return `${location} missing required field "${params.missingProperty}"`;
    }
    return `${location} ${error.message ?? 'is invalid'}`;
  });
}

/** Validate one record against its authoritative JSON Schema. */
export function validateExecutionRecord(kind: ExecutionRecordKind, value: unknown): ExecutionValidationResult {
  const validator = validatorFor(kind);
  if (validator(value)) return { valid: true, errors: [] };
  return { valid: false, errors: formatErrors(validator.errors) };
}

/** Throw with the record path and every field error when the record is invalid. */
export function assertExecutionRecord(kind: ExecutionRecordKind, value: unknown, path: string): void {
  const result = validateExecutionRecord(kind, value);
  if (!result.valid) throw new Error(`Invalid ${kind} record at ${path}: ${result.errors.join('; ')}`);
}
