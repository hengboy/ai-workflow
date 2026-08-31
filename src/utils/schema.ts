import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function schemaValidator(name: string): Promise<ValidateFunction> {
  const schema = JSON.parse(await readFile(resolve(packageRoot, 'schemas', name), 'utf8')) as object;
  const Ajv = AjvModule as unknown as new (options: object) => import('ajv').default;
  const addFormats = addFormatsModule as unknown as (ajv: import('ajv').default) => void;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
}

export function packagePath(...parts: string[]): string { return resolve(packageRoot, ...parts); }
