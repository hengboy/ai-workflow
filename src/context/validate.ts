import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, exists } from '../utils/fs.js';

export interface ContextValidation { valid: boolean; errors: string[] }
export interface ContextUpdate { memory: string; navigation: string }
export async function updateContext(project: string, update: ContextUpdate): Promise<{ updated: string[] }> {
  const memoryPath = join(project, 'MEMORY.md'); const navigationPath = join(project, '.ai-workflow/index/navigation.md');
  await atomicWrite(memoryPath, update.memory); await atomicWrite(navigationPath, update.navigation);
  const validation = await validateContext(project); if (!validation.valid) throw new Error(validation.errors.join('; ')); return { updated: ['MEMORY.md', '.ai-workflow/index/navigation.md'] };
}
export async function validateContext(project: string): Promise<ContextValidation> {
  const memoryPath = join(project, 'MEMORY.md'); const navigationPath = join(project, '.ai-workflow/index/navigation.md'); const errors: string[] = [];
  if (!(await exists(memoryPath))) errors.push('Missing MEMORY.md'); if (!(await exists(navigationPath))) errors.push('Missing .ai-workflow/index/navigation.md');
  if (!errors.length) { const memory = await readFile(memoryPath, 'utf8'); const navigation = await readFile(navigationPath, 'utf8'); if (!/^#\s+/m.test(memory)) errors.push('MEMORY.md needs a title'); if (!/\|\s*Feature\s*\|\s*Entry\s*\|\s*Responsibility\s*\|/i.test(navigation)) errors.push('Navigation needs Feature, Entry and Responsibility columns'); }
  return { valid: errors.length === 0, errors };
}
