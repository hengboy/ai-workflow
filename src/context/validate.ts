import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { atomicDirectory, exists } from '../utils/fs.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';
import { renderNavigation, type NavigationIndex, type NavigationModuleRoot } from './navigation.js';

export interface ContextValidation { valid: boolean; errors: string[] }

interface NavigationRefreshCandidate {
  version: 1;
  task_target: string;
  authorized_module_roots: string[];
  changed_paths: string[];
  maintenance_authorized: true;
  navigation: NavigationIndex;
}

function isExactPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.endsWith('/') && !path.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0) && !/[?*[\]{}$<>]/.test(path);
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${String.raw`/`}`) && !isAbsolute(path);
}

async function validateFile(project: string, realProject: string, path: string, errors: string[]): Promise<void> {
  if (!isExactPath(path)) { errors.push(`${path}: expected an exact regular file path`); return; }
  const target = resolve(project, path);
  if (!isWithin(project, target)) { errors.push(`${path}: path escapes project`); return; }
  try {
    if (!(await lstat(target)).isFile()) { errors.push(`${path}: expected an exact regular file`); return; }
    const real = await realpath(target);
    if (!isWithin(realProject, real)) errors.push(`${path}: symlink escapes project`);
  } catch {
    errors.push(`${path}: expected an exact regular file`);
  }
}

async function typeScriptFiles(project: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typeScriptFiles(project, path));
    else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) files.push(relative(project, path));
  }
  return files;
}

function rootFor(index: NavigationIndex, path: string): NavigationModuleRoot | undefined {
  return index.module_roots.filter((root) => path.startsWith(`${root.path}/`)).sort((left, right) => right.path.length - left.path.length)[0];
}

function declarations(source: ts.SourceFile): Map<string, Array<{ kind: string; exported: boolean }>> {
  const result = new Map<string, Array<{ kind: string; exported: boolean }>>();
  const add = (name: string | undefined, kind: string, exported: boolean): void => {
    if (!name) return;
    const values = result.get(name) ?? [];
    values.push({ kind, exported });
    result.set(name, values);
  };
  const exported = (node: ts.Node): boolean => ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  for (const statement of source.statements) {
    const visibility = exported(statement);
    if (ts.isFunctionDeclaration(statement)) add(statement.name?.text, 'function', visibility);
    else if (ts.isClassDeclaration(statement)) add(statement.name?.text, 'class', visibility);
    else if (ts.isInterfaceDeclaration(statement)) add(statement.name.text, 'interface', visibility);
    else if (ts.isEnumDeclaration(statement)) add(statement.name.text, 'enum', visibility);
    else if (ts.isTypeAliasDeclaration(statement)) add(statement.name.text, 'type', visibility);
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) add(declaration.name.text, 'variable', visibility);
  }
  return result;
}

function relationReference(value: string): { file: string; name: string } | undefined {
  const separator = value.lastIndexOf('#');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { file: value.slice(0, separator), name: value.slice(separator + 1) };
}

async function validateTypeScriptSymbol(project: string, file: string, name: string, kind: string | undefined, visibility: 'public' | 'private' | undefined, errors: string[]): Promise<void> {
  const source = ts.createSourceFile(file, await readFile(join(project, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const candidates = declarations(source).get(name) ?? [];
  const exists = candidates.some((candidate) => (!kind || candidate.kind === kind) && (visibility !== 'public' || candidate.exported));
  if (!exists) errors.push(`Navigation index is stale: ${file} no longer contains ${name}`);
}

async function validateSemantics(project: string, index: NavigationIndex, features: NavigationIndex['features'], errors: string[]): Promise<void> {
  const usedRoots = new Set(features.map((feature) => feature.module_root));
  for (const root of index.module_roots) if (usedRoots.has(root.id) && root.language !== 'typescript') errors.push(`Unsupported navigation language parser: ${root.language}`);
  if (errors.length) return;
  for (const feature of features) {
    for (const symbol of feature.symbols) {
      const root = rootFor(index, symbol.file);
      if (!root) { errors.push(`Navigation index is invalid: ${symbol.file} is outside a module root`); continue; }
      await validateTypeScriptSymbol(project, symbol.file, symbol.name, symbol.kind, symbol.visibility, errors);
    }
    for (const relation of feature.relations) for (const endpoint of [relation.from, relation.to]) {
      const reference = relationReference(endpoint);
      if (!reference) { errors.push(`Navigation index is invalid: relation endpoint ${endpoint}`); continue; }
      const root = rootFor(index, reference.file);
      if (!root) { errors.push(`Navigation index is invalid: ${reference.file} is outside a module root`); continue; }
      await validateTypeScriptSymbol(project, reference.file, reference.name, undefined, 'public', errors);
    }
  }
}

async function validateModuleCoverage(project: string, index: NavigationIndex, errors: string[]): Promise<void> {
  const registered = new Set(index.features.flatMap((feature) => [...feature.entries, ...feature.related_files, ...feature.symbols.map((symbol) => symbol.file)]));
  for (const moduleRoot of index.module_roots) {
    const path = join(project, moduleRoot.path);
    try {
      if (!(await lstat(path)).isDirectory()) { errors.push(`${moduleRoot.path}: expected a concrete module root directory`); continue; }
      const real = await realpath(path);
      if (!isWithin(await realpath(project), real)) { errors.push(`${moduleRoot.path}: module root symlink escapes project`); continue; }
      const hasFeature = index.features.some((feature) => feature.module_root === moduleRoot.id);
      if (!hasFeature) errors.push(`${moduleRoot.id}: module root has no feature`);
      for (const file of await typeScriptFiles(project, path)) {
        const owner = rootFor(index, file);
        if (owner?.id === moduleRoot.id && !registered.has(file)) errors.push(`Navigation index is stale: unclassified module file ${file}`);
      }
    } catch {
      errors.push(`${moduleRoot.path}: expected a concrete module root directory`);
    }
  }
}

function validateIndexRelationships(index: NavigationIndex, errors: string[]): void {
  const ids = new Set<string>();
  const aliases = new Set<string>();
  const entries = new Map<string, NavigationIndex['features']>();
  for (const feature of index.features) {
    if (ids.has(feature.id)) errors.push(`Duplicate feature id: ${feature.id}`);
    ids.add(feature.id);
    for (const alias of feature.aliases) {
      if (aliases.has(alias)) errors.push(`Duplicate feature alias: ${alias}`);
      aliases.add(alias);
    }
    for (const entry of feature.entries) entries.set(entry, [...(entries.get(entry) ?? []), feature]);
  }
  for (const feature of index.features) for (const dependency of feature.depends_on) if (!ids.has(dependency)) errors.push(`${feature.id} depends on unknown feature ${dependency}`);
  for (const [entry, features] of entries) {
    if (features.length < 2) continue;
    const symbols = features.flatMap((feature) => feature.symbols.filter((symbol) => symbol.file === entry).map((symbol) => symbol.name));
    if (!features.every((feature) => feature.shared_entry) || new Set(symbols).size !== symbols.length) errors.push(`${entry} is an illegal duplicate entry`);
  }
}

async function validateIndex(project: string, featureIds?: Set<string>, suppliedIndex?: NavigationIndex): Promise<{ errors: string[]; index?: NavigationIndex }> {
  const root = resolve(project); const realRoot = await realpath(root); const memoryPath = join(root, 'MEMORY.md'); const jsonPath = join(root, '.ai-workflow/index/navigation.json'); const markdownPath = join(root, '.ai-workflow/index/navigation.md'); const errors: string[] = [];
  if (await exists(memoryPath) && !/^#\s+/m.test(await readFile(memoryPath, 'utf8'))) errors.push('MEMORY.md needs a title');
  if (!suppliedIndex && !(await exists(jsonPath))) errors.push('Missing .ai-workflow/index/navigation.json');
  if (!suppliedIndex && !(await exists(markdownPath))) errors.push('Missing .ai-workflow/index/navigation.md');
  if (errors.length) return { errors };

  let index: NavigationIndex;
  if (suppliedIndex) index = suppliedIndex;
  else try { index = JSON.parse(await readFile(jsonPath, 'utf8')) as NavigationIndex; } catch { return { errors: ['navigation.json is not valid JSON'] }; }
  const validator = await schemaValidator('navigation.schema.json');
  if (!validator(index)) errors.push(formatSchemaErrors(validator.errors));
  const raw = index as unknown as { features?: Array<Record<string, unknown>> };
  for (const feature of raw.features ?? []) if ('write_scope' in feature) errors.push('Navigation features cannot declare write_scope');
  validateIndexRelationships(index, errors);
  if (errors.length) return { errors };

  const features = featureIds ? index.features.filter((feature) => featureIds.has(feature.id)) : index.features;
  if (featureIds) for (const featureId of featureIds) if (!features.some((feature) => feature.id === featureId)) errors.push(`Unknown navigation feature: ${featureId}`);
  if (errors.length) return { errors };
  for (const rootEntry of index.module_roots) {
    if (!isExactPath(rootEntry.path)) errors.push(`${rootEntry.path}: expected a concrete module root`);
  }
  for (const feature of features) if (!index.module_roots.some((rootEntry) => rootEntry.id === feature.module_root)) errors.push(`${feature.id}: unknown module root ${feature.module_root}`);
  for (const feature of features) {
    for (const path of [...feature.entries, ...feature.related_files, ...feature.tests, ...feature.read_scope, ...feature.symbols.map((symbol) => symbol.file)]) await validateFile(root, realRoot, path, errors);
    for (const path of [...feature.entries, ...feature.symbols.map((symbol) => symbol.file)]) if (rootFor(index, path)?.id !== feature.module_root) errors.push(`${feature.id}: ${path} is outside module root ${feature.module_root}`);
    const readOrder = new Set([...feature.entries, ...feature.related_files, ...feature.tests]);
    for (const path of readOrder) if (!feature.read_scope.includes(path)) errors.push(`${feature.id} read_scope must include ${path}`);
    for (const path of feature.read_scope) if (!readOrder.has(path)) errors.push(`${feature.id} read_scope has unneeded path ${path}`);
  }
  if (!errors.length) await validateSemantics(root, index, features, errors);
  if (!errors.length && !featureIds) await validateModuleCoverage(root, index, errors);
  return errors.length ? { errors } : { errors, index };
}

export async function validateContext(project: string): Promise<ContextValidation> {
  const result = await validateIndex(project);
  if (!result.index) return { valid: false, errors: result.errors };
  const markdown = await readFile(join(resolve(project), '.ai-workflow/index/navigation.md'), 'utf8');
  if (markdown !== renderNavigation(result.index)) result.errors.push('navigation.md does not match navigation.json');
  return { valid: result.errors.length === 0, errors: result.errors };
}

export async function verifyNavigation(project: string, featureId: string): Promise<ContextValidation> {
  const result = await validateIndex(project, new Set([featureId]));
  if (!result.index) return { valid: false, errors: result.errors };
  const markdown = await readFile(join(resolve(project), '.ai-workflow/index/navigation.md'), 'utf8');
  if (markdown !== renderNavigation(result.index)) result.errors.push('Navigation index is stale: navigation.md does not match navigation.json');
  return { valid: result.errors.length === 0, errors: result.errors };
}

function isConcreteDirectory(path: string): boolean {
  return isExactPath(path) && path !== '.';
}

function insideAuthorizedRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => path.startsWith(`${root}/`));
}

async function validateCandidate(project: string, candidatePath: string): Promise<{ candidate?: NavigationRefreshCandidate; errors: string[] }> {
  if (extname(candidatePath) !== '.json') return { errors: ['Navigation candidate must be a JSON file'] };
  let candidate: NavigationRefreshCandidate;
  try { candidate = JSON.parse(await readFile(resolve(candidatePath), 'utf8')) as NavigationRefreshCandidate; } catch { return { errors: ['Navigation candidate is not valid JSON'] }; }
  const validator = await schemaValidator('navigation.candidate.schema.json');
  if (!validator(candidate)) return { errors: [formatSchemaErrors(validator.errors)] };
  const root = resolve(project); const realRoot = await realpath(root); const errors: string[] = [];
  for (const moduleRoot of candidate.authorized_module_roots) {
    if (!isConcreteDirectory(moduleRoot)) { errors.push(`${moduleRoot}: expected a concrete authorized module root`); continue; }
    const target = resolve(root, moduleRoot);
    try {
      if (!(await lstat(target)).isDirectory() || !isWithin(realRoot, await realpath(target))) errors.push(`${moduleRoot}: expected a concrete authorized module root`);
    } catch { errors.push(`${moduleRoot}: expected a concrete authorized module root`); }
  }
  for (const path of candidate.changed_paths) {
    await validateFile(root, realRoot, path, errors);
    if (!insideAuthorizedRoots(path, candidate.authorized_module_roots)) errors.push(`${path}: outside authorized module roots`);
  }
  const navigation = await validateIndex(root, undefined, candidate.navigation);
  errors.push(...navigation.errors);
  const indexedPaths = new Set(candidate.navigation.features.flatMap((feature) => [...feature.entries, ...feature.related_files, ...feature.tests, ...feature.symbols.map((symbol) => symbol.file)]));
  for (const path of candidate.changed_paths) if (!indexedPaths.has(path)) errors.push(`${path}: changed path is not indexed`);
  return errors.length ? { errors } : { candidate, errors };
}

async function validateFormalIndexPath(path: string, name: string): Promise<void> {
  if (await exists(path) && !(await lstat(path)).isFile()) throw new Error(`${name} must be a regular file`);
}

export async function refreshContext(project: string, candidatePath: string): Promise<{ updated: string[] }> {
  const root = resolve(project);
  const validation = await validateCandidate(root, candidatePath);
  if (!validation.candidate) throw new Error(validation.errors.join('; '));
  const result = await validateIndex(root, undefined, validation.candidate.navigation);
  if (!result.index) throw new Error(result.errors.join('; '));
  const index = result.index;
  const indexDirectory = join(root, '.ai-workflow/index');
  await validateFormalIndexPath(join(indexDirectory, 'navigation.json'), 'navigation.json');
  await validateFormalIndexPath(join(indexDirectory, 'navigation.md'), 'navigation.md');
  const json = `${JSON.stringify(index, null, 2)}\n`;
  await atomicDirectory(indexDirectory, async (temporary) => {
    await writeFile(join(temporary, 'navigation.json'), json, { mode: 0o600 });
    await writeFile(join(temporary, 'navigation.md'), renderNavigation(index), { mode: 0o600 });
  });
  return { updated: ['.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'] };
}
