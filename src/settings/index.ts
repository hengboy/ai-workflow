import YAML from 'yaml';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite } from '../utils/fs.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';

export interface Settings {
  active_profile?: string;
}

const profileNamePattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

function settingsPath(home: string): string {
  return join(resolve(home), '.config/ai-workflow/config.yaml');
}

function configurationError(path: string, detail: string): Error {
  return new Error(`Invalid ai-workflow configuration at ${path}: ${detail}`);
}

export async function loadSettings(home: string): Promise<Settings> {
  const path = settingsPath(home);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  let settings: unknown;
  try {
    settings = YAML.parse(source) as unknown;
  } catch (error) {
    throw configurationError(path, error instanceof Error ? error.message : String(error));
  }

  if (settings === null || settings === undefined) return {};

  const validate = await schemaValidator('settings.schema.json');
  if (!validate(settings)) {
    throw configurationError(path, formatSchemaErrors(validate.errors));
  }

  const parsed = settings as { active_profile?: string };
  return parsed.active_profile !== undefined ? { active_profile: parsed.active_profile } : {};
}

export async function writeActiveProfile(home: string, name: string): Promise<void> {
  if (!profileNamePattern.test(name)) {
    throw new Error(`Invalid active profile "${name}"; must match ${profileNamePattern.source}`);
  }

  const path = settingsPath(home);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    source = '';
  }

  const existing = source.trim() === '' ? null : (YAML.parse(source) as unknown);
  const settings: Record<string, unknown> = existing === null || existing === undefined ? {} : { ...(existing as Record<string, unknown>) };
  settings.active_profile = name;

  await atomicWrite(path, YAML.stringify(settings));
}
