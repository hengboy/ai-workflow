import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { NavigationIndex } from '../context/navigation.js';

export interface AffectedTestsResult {
  match: boolean;
  features: string[];
  tests: string[];
  command: string | null;
  message: string;
  exitCode: number;
}

const NAVIGATION_PATH = '.ai-workflow/index/navigation.json';
const FALLBACK = 'run the declared task or plan checks instead';

function repositoryPath(project: string, path: string): string {
  const value = isAbsolute(path) ? relative(project, path) : path;
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function noMatch(paths: string[], reason?: string): AffectedTestsResult {
  const target = paths.length ? paths.join(', ') : 'no changed paths';
  const detail = reason === undefined ? '' : ` (${reason})`;
  return {
    match: false,
    features: [],
    tests: [],
    command: null,
    message: `No indexed test matched ${target}${detail}; ${FALLBACK}.`,
    exitCode: 1
  };
}

/** Map changed repository paths to the union of indexed tests owned by matching features. */
export async function suggestAffectedTests(project: string, changedPaths: string[]): Promise<AffectedTestsResult> {
  if (changedPaths.length === 0) return noMatch([]);

  let index: NavigationIndex;
  try {
    index = JSON.parse(await readFile(join(project, NAVIGATION_PATH), 'utf8')) as NavigationIndex;
  } catch {
    return noMatch(changedPaths, 'navigation index is missing or invalid');
  }
  if (!Array.isArray(index.features)) return noMatch(changedPaths, 'navigation index is missing or invalid');

  const targets = [...new Set(changedPaths.map((path) => repositoryPath(project, path)))].sort();
  const owners = index.features.filter((feature) => feature.entries.some((entry) => targets.includes(entry)));
  const features = [...new Set(owners.map((feature) => feature.id))].sort();
  const tests = [...new Set(owners.flatMap((feature) => feature.tests))].sort();
  if (features.length === 0 || tests.length === 0) return noMatch(targets);

  return {
    match: true,
    features,
    tests,
    command: `pnpm exec vitest run ${tests.join(' ')}`,
    message: `Matched ${features.join(', ')}.`,
    exitCode: 0
  };
}

/** Render the advisory output; a match prints one suggested command, never a second. */
export function formatAffectedTests(result: AffectedTestsResult): string {
  if (!result.match || result.command === null) return result.message;
  return ['Affected tests:', ...result.tests, `Suggested command: ${result.command}`].join('\n');
}
