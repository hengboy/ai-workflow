import YAML from 'yaml';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Profile } from '../generated/profile.schema.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';

export type { Profile };

const profileName = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

export function profilePath(home: string, name: string): string {
  if (!profileName.test(name)) throw new Error(`Invalid profile name: ${name}`);
  return join(resolve(home), '.config/ai-workflow/profiles', `${name}.yaml`);
}

export async function loadProfile(home: string, name: string): Promise<Profile> {
  const path = profilePath(home, name);
  let source: string;
  try { source = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Profile does not exist: ${name}`);
    throw error;
  }
  let profile: unknown;
  try { profile = YAML.parse(source) as unknown; } catch (error) { throw new Error(`Invalid profile ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  const validate = await schemaValidator('profile.schema.json');
  if (!validate(profile)) throw new Error(`Invalid profile ${name}: ${formatSchemaErrors(validate.errors)}`);
  return profile as Profile;
}
