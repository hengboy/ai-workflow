import { isAbsolute, resolve } from 'node:path';

export function resolveProjectRoot(project: string): string {
  return resolve(project);
}

export function resolveCandidatePath(project: string, candidate: string): string {
  return isAbsolute(candidate) ? resolve(candidate) : resolve(resolveProjectRoot(project), candidate);
}
