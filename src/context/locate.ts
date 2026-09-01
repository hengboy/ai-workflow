import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { exists } from '../utils/fs.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';
import { type NavigationFeature, type NavigationIndex } from './navigation.js';
import { verifyNavigation } from './validate.js';

export interface LocateOptions {
  feature?: string;
  symbol?: string;
  task?: string;
  verify?: boolean;
  depth?: number;
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

type LocateResult = LocateHit
  | { status: 'missing_index'; resolution_mode: 'index'; fallback_required: true }
  | { status: 'miss'; resolution_mode: 'index'; fallback_required: true }
  | { status: 'invalid'; resolution_mode: 'index'; reason: string; fallback_required: true }
  | { status: 'stale'; resolution_mode: 'index'; reason: string; fallback_required: true }
  | { status: 'ambiguous'; resolution_mode: 'index'; candidates: string[]; fallback_required: false }
  | { status: 'blocked'; resolution_mode: 'index'; reason: string; fallback_required: false };

async function loadIndex(project: string): Promise<NavigationIndex | LocateResult> {
  const root = resolve(project); const jsonPath = join(root, '.ai-workflow/index/navigation.json');
  if (!(await exists(jsonPath))) return { status: 'missing_index', resolution_mode: 'index', fallback_required: true };
  let index: NavigationIndex;
  try { index = JSON.parse(await readFile(jsonPath, 'utf8')) as NavigationIndex; } catch { return { status: 'invalid', resolution_mode: 'index', reason: 'navigation.json is not valid JSON', fallback_required: true }; }
  const validator = await schemaValidator('navigation.schema.json');
  if (!validator(index)) return { status: 'invalid', resolution_mode: 'index', reason: formatSchemaErrors(validator.errors), fallback_required: true };
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
  const queries = [options.feature, options.symbol, options.task].filter(Boolean);
  if (queries.length !== 1) return { status: 'blocked', resolution_mode: 'index', reason: 'Specify exactly one of --feature, --symbol, or --task', fallback_required: false };
  const depth = options.depth ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 0) return { status: 'blocked', resolution_mode: 'index', reason: '--depth must be a non-negative integer', fallback_required: false };
  const loaded = await loadIndex(project);
  if (!('features' in loaded)) return loaded;
  const matches = candidatesFor(options, loaded);
  if (!matches.length) return { status: 'miss', resolution_mode: 'index', fallback_required: true };
  let features: NavigationFeature[];
  if (options.symbol && !options.symbol.includes('#')) {
    const symbols = [...new Set(matches as string[])].sort();
    if (symbols.length > 1) return { status: 'ambiguous', resolution_mode: 'index', candidates: symbols, fallback_required: false };
    const [symbol] = symbols;
    const feature = loaded.features.find((candidate) => candidate.symbols.some((entry) => `${entry.file}#${entry.name}` === symbol));
    if (!feature) return { status: 'miss', resolution_mode: 'index', fallback_required: true };
    features = [feature];
  } else {
    features = matches as NavigationFeature[];
  }
  if (features.length > 1) return { status: 'ambiguous', resolution_mode: 'index', candidates: features.map((feature) => feature.id).sort(), fallback_required: false };
  const feature = features[0];
  if (!feature) return { status: 'miss', resolution_mode: 'index', fallback_required: true };
  if (options.verify) {
    const validation = await verifyNavigation(project, feature.id);
    if (!validation.valid) return {
      status: validation.errors.some((error) => error.startsWith('Navigation index is stale') || error.includes('expected an exact regular file')) ? 'stale' : 'invalid',
      resolution_mode: 'index', reason: validation.errors[0] ?? 'Navigation index validation failed', fallback_required: true
    };
  }
  return hit(loaded, feature, depth);
}
