import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProjectRoot } from '../context/paths.js';
import { atomicWrite, exists, readJson } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { enumerateNotes, type NoteAnchor } from './index.js';
import { notesRoot } from './pairing.js';
import { validateNotePair } from './validate.js';

const manifestPath = `${notesRoot}/archived/manifest.json`;

type ArchiveManifest = { version: 1; files: Record<string, string> };

function artifactKey(path: string): string {
  return path.slice(notesRoot.length + 1);
}

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
    if (!(await exists(path))) throw new Error(`${path}: sealed archived artifact is missing`);
    if (sha256(await readFile(path)) !== digest) throw new Error(`${path}: sealed archived artifact bytes changed`);
  }

  const pending: NoteAnchor[] = [];
  for await (const note of enumerateNotes(root)) {
    if (note.lifecycle !== 'archived') continue;
    if (artifactKey(note.path) in existing) continue;
    const errors: string[] = [];
    await validateNotePair(root, note, errors);
    if (errors.length) throw new Error(errors.join('\n'));
    pending.push(note);
  }
  pending.sort((a, b) => a.path.localeCompare(b.path));
  if (pending.length === 0) return { sealed: [] };

  const files = { ...existing };
  const sealed: string[] = [];
  for (const note of pending) {
    for (const artifact of [note.path, note.zhPath, note.metaPath]) {
      files[artifactKey(artifact)] = sha256(await readFile(join(root, artifact)));
    }
    sealed.push(artifactKey(note.path));
  }
  await atomicWrite(manifestFile, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
  return { sealed };
}
