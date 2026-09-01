import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { exists } from '../utils/fs.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';

export interface ContextValidation { valid: boolean; errors: string[] }

interface NavigationFeature {
  entries: string[];
  related_files: string[];
  tests: string[];
  read_scope: string[];
  symbols: Array<{ file: string }>;
}

interface NavigationIndex {
  module_roots: Array<{ path: string }>;
  features: NavigationFeature[];
}

function isExactPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.endsWith('/') && !path.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0) && !/[?*\[\]{}$<>]/.test(path);
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${String.raw`/`}`) && !isAbsolute(path);
}

async function validateFile(project: string, realProject: string, path: string, errors: string[]): Promise<void> {
  if (!isExactPath(path)) { errors.push(`${path}: expected an exact regular file path`); return; }
  const target = resolve(project, path);
  if (!isWithin(project, target)) { errors.push(`${path}: path escapes project`); return; }
  try {
    if (!(await lstat(target)).isFile()) { errors.push(`${path}: expected an exact regular file`); return; }
    const real = await realpath(target);
    if (!isWithin(realProject, real)) errors.push(`${path}: symlink escapes project`);
  } catch {
    errors.push(`${path}: expected an exact regular file`);
  }
}

export async function validateContext(project: string): Promise<ContextValidation> {
  const root = resolve(project); const realRoot = await realpath(root); const memoryPath = join(root, 'MEMORY.md'); const jsonPath = join(root, '.ai-workflow/index/navigation.json'); const markdownPath = join(root, '.ai-workflow/index/navigation.md'); const errors: string[] = [];
  if (await exists(memoryPath) && !/^#\s+/m.test(await readFile(memoryPath, 'utf8'))) errors.push('MEMORY.md needs a title');
  if (!(await exists(jsonPath))) errors.push('Missing .ai-workflow/index/navigation.json');
  if (!(await exists(markdownPath))) errors.push('Missing .ai-workflow/index/navigation.md');
  if (errors.length) return { valid: false, errors };

  let index: NavigationIndex;
  try { index = JSON.parse(await readFile(jsonPath, 'utf8')) as NavigationIndex; } catch { return { valid: false, errors: ['navigation.json is not valid JSON'] }; }
  const validator = await schemaValidator('navigation.schema.json');
  if (!validator(index)) errors.push(formatSchemaErrors(validator.errors));
  const raw = index as unknown as { features?: Array<Record<string, unknown>> };
  for (const feature of raw.features ?? []) if ('write_scope' in feature) errors.push('Navigation features cannot declare write_scope');
  if (errors.length) return { valid: false, errors };

  for (const rootEntry of index.module_roots) {
    if (!isExactPath(rootEntry.path)) errors.push(`${rootEntry.path}: expected a concrete module root`);
  }
  for (const feature of index.features) {
    for (const path of [...feature.entries, ...feature.related_files, ...feature.tests, ...feature.read_scope, ...feature.symbols.map((symbol) => symbol.file)]) await validateFile(root, realRoot, path, errors);
  }
  return { valid: errors.length === 0, errors };
}
