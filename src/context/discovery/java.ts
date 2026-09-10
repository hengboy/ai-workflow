import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DiscoveryFacts } from './scanner.js';
import type { AdapterResult, CandidateModuleRoot, DiscoveryCandidate, DiscoveryDiagnostic } from './types.js';
import type { ModuleAnalysisRequest } from './adapters.js';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function trimSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function projectPrefix(moduleRootPath: string, declared: string): string {
  const normalizedDeclared = trimSlashes(declared);
  if (normalizedDeclared === '' || normalizedDeclared === '.') return trimSlashes(moduleRootPath);
  return normalizedDeclared;
}

function isWithin(path: string, prefix: string): boolean {
  return prefix !== '' && (path === prefix || path.startsWith(`${prefix}/`));
}

const JAVA_BUILD_FILES = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts']);
const RECOGNIZED_ANNOTATION = /@(?:[\w$]+\.)*(SpringBootApplication|RestController|Controller|Service|Repository|Configuration)(?![\w$])/;
const PACKAGE_PATTERN = /(?:^|\n)\s*package\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;/;

export function detectJavaModules(facts: DiscoveryFacts): CandidateModuleRoot[] {
  const paths = new Set<string>();
  for (const file of facts.files) {
    if (!JAVA_BUILD_FILES.has(basename(file.path))) continue;
    const directory = dirname(file.path).replace(/\\/g, '/');
    paths.add(directory === '' ? '.' : directory);
  }
  return [...paths].sort(compareStrings).map((path) => ({
    id: path === '.' ? 'root' : path,
    path,
    ownerRole: 'shared',
    responsibility: `Discovered java module at ${path}`,
    language: 'java',
    entryKinds: ['file']
  }));
}

interface StrippedJava {
  text: string;
  unterminated: boolean;
}

function stripJavaLiteralsAndComments(source: string): StrippedJava {
  let result = '';
  let index = 0;
  let unterminated = false;
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === '/' && next === '/') {
      while (index < source.length && source.charAt(index) !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      let closed = false;
      while (index < source.length) {
        if (source.charAt(index) === '*' && source.charAt(index + 1) === '/') {
          index += 2;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) unterminated = true;
      result += ' ';
      continue;
    }
    if (char === '"' && source.startsWith('"""', index)) {
      index += 3;
      let closed = false;
      while (index < source.length) {
        if (source.startsWith('"""', index)) {
          index += 3;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) unterminated = true;
      result += ' ';
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source.charAt(index);
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (current === '\n') break;
        index += 1;
      }
      if (!closed) unterminated = true;
      result += ' ';
      continue;
    }
    result += char;
    index += 1;
  }
  return { text: result, unterminated };
}

interface JavaPackageGroup {
  main: string[];
  tests: string[];
}

export async function analyzeJavaModule(request: ModuleAnalysisRequest): Promise<AdapterResult> {
  const { root, facts, moduleRoot, testRoots } = request;
  const testPrefixes = testRoots.map((entry) => projectPrefix(moduleRoot.path, entry)).filter((prefix) => prefix !== '');
  const isTestPath = (path: string): boolean => testPrefixes.some((prefix) => isWithin(path, prefix));

  const groups = new Map<string, JavaPackageGroup>();
  const annotatedPaths = new Set<string>();
  const diagnostics: DiscoveryDiagnostic[] = [];

  for (const file of facts.files) {
    if (file.language !== 'java') continue;
    const stripped = stripJavaLiteralsAndComments(await readFile(join(root, file.path), 'utf8'));
    if (stripped.unterminated) {
      diagnostics.push({
        path: file.path,
        code: 'java-unclassified',
        message: `Could not structurally classify ${file.path}: unterminated comment or string literal`
      });
    }
    const declared = PACKAGE_PATTERN.exec(stripped.text)?.[1] ?? '';
    const packageName = declared.replace(/\s+/g, '');
    const id = packageName.length > 0 ? packageName : `${moduleRoot.id}-default`;
    const group = groups.get(id) ?? { main: [], tests: [] };
    if (isTestPath(file.path)) {
      group.tests.push(file.path);
    } else {
      group.main.push(file.path);
      if (RECOGNIZED_ANNOTATION.test(stripped.text)) annotatedPaths.add(file.path);
    }
    groups.set(id, group);
  }

  const candidates: DiscoveryCandidate[] = [...groups.keys()].sort(compareStrings).map((id) => {
    const group = groups.get(id) ?? { main: [], tests: [] };
    const main = [...group.main].sort(compareStrings);
    const annotated = main.filter((path) => annotatedPaths.has(path));
    const entries = annotated.length > 0 ? annotated : main;
    const relatedFiles = annotated.length > 0 ? main.filter((path) => !annotatedPaths.has(path)) : [];
    return {
      id,
      name: id,
      moduleRoot: moduleRoot.id,
      entries,
      relatedFiles,
      tests: [...group.tests].sort(compareStrings),
      symbols: [],
      relations: [],
      ownerRole: moduleRoot.ownerRole,
      responsibility: moduleRoot.responsibility,
      sharedEntry: false
    };
  });

  return { moduleRoots: [moduleRoot], candidates, diagnostics };
}
