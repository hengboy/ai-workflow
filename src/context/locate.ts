import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exists } from '../utils/fs.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';
import { type FallbackPacket, type FallbackStatus, type FallbackTarget } from './fallback.js';
import { type NavigationFeature, type NavigationIndex } from './navigation.js';
import { verifyNavigation } from './validate.js';
import { resolveProjectRoot } from './paths.js';

export interface LocateOptions {
  feature?: string;
  symbol?: string;
  task?: string;
  verify?: boolean;
  depth?: number;
  roots?: string[];
  maintenanceAuthorized?: boolean;
}

interface LocateHit {
  status: 'hit';
  resolution_mode: 'index';
  feature: string;
  entries: string[];
  symbols: string[];
  related_files: string[];
  tests: string[];
  read_order: string[];
  related_features: string[];
  fallback_required: false;
}

interface LocateFallback {
  status: FallbackStatus;
  resolution_mode: 'index';
  reason: string;
  fallback: FallbackPacket;
  fallback_required: true;
}

type LocateResult = LocateHit
  | LocateFallback
  | { status: 'ambiguous'; resolution_mode: 'index'; candidates: string[]; fallback_required: false }
  | { status: 'blocked'; resolution_mode: 'index'; reason: string; fallback_required: false };

function targetFor(options: LocateOptions): FallbackTarget {
  return { ...(options.feature ? { feature: options.feature } : {}), ...(options.symbol ? { symbol: options.symbol } : {}), ...(options.task ? { task: options.task } : {}) };
}

function fallback(options: LocateOptions, status: FallbackStatus, reason: string, knownPaths: string[] = [], knownSymbols: string[] = [], moduleRoots: string[] = options.roots ?? []): LocateFallback {
  const target = targetFor(options);
  const query = target.feature ?? target.symbol ?? target.task ?? 'requested context';
  return {
    status, resolution_mode: 'index', reason,
    fallback: { status, target, reason, known_paths: knownPaths, known_symbols: knownSymbols, module_roots: moduleRoots, maintenance_authorized: options.maintenanceAuthorized ?? false, question: `Which files and symbols satisfy ${query}?` },
    fallback_required: true
  };
}

async function loadIndex(project: string, options: LocateOptions): Promise<NavigationIndex | LocateResult> {
  const root = resolveProjectRoot(project); const jsonPath = join(root, '.ai-workflow/index/navigation.json');
  if (!(await exists(jsonPath))) return fallback(options, 'missing_index', 'Missing .ai-workflow/index/navigation.json');
  let index: NavigationIndex;
  try { index = JSON.parse(await readFile(jsonPath, 'utf8')) as NavigationIndex; } catch { return fallback(options, 'invalid', 'navigation.json is not valid JSON'); }
  const validator = await schemaValidator('navigation.schema.json');
  if (!validator(index)) return fallback(options, 'invalid', formatSchemaErrors(validator.errors));
  return index;
}

function candidatesFor(options: LocateOptions, index: NavigationIndex): NavigationFeature[] | string[] {
  if (options.feature) {
    const requested = options.feature;
    const ids = index.features.filter((feature) => feature.id === requested);
    return ids.length ? ids : index.features.filter((feature) => feature.aliases.includes(requested));
  }
  if (options.task) {
    const requested = options.task;
    return index.features.filter((feature) => feature.id === requested
      || feature.aliases.includes(requested)
      || feature.task_ids?.includes(requested)
      || feature.requirement_ids?.includes(requested)
      || feature.acceptance_criteria_ids?.includes(requested));
  }
  if (!options.symbol) return [];
  const qualified = options.symbol.includes('#');
  const matches = index.features.flatMap((feature) => feature.symbols
    .filter((symbol) => qualified ? `${symbol.file}#${symbol.name}` === options.symbol : symbol.name === options.symbol)
    .map((symbol) => ({ feature, symbol: `${symbol.file}#${symbol.name}` })));
  if (qualified) return [...new Set(matches.map((match) => match.feature))];
  return matches.map((match) => match.symbol);
}

