import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function schemaValidator(name: string): Promise<ValidateFunction> {
  const schemaDirectory = resolve(packageRoot, 'schemas');
  const schema = JSON.parse(await readFile(resolve(schemaDirectory, name), 'utf8')) as Record<string, unknown>;
  const Ajv = AjvModule as unknown as new (options: object) => import('ajv').default;
  const addFormats = addFormatsModule as unknown as (ajv: import('ajv').default) => void;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const entry of await readdir(schemaDirectory)) {
    if (!entry.endsWith('.json') || entry === name) continue;
    if (name === 'navigation.candidate.schema.json' && entry === 'navigation.schema.json') continue;
    const referenced = JSON.parse(await readFile(resolve(schemaDirectory, entry), 'utf8')) as Record<string, unknown>;
    ajv.addSchema(referenced);
  }
  if (name === 'navigation.candidate.schema.json') {
    const navigation = JSON.parse(await readFile(resolve(schemaDirectory, 'navigation.schema.json'), 'utf8')) as Record<string, unknown>;
    const navigationWithoutId = { ...navigation };
    delete navigationWithoutId.$id;
    ajv.addSchema(navigationWithoutId, 'schemas/navigation.schema.json');
  }
  return ajv.compile(schema);
}

export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
}

export function packagePath(...parts: string[]): string { return resolve(packageRoot, ...parts); }
