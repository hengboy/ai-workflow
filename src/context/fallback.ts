import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface FallbackPacket {
  status: string;
  reason: string;
  objective: string;
  known_paths: string[];
  module_roots: string[];
  maintain_index: boolean;
  question: string;
}

export type FallbackAuthorization = { status: 'authorized'; module_roots: string[] } | { status: 'blocked'; reason: string };

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${String.raw`/`}`) && !isAbsolute(path);
}

function concreteDirectory(path: string): boolean {
  return path.length > 0 && path !== '.' && !isAbsolute(path) && !path.endsWith('/') && !path.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0) && !/[?*[\]{}$<>]/.test(path);
}

export async function authorizeFallback(project: string, packet: FallbackPacket): Promise<FallbackAuthorization> {
  if (!['missing_index', 'miss', 'stale', 'invalid'].includes(packet.status)) return { status: 'blocked', reason: `${packet.status} does not permit fallback` };
  if (!packet.objective || !packet.reason || !packet.question) return { status: 'blocked', reason: 'Fallback packet requires objective, reason and question' };
  if (!packet.module_roots.length) return { status: 'blocked', reason: 'Fallback packet requires an authorized module root' };
  const root = resolve(project); const realRoot = await realpath(root);
  for (const moduleRoot of packet.module_roots) {
    if (!concreteDirectory(moduleRoot)) return { status: 'blocked', reason: `${moduleRoot}: expected a concrete project directory` };
    const target = resolve(root, moduleRoot);
    if (!isWithin(root, target)) return { status: 'blocked', reason: `${moduleRoot}: directory escapes project` };
    try {
      if (!(await lstat(target)).isDirectory() || !isWithin(realRoot, await realpath(target))) return { status: 'blocked', reason: `${moduleRoot}: expected a concrete project directory` };
    } catch {
      return { status: 'blocked', reason: `${moduleRoot}: expected a concrete project directory` };
    }
  }
  return { status: 'authorized', module_roots: [...new Set(packet.module_roots)] };
}
