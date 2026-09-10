import type { AdapterResult, CandidateModuleRoot, DiscoveryCandidate } from './types.js';
import type { DiscoveryFacts } from './scanner.js';
import { analyzeTypeScriptModule, detectTypeScriptModules } from './typescript.js';
import { analyzeJavaModule, detectJavaModules } from './java.js';

export interface ModuleAnalysisRequest {
  root: string;
  facts: DiscoveryFacts;
  moduleRoot: CandidateModuleRoot;
  sourceRoots: string[];
  testRoots: string[];
}

export type ModuleAnalyzer = (request: ModuleAnalysisRequest) => Promise<AdapterResult>;

export type DetectionResult = CandidateModuleRoot[];

const analyzers: Record<string, ModuleAnalyzer> = {
  java: analyzeJavaModule,
  typescript: analyzeTypeScriptModule,
  javascript: analyzeTypeScriptModule
};

export function analyzerForLanguage(language: string): ModuleAnalyzer | undefined {
  return analyzers[language];
}

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

function structuralCandidate(request: ModuleAnalysisRequest): AdapterResult {
  const { facts, moduleRoot, sourceRoots, testRoots } = request;
  const sourcePrefixes = sourceRoots.map((entry) => projectPrefix(moduleRoot.path, entry)).filter((prefix) => prefix !== '');
  const testPrefixes = testRoots.map((entry) => projectPrefix(moduleRoot.path, entry)).filter((prefix) => prefix !== '');
  const isTest = (path: string): boolean => testPrefixes.some((prefix) => isWithin(path, prefix));
  const isSource = (path: string): boolean => sourcePrefixes.some((prefix) => isWithin(path, prefix));

  const entries: string[] = [];
  const tests: string[] = [];
  for (const file of facts.files) {
    if (isTest(file.path)) tests.push(file.path);
    else if (isSource(file.path)) entries.push(file.path);
  }
  entries.sort(compareStrings);
  tests.sort(compareStrings);

  const candidate: DiscoveryCandidate = {
    id: moduleRoot.id,
    name: moduleRoot.id,
    moduleRoot: moduleRoot.id,
    entries,
    relatedFiles: [],
    tests,
    symbols: [],
    relations: [],
    ownerRole: moduleRoot.ownerRole,
    responsibility: moduleRoot.responsibility,
    sharedEntry: false
  };
  return { moduleRoots: [moduleRoot], candidates: [candidate], diagnostics: [] };
}

export async function analyzeModule(request: ModuleAnalysisRequest): Promise<AdapterResult> {
  const analyzer = analyzerForLanguage(request.moduleRoot.language);
  if (!analyzer) return structuralCandidate(request);
  return analyzer(request);
}

export function detectModules(_root: string, facts: DiscoveryFacts): Promise<CandidateModuleRoot[]> {
  const byPath = new Map<string, CandidateModuleRoot>();
  for (const root of [...detectJavaModules(facts), ...detectTypeScriptModules(facts)]) {
    if (!byPath.has(root.path)) byPath.set(root.path, root);
  }
  return Promise.resolve([...byPath.values()].sort((left, right) => compareStrings(left.path, right.path)));
}
