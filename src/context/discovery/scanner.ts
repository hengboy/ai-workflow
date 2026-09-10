import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type DiscoveredLanguage = 'typescript' | 'javascript' | 'java' | 'unknown';

export interface DiscoveredFile {
  path: string;
  language: DiscoveredLanguage;
}

export interface DiscoveryFacts {
  files: DiscoveredFile[];
}

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.ai-workflow',
  'node_modules',
  'vendor',
  'target',
  'build',
  'dist',
  'coverage',
  '.next',
  '.cache'
]);

export function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORIES.has(name);
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function languageFor(name: string): DiscoveredLanguage {
  const lower = name.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.java')) return 'java';
  return 'unknown';
}

function comparePaths(left: DiscoveredFile, right: DiscoveredFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

async function walk(root: string, directory: string, files: DiscoveredFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedDirectory(entry.name)) continue;
      await walk(root, absolute, files);
    } else if (entry.isFile()) {
      files.push({ path: toPosixPath(relative(root, absolute)), language: languageFor(entry.name) });
    }
  }
}

export async function scanProject(root: string): Promise<DiscoveryFacts> {
  const files: DiscoveredFile[] = [];
  await walk(root, root, files);
  files.sort(comparePaths);
  return { files };
}
