import YAML from 'yaml';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';

export type OutputLanguage = 'en' | 'zh-CN';

const supportedLanguages = "'en' and 'zh-CN'";

function settingsPath(home: string): string {
  return join(resolve(home), '.config/ai-workflow/config.yaml');
}

export async function loadOutputLanguage(home: string): Promise<OutputLanguage> {
  const path = settingsPath(home);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'en';
    throw error;
  }

  let settings: unknown;
  try {
    settings = YAML.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid ai-workflow configuration at ${path}: ${error instanceof Error ? error.message : String(error)}; output_language must be one of ${supportedLanguages}`);
  }

  if (settings === null || settings === undefined) return 'en';

  const validate = await schemaValidator('settings.schema.json');
  if (!validate(settings)) {
    throw new Error(`Invalid ai-workflow configuration at ${path}: ${formatSchemaErrors(validate.errors)}; output_language must be one of ${supportedLanguages}`);
  }

  return ((settings as { output_language?: OutputLanguage }).output_language) ?? 'en';
}
