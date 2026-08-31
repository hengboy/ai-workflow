import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists } from '../utils/fs.js';

export interface ContextValidation { valid: boolean; errors: string[] }
export async function validateContext(project: string): Promise<ContextValidation> {
  const memoryPath = join(project, 'MEMORY.md'); const navigationPath = join(project, '.ai-workflow/index/navigation.md'); const errors: string[] = [];
  if (!(await exists(memoryPath))) errors.push('Missing MEMORY.md'); if (!(await exists(navigationPath))) errors.push('Missing .ai-workflow/index/navigation.md');
  if (!errors.length) { const memory = await readFile(memoryPath, 'utf8'); const navigation = await readFile(navigationPath, 'utf8'); if (!/^#\s+/m.test(memory)) errors.push('MEMORY.md needs a title'); if (!/\|\s*Feature\s*\|/i.test(navigation)) errors.push('Navigation needs a feature table'); }
  return { valid: errors.length === 0, errors };
}
