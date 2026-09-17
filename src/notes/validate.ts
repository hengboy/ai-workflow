import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProjectRoot } from '../context/paths.js';
import { exists } from '../utils/fs.js';
import { enumerateNotes, noteClasses, noteLifecycles } from './index.js';

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
  if (errors.length) return { valid: false, errors };

  for await (const note of enumerateNotes(root)) {
    const contents = await readFile(join(root, note.path), 'utf8');
    const statusLine = contents.split(/\r?\n/)[2];
    const expectedStatus = note.lifecycle === 'archived' ? 'implemented' : note.lifecycle;
    const validStatus = expectedStatus === 'rejected'
      ? /^Status: rejected — \S[^\r\n]*$/.test(statusLine ?? '')
      : statusLine === `Status: ${expectedStatus}`;
    if (!validStatus) {
      const expected = expectedStatus === 'rejected' ? 'rejected — <one-line reason>' : expectedStatus;
      errors.push(`${note.path}: Status must be ${expected} for lifecycle ${note.lifecycle}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
