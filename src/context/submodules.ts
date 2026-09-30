import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SubmoduleDeclaration {
  name: string;
  path: string;
}

const SUBMODULES_FILENAME = '.gitmodules';

function normalizeDeclarationPath(raw: string): string {
  let path = raw.trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  return path.replace(/\/+$/, '');
}

/**
 * Read the declared submodules from `<root>/.gitmodules` on every call.
 * Missing files yield no declarations; comments and blank lines are ignored;
 * sections without a `path` are skipped and the last declaration wins for a
 * duplicated path.
 */
export async function readSubmodules(root: string): Promise<SubmoduleDeclaration[]> {
  let contents: string;
  try {
    contents = await readFile(join(root, SUBMODULES_FILENAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const byPath = new Map<string, SubmoduleDeclaration>();
  let name: string | undefined;
  let path: string | undefined;

  const commit = (): void => {
    if (name !== undefined && path !== undefined && path !== '') byPath.set(path, { name, path });
    name = undefined;
    path = undefined;
  };

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const section = /^\[submodule\s+"([^"]+)"\]$/i.exec(trimmed);
    if (section) {
      commit();
      name = section[1];
      continue;
    }
    if (name === undefined) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    if (key !== 'path') continue;
    path = normalizeDeclarationPath(trimmed.slice(separator + 1));
  }
  commit();

  return [...byPath.values()];
}

/** Return the declaration that exactly equals, or contains on a `/` boundary, the given project-relative path. */
export function findSubmoduleBoundary(path: string, declarations: SubmoduleDeclaration[]): SubmoduleDeclaration | undefined {
  const normalized = normalizeDeclarationPath(path);
  if (normalized === '') return undefined;
  return declarations.find((declaration) => {
    const declared = normalizeDeclarationPath(declaration.path);
    return declared !== '' && (normalized === declared || normalized.startsWith(`${declared}/`));
  });
}
