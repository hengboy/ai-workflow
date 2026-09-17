import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProjectRoot } from '../context/paths.js';
import { atomicWrite, exists, readJson } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { enumerateNotes } from './index.js';
import { validateFormat } from './validate.js';

const notesRoot = '.ai-workflow/notes';
const manifestPath = `${notesRoot}/archived/manifest.json`;

type ArchiveManifest = { version: 1; files: Record<string, string> };

export async function sealArchive(project: string): Promise<{ sealed: string[] }> {
  const root = resolveProjectRoot(project);
  const manifestFile = join(root, manifestPath);
  let manifest: ArchiveManifest;
  try {
    manifest = await readJson<ArchiveManifest>(manifestFile);
  } catch (error) {
    throw new Error(`${manifestPath}: archive manifest must be readable JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!manifest || manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error(`${manifestPath}: archive manifest must be { version: 1, files: { <path>: sha256:<hex> } }`);
  }
  const existing = manifest.files;

  for (const [key, digest] of Object.entries(existing)) {
    const path = join(root, notesRoot, key);
    if (!(await exists(path))) throw new Error(`${path}: sealed archived note is missing`);
    if (sha256(await readFile(path)) !== digest) throw new Error(`${path}: sealed archived note bytes changed`);
  }

  const sealed: string[] = [];
  for await (const note of enumerateNotes(root)) {
    if (note.lifecycle !== 'archived') continue;
    const key = note.path.slice(notesRoot.length + 1);
    if (key in existing) continue;
    const contents = await readFile(join(root, note.path), 'utf8');
    const formatErrors = validateFormat(note.path, note.lifecycle, contents);
    if (formatErrors.length) throw new Error(formatErrors.join('\n'));
    sealed.push(key);
  }
  sealed.sort((a, b) => a.localeCompare(b));
  if (sealed.length === 0) return { sealed: [] };

  const files = { ...existing };
  for (const key of sealed) files[key] = sha256(await readFile(join(root, notesRoot, key)));
  await atomicWrite(manifestFile, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
  return { sealed };
}
