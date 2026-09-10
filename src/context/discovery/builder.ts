import type { DiscoveredFile, DiscoveryFacts } from './scanner.js';
import type { AdapterResult, CandidateModuleRoot, DiscoveryCandidate, DiscoveryDiagnostic } from './types.js';
import { analyzeModule, detectModules } from './adapters.js';
import type { ProjectConfig, ProjectConfigFeature, ProjectConfigModule } from './project-config.js';
import type {
  NavigationFeature,
  NavigationIndex,
  NavigationModuleRoot,
  NavigationRelation,
  NavigationSymbol
} from '../navigation.js';

export interface BuildNavigationResult {
  index: NavigationIndex;
  diagnostics: DiscoveryDiagnostic[];
}

interface ModulePlan {
  candidate: CandidateModuleRoot;
  languages: string[];
  sourceRoots: string[];
  testRoots: string[];
  files: DiscoveryFacts;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

function joinProject(base: string, relative: string): string {
  const normalizedBase = normalizePath(base);
  const normalizedRelative = normalizePath(relative);
  if (normalizedBase === '.') return normalizedRelative;
  if (normalizedRelative === '.') return normalizedBase;
  return `${normalizedBase}/${normalizedRelative}`;
}

function isWithinPath(path: string, prefix: string): boolean {
  const normalizedPrefix = normalizePath(prefix);
  if (normalizedPrefix === '.') return true;
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

function topLevelDirectory(path: string): string {
  const separator = path.indexOf('/');
  return separator === -1 ? '.' : path.slice(0, separator);
}

function isSemanticLanguage(language: string): boolean {
  return language === 'typescript' || language === 'javascript';
}

function entryKindsForLanguages(languages: string[]): string[] {
  const kinds: string[] = [];
  if (languages.some((language) => !isSemanticLanguage(language))) kinds.push('file');
  if (languages.some((language) => isSemanticLanguage(language))) kinds.push('exported-symbol');
  return kinds.length > 0 ? kinds : ['file'];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function deDuplicatedFiles(files: DiscoveredFile[]): DiscoveredFile[] {
  const byPath = new Map<string, DiscoveredFile>();
  for (const file of files) {
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

function configForFeature(feature: ProjectConfigFeature, config: ProjectConfig): ProjectConfigModule | undefined {
  return config.modules.find((module) => module.id === feature.moduleRoot);
}

function buildExplicitFeature(
  feature: ProjectConfigFeature,
  config: ProjectConfig,
  files: DiscoveredFile[]
): NavigationFeature {
  const module = configForFeature(feature, config);
  const testRoots = (module?.testRoots ?? []).map((root) => joinProject(module?.path ?? '.', root));
  const expanded = files.filter((file) =>
    feature.paths.some((featurePath) => isWithinPath(file.path, normalizePath(featurePath)))
  );

  const entries: string[] = [];
  const tests: string[] = [];
  for (const file of expanded) {
    if (testRoots.some((prefix) => isWithinPath(file.path, prefix))) tests.push(file.path);
    else entries.push(file.path);
  }

  const sortedEntries = sortedUnique(entries);
  const sortedTests = sortedUnique(tests);
  return {
    id: feature.id,
    name: feature.name,
    aliases: [],
    module_root: feature.moduleRoot,
    entries: sortedEntries,
    symbols: [],
    related_files: [],
    tests: sortedTests,
    depends_on: [],
    relations: [],
    owner_role: 'shared',
    responsibility: `Configured feature ${feature.name}`,
    read_scope: sortedUnique([...sortedEntries, ...sortedTests]),
    shared_entry: false
  };
}

function configuredPlan(module: ProjectConfigModule, facts: DiscoveryFacts): ModulePlan {
  const path = normalizePath(module.path);
  const languages = [...new Set(module.languages)];
  const soleLanguage = languages[0];
  const language = languages.length === 1 && soleLanguage !== undefined ? soleLanguage : 'mixed';
  const candidate: CandidateModuleRoot = {
    id: module.id,
    path,
    ownerRole: 'shared',
    responsibility: `Configured ${language} module at ${path}`,
    language,
    entryKinds: entryKindsForLanguages(languages)
  };
  return {
    candidate,
    languages,
    sourceRoots: module.sourceRoots.map((root) => joinProject(path, root)),
    testRoots: module.testRoots.map((root) => joinProject(path, root)),
    files: { files: facts.files.filter((file) => isWithinPath(file.path, path)) }
  };
}

function discoveredSourceRoots(files: DiscoveredFile[]): string[] {
  const prefixes = new Set<string>();
  for (const file of files) {
    const separator = file.path.lastIndexOf('/');
    prefixes.add(separator === -1 ? file.path : file.path.slice(0, separator));
  }
  return [...prefixes].filter((prefix) => prefix !== '' && prefix !== '.').sort(compareStrings);
}

function conventionalJavaRoot(modulePath: string, conventional: string, files: DiscoveredFile[]): string | undefined {
  const root = joinProject(modulePath, conventional);
  return files.some((file) => isWithinPath(file.path, root)) ? root : undefined;
}

function discoveredPlan(module: CandidateModuleRoot, facts: DiscoveryFacts): ModulePlan {
  const path = normalizePath(module.path);
  const semantic = isSemanticLanguage(module.language);
  const moduleFiles = semantic
    ? facts.files.filter((file) => isSemanticLanguage(file.language) && topLevelDirectory(file.path) === path)
    : facts.files.filter((file) => isWithinPath(file.path, path));
  const javaSourceRoot = semantic ? undefined : conventionalJavaRoot(path, 'src/main/java', moduleFiles);
  const javaTestRoot = semantic ? undefined : conventionalJavaRoot(path, 'src/test/java', moduleFiles);
  return {
    candidate: module,
    languages: [module.language],
    sourceRoots: semantic ? discoveredSourceRoots(moduleFiles) : javaSourceRoot ? [javaSourceRoot] : [path],
    testRoots: javaTestRoot ? [javaTestRoot] : [],
    files: { files: moduleFiles }
  };
}

async function analyzePlan(root: string, plan: ModulePlan): Promise<AdapterResult[]> {
  if (plan.languages.length <= 1) {
    return [
      await analyzeModule({
        root,
        facts: plan.files,
        moduleRoot: plan.candidate,
        sourceRoots: plan.sourceRoots,
        testRoots: plan.testRoots
      })
    ];
  }

  const results: AdapterResult[] = [];
  for (const language of plan.languages) {
    const languageRoot: CandidateModuleRoot = {
      ...plan.candidate,
      language,
      entryKinds: entryKindsForLanguages([language])
    };
    results.push(
      await analyzeModule({
        root,
        facts: plan.files,
        moduleRoot: languageRoot,
        sourceRoots: plan.sourceRoots,
        testRoots: plan.testRoots
      })
    );
  }
  return results;
}

function relationFile(endpoint: string): string {
  const separator = endpoint.indexOf('#');
  return separator === -1 ? endpoint : endpoint.slice(0, separator);
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

function generateFeature(
  candidate: DiscoveryCandidate,
  used: Set<string>,
  owned: Set<string>
): NavigationFeature | undefined {
  const entries = sortedUnique(candidate.entries.filter((path) => !owned.has(path)));
  const relatedFiles = sortedUnique(candidate.relatedFiles.filter((path) => !owned.has(path)));
  const tests = sortedUnique(candidate.tests.filter((path) => !owned.has(path)));
  if (entries.length === 0 && relatedFiles.length === 0 && tests.length === 0) return undefined;

  const allowed = new Set([...entries, ...relatedFiles, ...tests]);
  const symbols = candidate.symbols.filter((symbol) => allowed.has(symbol.file));
  const relations = candidate.relations.filter(
    (relation) => allowed.has(relationFile(relation.from)) && allowed.has(relationFile(relation.to))
  );
  const readScope = sortedUnique([...entries, ...relatedFiles, ...tests]);

  return {
    id: uniqueId(candidate.id, used),
    name: candidate.name,
    aliases: [],
    module_root: candidate.moduleRoot,
    entries,
    symbols,
    related_files: relatedFiles,
    tests,
    depends_on: [],
    relations,
    owner_role: candidate.ownerRole,
    responsibility: candidate.responsibility,
    read_scope: readScope,
    shared_entry: candidate.sharedEntry
  };
}

function symbolKey(symbol: NavigationSymbol): string {
  return `${symbol.file}\u0000${symbol.name}\u0000${symbol.kind}\u0000${symbol.visibility}`;
}

function relationKey(relation: NavigationRelation): string {
  return `${relation.kind}\u0000${relation.from}\u0000${relation.to}`;
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function canonicalizeFeature(feature: NavigationFeature): NavigationFeature {
  const symbols = uniqueBy(feature.symbols, symbolKey).sort(
    (left, right) =>
      compareStrings(left.file, right.file) ||
      compareStrings(left.name, right.name) ||
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.visibility, right.visibility)
  );
  const relations = uniqueBy(feature.relations, relationKey).sort(
    (left, right) =>
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.from, right.from) ||
      compareStrings(left.to, right.to)
  );

  const canonical: NavigationFeature = {
    id: feature.id,
    name: feature.name,
    aliases: sortedUnique(feature.aliases),
    module_root: feature.module_root,
    entries: sortedUnique(feature.entries),
    symbols,
    related_files: sortedUnique(feature.related_files),
    tests: sortedUnique(feature.tests),
    depends_on: sortedUnique(feature.depends_on),
    relations,
    owner_role: feature.owner_role,
    responsibility: feature.responsibility,
    read_scope: sortedUnique(feature.read_scope),
    shared_entry: feature.shared_entry
  };
  if (feature.task_ids !== undefined) canonical.task_ids = [...feature.task_ids];
  if (feature.requirement_ids !== undefined) canonical.requirement_ids = [...feature.requirement_ids];
  if (feature.acceptance_criteria_ids !== undefined) {
    canonical.acceptance_criteria_ids = [...feature.acceptance_criteria_ids];
  }
  return canonical;
}

export function canonicalizeNavigation(index: NavigationIndex): NavigationIndex {
  const moduleRoots = index.module_roots
    .map((root) => ({ ...root, entry_kinds: [...root.entry_kinds] }))
    .sort((left, right) => compareStrings(left.id, right.id));
  const features = index.features
    .map((feature) => canonicalizeFeature(feature))
    .sort((left, right) => compareStrings(left.id, right.id));
  return { version: 1, module_roots: moduleRoots, features };
}

export function renderNavigationJson(index: NavigationIndex): string {
  return `${JSON.stringify(canonicalizeNavigation(index), null, 2)}\n`;
}

function canonicalizeDiagnostics(diagnostics: DiscoveryDiagnostic[]): DiscoveryDiagnostic[] {
  const unique = uniqueBy(diagnostics, (diagnostic) => `${diagnostic.path}\u0000${diagnostic.code}\u0000${diagnostic.message}`);
  return unique.sort(
    (left, right) =>
      compareStrings(left.path, right.path) ||
      compareStrings(left.code, right.code) ||
      compareStrings(left.message, right.message)
  );
}

function toNavigationRoot(candidate: CandidateModuleRoot): NavigationModuleRoot {
  return {
    id: candidate.id,
    path: candidate.path,
    owner_role: candidate.ownerRole,
    responsibility: candidate.responsibility,
    language: candidate.language,
    entry_kinds: [...candidate.entryKinds]
  };
}

export async function buildNavigation(
  root: string,
  facts: DiscoveryFacts,
  config?: ProjectConfig
): Promise<BuildNavigationResult> {
  const files = deDuplicatedFiles(facts.files);
  const dedupedFacts: DiscoveryFacts = { files };
  const diagnostics: DiscoveryDiagnostic[] = [];
  const features: NavigationFeature[] = [];
  const owned = new Set<string>();

  const explicitFeatures = config?.features ?? [];
  const usedIds = new Set(explicitFeatures.map((feature) => feature.id));
  if (config) {
    for (const feature of explicitFeatures) features.push(buildExplicitFeature(feature, config, files));
  }
  for (const feature of features) {
    for (const path of [...feature.entries, ...feature.related_files, ...feature.tests]) owned.add(path);
  }

  const configuredPlans = (config?.modules ?? []).map((module) => configuredPlan(module, dedupedFacts));
  const configuredPaths = configuredPlans.map((plan) => plan.candidate.path);
  const detected = await detectModules(root, dedupedFacts);
  const discoveredPlans = detected
    .filter((module) => !configuredPaths.some((configured) => isWithinPath(normalizePath(module.path), configured)))
    .map((module) => discoveredPlan(module, dedupedFacts));

  const orderedPlans = [
    ...[...configuredPlans].sort((left, right) => compareStrings(left.candidate.id, right.candidate.id)),
    ...[...discoveredPlans].sort((left, right) => compareStrings(left.candidate.path, right.candidate.path))
  ];

  for (const plan of orderedPlans) {
    const results = await analyzePlan(root, plan);
    for (const result of results) {
      diagnostics.push(...result.diagnostics);
      for (const candidate of result.candidates) {
        const feature = generateFeature(candidate, usedIds, owned);
        if (!feature) continue;
        features.push(feature);
        for (const path of [...feature.entries, ...feature.related_files, ...feature.tests]) owned.add(path);
      }
    }
  }

  const moduleRoots = new Map<string, NavigationModuleRoot>();
  for (const plan of [...configuredPlans, ...discoveredPlans]) {
    if (!moduleRoots.has(plan.candidate.id)) moduleRoots.set(plan.candidate.id, toNavigationRoot(plan.candidate));
  }

  return {
    index: canonicalizeNavigation({ version: 1, module_roots: [...moduleRoots.values()], features }),
    diagnostics: canonicalizeDiagnostics(diagnostics)
  };
}
