import { readFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { atomicWrite } from '../utils/fs.js';

/** The lean implementation record an ordinary plan keeps as its authoritative run state. */
export interface OrdinaryImplementationRecord {
  plan_id: string;
  status: 'in-progress' | 'completed';
  started_at?: string;
  completed_at?: string;
  commit?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asOptionalString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Malformed implementation record at ${path}: field "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Render the lean ordinary record with a fixed field order so repeated identical updates stay
 * byte-identical. Absent optional fields are omitted rather than invented.
 */
export async function writeOrdinaryRecord(path: string, record: OrdinaryImplementationRecord): Promise<void> {
  const output: Record<string, unknown> = { plan_id: record.plan_id, status: record.status };
  if (record.started_at !== undefined) output.started_at = record.started_at;
  if (record.completed_at !== undefined) output.completed_at = record.completed_at;
  if (record.commit !== undefined) output.commit = record.commit;
  await atomicWrite(path, stringifyYaml(output));
}

/**
 * Read the ordinary record leniently: an absent file returns `undefined`, optional fields may be
 * missing, and only a wrong plan identity or an unknown status is rejected as a contradiction.
 */
export async function readOrdinaryRecord(
  path: string,
  planId: string,
): Promise<OrdinaryImplementationRecord | undefined> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    throw new Error(`Malformed implementation record YAML at ${path}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`Malformed implementation record at ${path}: expected a YAML object`);
  if (parsed.plan_id !== planId) {
    throw new Error(
      `Implementation record at ${path} declares plan_id "${String(parsed.plan_id)}", expected "${planId}"`,
    );
  }
  const status = parsed.status;
  if (status !== 'in-progress' && status !== 'completed') {
    throw new Error(
      `Malformed implementation record at ${path}: field "status" must be "in-progress" or "completed"`,
    );
  }

  const record: OrdinaryImplementationRecord = { plan_id: planId, status };
  if (parsed.started_at !== undefined) record.started_at = asOptionalString(parsed.started_at, 'started_at', path);
  if (parsed.completed_at !== undefined) record.completed_at = asOptionalString(parsed.completed_at, 'completed_at', path);
  if (parsed.commit !== undefined) record.commit = asOptionalString(parsed.commit, 'commit', path);
  return record;
}
