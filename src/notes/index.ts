import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const noteLifecycles = ['proposed', 'implemented', 'rejected', 'archived'] as const;
export const noteClasses = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing'] as const;

export async function* enumerateNotes(root: string) {
  for (const lifecycle of noteLifecycles) {
    for (const noteClass of noteClasses) {
      const directory = `.ai-workflow/notes/${lifecycle}/${noteClass}`;
      const files = await readdir(join(root, directory), { withFileTypes: true });
      for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
        if (file.isFile() && file.name.endsWith('.md')) {
          yield { path: `${directory}/${file.name}`, lifecycle };
        }
      }
    }
  }
}
