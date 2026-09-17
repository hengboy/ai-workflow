import { join } from 'node:path';
import { resolveProjectRoot } from '../context/paths.js';
import { exists } from '../utils/fs.js';
import { noteClasses, noteLifecycles } from './index.js';

export async function validateNotes(project: string): Promise<{ valid: boolean; errors: string[] }> {
  const root = resolveProjectRoot(project);
  const notesRoot = '.ai-workflow/notes';
  const requiredPaths = [
    '.ai-workflow/AGENTS.md',
    notesRoot,
    `${notesRoot}/AGENTS.md`,
    `${notesRoot}/README.md`,
    `${notesRoot}/implemented/AGENTS.md`,
    `${notesRoot}/archived/AGENTS.md`,
    `${notesRoot}/archived/manifest.json`,
    ...noteLifecycles.flatMap((lifecycle) => [
      `${notesRoot}/${lifecycle}`,
      ...noteClasses.map((noteClass) => `${notesRoot}/${lifecycle}/${noteClass}`),
    ]),
  ];
  const errors: string[] = [];
  for (const path of requiredPaths) {
    if (!(await exists(join(root, path)))) errors.push(`${path}: required notes structure is missing`);
  }
  return { valid: errors.length === 0, errors };
}
