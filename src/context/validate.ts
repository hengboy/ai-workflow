import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWrite, exists } from '../utils/fs.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';
import { renderNavigation, type NavigationIndex } from './navigation.js';

export interface ContextValidation { valid: boolean; errors: string[] }

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

async function validateIndex(project: string): Promise<{ errors: string[]; index?: NavigationIndex }> {
  const root = resolve(project); const realRoot = await realpath(root); const memoryPath = join(root, 'MEMORY.md'); const jsonPath = join(root, '.ai-workflow/index/navigation.json'); const markdownPath = join(root, '.ai-workflow/index/navigation.md'); const errors: string[] = [];
  if (await exists(memoryPath) && !/^#\s+/m.test(await readFile(memoryPath, 'utf8'))) errors.push('MEMORY.md needs a title');
  if (!(await exists(jsonPath))) errors.push('Missing .ai-workflow/index/navigation.json');
  if (!(await exists(markdownPath))) errors.push('Missing .ai-workflow/index/navigation.md');
  if (errors.length) return { errors };

  let index: NavigationIndex;
  try { index = JSON.parse(await readFile(jsonPath, 'utf8')) as NavigationIndex; } catch { return { errors: ['navigation.json is not valid JSON'] }; }
  const validator = await schemaValidator('navigation.schema.json');
  if (!validator(index)) errors.push(formatSchemaErrors(validator.errors));
  const raw = index as unknown as { features?: Array<Record<string, unknown>> };
  for (const feature of raw.features ?? []) if ('write_scope' in feature) errors.push('Navigation features cannot declare write_scope');
  if (errors.length) return { errors };

  for (const rootEntry of index.module_roots) {
    if (!isExactPath(rootEntry.path)) errors.push(`${rootEntry.path}: expected a concrete module root`);
  }
  for (const feature of index.features) {
    for (const path of [...feature.entries, ...feature.related_files, ...feature.tests, ...feature.read_scope, ...feature.symbols.map((symbol) => symbol.file)]) await validateFile(root, realRoot, path, errors);
  }
  return errors.length ? { errors } : { errors, index };
}

export async function validateContext(project: string): Promise<ContextValidation> {
  const result = await validateIndex(project);
  if (!result.index) return { valid: false, errors: result.errors };
  const markdown = await readFile(join(resolve(project), '.ai-workflow/index/navigation.md'), 'utf8');
  if (markdown !== renderNavigation(result.index)) result.errors.push('navigation.md does not match navigation.json');
  return { valid: result.errors.length === 0, errors: result.errors };
}

export async function refreshContext(project: string): Promise<{ updated: string[] }> {
  const result = await validateIndex(project);
  if (!result.index) throw new Error(result.errors.join('; '));
  const root = resolve(project); const markdownPath = join(root, '.ai-workflow/index/navigation.md');
  if (await exists(markdownPath) && !(await lstat(markdownPath)).isFile()) throw new Error('navigation.md must be a regular file');
  const json = `${JSON.stringify(result.index, null, 2)}\n`;
  await atomicWrite(join(root, '.ai-workflow/index/navigation.json'), json);
  await atomicWrite(markdownPath, renderNavigation(result.index));
  return { updated: ['.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'] };
}
