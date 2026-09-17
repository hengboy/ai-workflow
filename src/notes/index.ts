import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const noteLifecycles = ['proposed', 'implemented', 'rejected', 'archived'] as const;
export const noteClasses = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing'] as const;

export async function* enumerateNotes(root: string, errors: string[] = []) {
  const managementFiles = new Set(['AGENTS.md', 'README.md', 'implemented/AGENTS.md', 'archived/AGENTS.md', 'archived/manifest.json']);
  type Note = { path: string; lifecycle: typeof noteLifecycles[number] };
  async function* walk(parts: string[]): AsyncGenerator<Note> {
    const directory = ['.ai-workflow/notes', ...parts].join('/');
    const files = await readdir(join(root, directory), { withFileTypes: true });
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const segments = [...parts, file.name];
      const path = `${directory}/${file.name}`;
      const lifecycle = noteLifecycles.find((value) => value === segments[0]);
      const validClass = noteClasses.some((value) => value === segments[1]);
      if (file.isDirectory()) {
        if (!lifecycle || segments.length > 2 || (segments.length === 2 && !validClass)) {
          errors.push(`${path}: unsupported lifecycle, class or nested directory`);
        }
        yield* walk(segments);
      } else if (file.isFile() && managementFiles.has(segments.join('/'))) {
        continue;
      } else if (file.isFile() && lifecycle && validClass && segments.length === 3) {
        yield { path, lifecycle };
      } else {
        errors.push(`${path}: unsupported lifecycle, class or note path; expected {lifecycle}/{class}/YYYY-MM-DD-topic-title.md`);
      }
    }
  }
  yield* walk([]);
}