function relationTargets(index: NavigationIndex, start: NavigationFeature, depth: number): string[] {
  const featureForSymbol = new Map<string, string>(index.features.flatMap((feature) => feature.symbols.map((symbol) => [`${symbol.file}#${symbol.name}`, feature.id] as const)));
  const outgoing = new Map<string, string[]>();
  for (const feature of index.features) for (const relation of feature.relations) {
    const from = featureForSymbol.get(relation.from);
    const to = featureForSymbol.get(relation.to);
    if (!from || !to || from === to) continue;
    outgoing.set(from, [...new Set([...(outgoing.get(from) ?? []), to])]);
  }
  const visited = new Set([start.id]);
  let frontier = [start.id];
  const result: string[] = [];
  for (let remaining = depth; remaining > 0 && frontier.length; remaining--) {
    const next = frontier.flatMap((feature) => outgoing.get(feature) ?? []).filter((feature) => !visited.has(feature));
    for (const feature of next) visited.add(feature);
    result.push(...next);
    frontier = next;
  }
  return result;
}

function hit(index: NavigationIndex, feature: NavigationFeature, depth: number): LocateHit {
  const readOrder = [...new Set([...feature.entries, ...feature.related_files, ...feature.tests])];
  return {
    status: 'hit', resolution_mode: 'index', feature: feature.id, entries: feature.entries,
    symbols: feature.symbols.map((symbol) => `${symbol.file}#${symbol.name}`), related_files: feature.related_files,
    tests: feature.tests, read_order: readOrder, related_features: relationTargets(index, feature, depth), fallback_required: false
  };
}

export async function locateContext(project: string, options: LocateOptions): Promise<LocateResult> {
  const root = resolveProjectRoot(project);
  const queries = [options.feature, options.symbol, options.task].filter(Boolean);
  if (queries.length !== 1) return { status: 'blocked', resolution_mode: 'index', reason: 'Specify exactly one of --feature, --symbol, or --task', fallback_required: false };
  const depth = options.depth ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 0) return { status: 'blocked', resolution_mode: 'index', reason: '--depth must be a non-negative integer', fallback_required: false };
  const loaded = await loadIndex(root, options);
  if (!('features' in loaded)) return loaded;
  const matches = candidatesFor(options, loaded);
  if (!matches.length) return fallback(options, 'miss', 'No indexed feature matches the requested target');
  let features: NavigationFeature[];
  if (options.symbol && !options.symbol.includes('#')) {
    const symbols = [...new Set(matches as string[])].sort();
    if (symbols.length > 1) return { status: 'ambiguous', resolution_mode: 'index', candidates: symbols, fallback_required: false };
    const [symbol] = symbols;
    const feature = loaded.features.find((candidate) => candidate.symbols.some((entry) => `${entry.file}#${entry.name}` === symbol));
    if (!feature) return fallback(options, 'miss', 'No indexed feature matches the requested target');
    features = [feature];
  } else {
    features = matches as NavigationFeature[];
  }
  if (features.length > 1) return { status: 'ambiguous', resolution_mode: 'index', candidates: features.map((feature) => feature.id).sort(), fallback_required: false };
  const feature = features[0];
  if (!feature) return fallback(options, 'miss', 'No indexed feature matches the requested target');
  if (options.verify) {
    const validation = await verifyNavigation(root, feature.id);
    if (!validation.valid) {
      const status = validation.errors.some((error) => error.startsWith('Navigation index is stale') || error.includes('expected an exact regular file')) ? 'stale' : 'invalid';
      const knownPaths = [...new Set([...feature.entries, ...feature.related_files, ...feature.tests])];
      return fallback(options, status, validation.errors[0] ?? 'Navigation index validation failed', knownPaths, feature.symbols.map((symbol) => `${symbol.file}#${symbol.name}`), [...new Set(knownPaths.map((path) => dirname(path)))]);
    }
  }
  return hit(loaded, feature, depth);
}
