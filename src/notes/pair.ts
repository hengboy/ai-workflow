import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProjectRoot } from '../context/paths.js';
import { atomicWrite, exists } from '../utils/fs.js';
import { enumerateNotes, noteLifecycles, type NoteAnchor } from './index.js';
import { blobHash, metaPathOf, notesRoot, pairAnchorOfArgument, parsePairMeta, renderPairMeta, zhPathOf } from './pairing.js';
import { validateNotePair } from './validate.js';

export type PairState = 'ok' | 'out-of-sync' | 'missing';

function lifecycleOf(path: string): typeof noteLifecycles[number] | undefined {
  return noteLifecycles.find((lifecycle) => path.startsWith(`${notesRoot}/${lifecycle}/`));
}

function projectRelativeAnchor(argument: string): string {
  const anchor = pairAnchorOfArgument(argument);
  if (anchor.startsWith(`${notesRoot}/`)) return anchor;
  const lifecycle = noteLifecycles.find((value) => anchor.startsWith(`${value}/`));
  if (lifecycle) return `${notesRoot}/${anchor}`;
  return anchor;
}

function anchorFrom(argument: string): NoteAnchor {
  const path = projectRelativeAnchor(argument);
  const lifecycle = lifecycleOf(path);
  if (!lifecycle) throw new Error(`${argument}: expected a note path under ${notesRoot}/<lifecycle>/<class>/`);
  return { path, lifecycle, zhPath: zhPathOf(path), metaPath: metaPathOf(path) };
}

async function pairState(root: string, note: NoteAnchor): Promise<PairState> {
  if (!(await exists(join(root, note.zhPath))) || !(await exists(join(root, note.metaPath)))) return 'missing';
  const entries = parsePairMeta(await readFile(join(root, note.metaPath), 'utf8'));
  if (!entries) return 'out-of-sync';
  const english = blobHash(await readFile(join(root, note.path)));
  const chinese = blobHash(await readFile(join(root, note.zhPath)));
  return entries.get(note.path.split('/').at(-1) ?? '') === english
    && entries.get(note.zhPath.split('/').at(-1) ?? '') === chinese
    ? 'ok'
    : 'out-of-sync';
}

export async function listPairs(project: string): Promise<{ entries: { path: string; state: PairState }[] }> {
  const root = resolveProjectRoot(project);
  const entries: { path: string; state: PairState }[] = [];
  for await (const note of enumerateNotes(root)) {
    entries.push({ path: note.path, state: await pairState(root, note) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries };
}

export async function verifyPairs(project: string, selections: string[] = []): Promise<{ valid: boolean; errors: string[] }> {
  const root = resolveProjectRoot(project);
  const errors: string[] = [];
  const anchors: NoteAnchor[] = selections.length
    ? selections.map((argument) => anchorFrom(argument))
    : await collectAnchors(root, errors);
  for (const note of anchors) {
    if (!(await exists(join(root, note.path)))) {
      errors.push(`${note.path}: English note is missing`);
      continue;
    }
    await validateNotePair(root, note, errors);
  }
  return { valid: errors.length === 0, errors };
}

export async function recordPairs(project: string, selections: string[], all: boolean): Promise<{ written: string[] }> {
  const root = resolveProjectRoot(project);
  const candidates: NoteAnchor[] = all
    ? await collectAnchors(root, [])
    : selections.map((argument) => anchorFrom(argument));
  const written: string[] = [];
  for (const note of candidates) {
    if (!(await exists(join(root, note.path)))) {
      if (all) continue;
      throw new Error(`${note.path}: English note is missing`);
    }
    if (!(await exists(join(root, note.zhPath)))) {
      if (all) continue;
      throw new Error(`${note.zhPath}: Chinese counterpart is missing; write both language files before recording the pair`);
    }
    const english = await readFile(join(root, note.path));
    const chinese = await readFile(join(root, note.zhPath));
    await atomicWrite(join(root, note.metaPath), renderPairMeta(note.path, blobHash(english), blobHash(chinese)));
    written.push(note.path);
  }
  return { written };
}

async function collectAnchors(root: string, errors: string[]): Promise<NoteAnchor[]> {
  const anchors: NoteAnchor[] = [];
  for await (const note of enumerateNotes(root, errors)) anchors.push(note);
  return anchors;
}
