import { isAbsolute, relative, resolve, sep } from 'node:path';

export function assertInside(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(root, candidate);
  const rel = relative(absoluteRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes root: ${candidate}`);
  return absolute;
}

export function normalizeScope(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe or broad scope: ${path}`);
  }
  return normalized;
}

export function canonicalPath(path: string): string {
  return resolve(path).replaceAll('\\', '/');
}

export function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}
