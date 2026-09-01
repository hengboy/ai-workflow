import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type FallbackStatus = 'missing_index' | 'miss' | 'stale' | 'invalid';

export interface FallbackTarget {
  feature?: string;
  symbol?: string;
  task?: string;
}

export interface FallbackPacket {
  status: FallbackStatus;
  target: FallbackTarget;
  reason: string;
  known_paths: string[];
  known_symbols: string[];
  module_roots: string[];
  maintenance_authorized: boolean;
  question: string;
}

export type FallbackAuthorization = { status: 'authorized'; module_roots: string[] } | { status: 'blocked'; reason: string };
export type FallbackDiscovery = { status: 'discovered'; searched_roots: string[]; files: string[] } | { status: 'blocked'; reason: string };

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${String.raw`/`}`) && !isAbsolute(path);
}

function concreteDirectory(path: string): boolean {
  return path.length > 0 && path !== '.' && !isAbsolute(path) && !path.endsWith('/') && !path.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0) && !/[?*[\]{}$<>]/.test(path);
}

function exactFilePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.endsWith('/') && !path.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0) && !/[?*[\]{}$<>]/.test(path);
}

function hasOneTarget(target: FallbackTarget): boolean {
  return [target.feature, target.symbol, target.task].filter(Boolean).length === 1;
}

export async function authorizeFallback(project: string, packet: FallbackPacket): Promise<FallbackAuthorization> {
  if (!['missing_index', 'miss', 'stale', 'invalid'].includes(packet.status)) return { status: 'blocked', reason: `${packet.status} does not permit fallback` };
  if (!hasOneTarget(packet.target) || !packet.reason || !packet.question) return { status: 'blocked', reason: 'Fallback packet requires one target, reason and question' };
  if (!Array.isArray(packet.known_paths) || !Array.isArray(packet.known_symbols) || !Array.isArray(packet.module_roots) || typeof packet.maintenance_authorized !== 'boolean') return { status: 'blocked', reason: 'Fallback packet has invalid fields' };
  if (new Set(packet.known_paths).size !== packet.known_paths.length || new Set(packet.module_roots).size !== packet.module_roots.length) return { status: 'blocked', reason: 'Fallback packet has duplicate paths or roots' };
  if (!packet.module_roots.length) return { status: 'blocked', reason: 'Fallback packet requires an authorized module root' };
  const root = resolve(project); const realRoot = await realpath(root);
  const authorizedRoots: Array<{ path: string; real: string }> = [];
  for (const moduleRoot of packet.module_roots) {
    if (!concreteDirectory(moduleRoot)) return { status: 'blocked', reason: `${moduleRoot}: expected a concrete project directory` };
    const target = resolve(root, moduleRoot);
    if (!isWithin(root, target)) return { status: 'blocked', reason: `${moduleRoot}: directory escapes project` };
    try {
      const real = await realpath(target);
      if (!(await lstat(target)).isDirectory() || !isWithin(realRoot, real)) return { status: 'blocked', reason: `${moduleRoot}: expected a concrete project directory` };
      authorizedRoots.push({ path: target, real });
    } catch {
      return { status: 'blocked', reason: `${moduleRoot}: expected a concrete project directory` };
    }
  }
  for (const path of packet.known_paths) {
    if (!exactFilePath(path)) return { status: 'blocked', reason: `${path}: expected an exact known file path` };
    const target = resolve(root, path);
    if (!isWithin(root, target) || !authorizedRoots.some((moduleRoot) => isWithin(moduleRoot.path, target))) return { status: 'blocked', reason: `${path}: known path is outside authorized module roots` };
  }
  return { status: 'authorized', module_roots: [...new Set(packet.module_roots)] };
}

async function validateKnownPaths(project: string, packet: FallbackPacket): Promise<FallbackAuthorization> {
  const authorization = await authorizeFallback(project, packet);
  if (authorization.status === 'blocked') return authorization;
  const root = resolve(project); const realRoot = await realpath(root);
  for (const path of packet.known_paths) {
    const target = resolve(root, path);
    try {
      const info = await lstat(target);
      if (!info.isFile() || !isWithin(realRoot, await realpath(target))) return { status: 'blocked', reason: `${path}: known path escapes project` };
    } catch {
      // A stale locator can legitimately reference a file that was deleted.
    }
  }
  return authorization;
}

async function filesUnder(project: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(project, path));
    else if (entry.isFile()) files.push(relative(project, path));
  }
  return files;
}

export async function discoverFallback(project: string, packet: FallbackPacket): Promise<FallbackDiscovery> {
  const authorization = await validateKnownPaths(project, packet);
  if (authorization.status === 'blocked') return authorization;
  const root = resolve(project);
  const files = (await Promise.all(authorization.module_roots.map((moduleRoot) => filesUnder(root, resolve(root, moduleRoot))))).flat().sort();
  return { status: 'discovered', searched_roots: authorization.module_roots, files };
}
