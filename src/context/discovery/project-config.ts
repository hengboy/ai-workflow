import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { schemaValidator, formatSchemaErrors } from '../../utils/schema.js';
import { exists } from '../../utils/fs.js';
import { isExcludedDirectory, type DiscoveredFile } from './scanner.js';

export interface ProjectConfigModule {
  id: string;
  path: string;
  languages: string[];
  sourceRoots: string[];
  testRoots: string[];
}

export interface ProjectConfigFeature {
  id: string;
  name: string;
  moduleRoot: string;
  paths: string[];
}

export interface ProjectConfig {
  version: 1;
  modules: ProjectConfigModule[];
  features: ProjectConfigFeature[];
}

export interface ProjectConfigResult {
  config: ProjectConfig;
  present: boolean;
  errors: string[];
}

interface RawProjectConfigModule {
  id: string;
  path: string;
  languages: string[];
  source_roots: string[];
  test_roots: string[];
}

interface RawProjectConfigFeature {
  id: string;
  name: string;
  module_root: string;
  paths: string[];
}

interface RawProjectConfig {
  version: 1;
  modules?: RawProjectConfigModule[];
  features?: RawProjectConfigFeature[];
}

const CONFIG_RELATIVE_PATH = '.ai-workflow/project.yml';

function emptyConfig(): ProjectConfig {
  return { version: 1, modules: [], features: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
}

function escapesProject(root: string, absolute: string): boolean {
  const relativePath = relative(root, absolute);
  return relativePath.startsWith('..') || isAbsolute(relativePath);
}

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function hasExcludedSegment(path: string): boolean {
  return normalizeRelative(path).split('/').some((segment) => isExcludedDirectory(segment));
}

function isWithinModule(path: string, modulePath: string): boolean {
  const normalizedModule = normalizeRelative(modulePath);
  if (normalizedModule === '' || normalizedModule === '.') return true;
  const normalizedPath = normalizeRelative(path);
  return normalizedPath === normalizedModule || normalizedPath.startsWith(`${normalizedModule}/`);
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function findFileOwners(features: ProjectConfigFeature[], files: DiscoveredFile[]): string[] {
  const errors: string[] = [];
  const owners = new Map<string, string>();
  for (const feature of features) {
    for (const featurePath of feature.paths) {
      const prefix = `${normalizeRelative(featurePath)}/`;
      for (const file of files) {
        const owned = file.path === normalizeRelative(featurePath) || file.path.startsWith(prefix);
        if (!owned) continue;
        const existing = owners.get(file.path);
        if (existing === undefined) {
          owners.set(file.path, feature.id);
        } else if (existing !== feature.id) {
          errors.push(`duplicate feature file ownership: "${file.path}" is owned by features "${existing}" and "${feature.id}"`);
        }
      }
    }
  }
  return errors;
}

async function collectErrors(
  root: string,
  modules: ProjectConfigModule[],
  features: ProjectConfigFeature[],
  files: DiscoveredFile[] | undefined
): Promise<string[]> {
  const errors: string[] = [];

  const moduleIds = new Set<string>();
  for (const module of modules) {
    if (moduleIds.has(module.id)) errors.push(`duplicate module id "${module.id}"`);
    moduleIds.add(module.id);
  }

  const featureIds = new Set<string>();
  for (const feature of features) {
    if (featureIds.has(feature.id)) errors.push(`duplicate feature id "${feature.id}"`);
    featureIds.add(feature.id);
  }

  for (const module of modules) {
    if (isAbsolute(module.path) || hasParentSegment(module.path)) {
      errors.push(`module "${module.id}" path "${module.path}" must be project-relative and stay inside the project`);
      continue;
    }
    const moduleAbsolute = resolve(root, module.path);
    if (escapesProject(root, moduleAbsolute)) {
      errors.push(`module "${module.id}" path "${module.path}" must be project-relative and stay inside the project`);
      continue;
    }
    if (hasExcludedSegment(module.path)) {
      errors.push(`module "${module.id}" path "${module.path}" is inside an excluded directory`);
      continue;
    }
    if (!(await exists(moduleAbsolute))) {
      errors.push(`module "${module.id}" path "${module.path}" does not exist`);
    }

    for (const sourceRoot of module.sourceRoots) {
      if (isAbsolute(sourceRoot) || hasParentSegment(sourceRoot)) {
        errors.push(`module "${module.id}" source root "${sourceRoot}" must be relative to the module`);
        continue;
      }
      if (hasExcludedSegment(sourceRoot)) {
        errors.push(`module "${module.id}" source root "${sourceRoot}" is inside an excluded directory`);
        continue;
      }
      const absolute = join(moduleAbsolute, sourceRoot);
      if (!(await exists(absolute))) {
        errors.push(`module "${module.id}" source root "${normalizeRelative(join(module.path, sourceRoot))}" does not exist`);
      }
    }

    for (const testRoot of module.testRoots) {
      if (isAbsolute(testRoot) || hasParentSegment(testRoot)) {
        errors.push(`module "${module.id}" test root "${testRoot}" must be relative to the module`);
        continue;
      }
      if (hasExcludedSegment(testRoot)) {
        errors.push(`module "${module.id}" test root "${testRoot}" is inside an excluded directory`);
        continue;
      }
      const absolute = join(moduleAbsolute, testRoot);
      if (!(await exists(absolute))) {
        errors.push(`module "${module.id}" test root "${normalizeRelative(join(module.path, testRoot))}" does not exist`);
      }
    }
  }

  for (let leftIndex = 0; leftIndex < modules.length; leftIndex += 1) {
    const left = modules[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < modules.length; rightIndex += 1) {
      const right = modules[rightIndex];
      if (right === undefined) continue;
      if (overlaps(normalizeRelative(left.path), normalizeRelative(right.path))) {
        errors.push(
          `overlapping module boundaries: "${left.id}" (${left.path}) and "${right.id}" (${right.path})`
        );
      }
    }
  }

  for (const feature of features) {
    const ownerModule = modules.find((module) => module.id === feature.moduleRoot);
    if (!moduleIds.has(feature.moduleRoot)) {
      errors.push(`feature "${feature.id}" module_root "${feature.moduleRoot}" does not reference a declared module`);
    }
    for (const featurePath of feature.paths) {
      if (isAbsolute(featurePath) || hasParentSegment(featurePath)) {
        errors.push(`feature "${feature.id}" path "${featurePath}" must be project-relative and stay inside the project`);
        continue;
      }
      const absolute = resolve(root, featurePath);
      if (escapesProject(root, absolute)) {
        errors.push(`feature "${feature.id}" path "${featurePath}" must be project-relative and stay inside the project`);
        continue;
      }
      if (hasExcludedSegment(featurePath)) {
        errors.push(`feature "${feature.id}" path "${featurePath}" is inside an excluded directory`);
        continue;
      }
      if (ownerModule && !isWithinModule(featurePath, ownerModule.path)) {
        errors.push(
          `feature "${feature.id}" path "${featurePath}" is outside its module "${ownerModule.id}" (${ownerModule.path})`
        );
        continue;
      }
      if (!(await exists(absolute))) {
        errors.push(`feature "${feature.id}" path "${featurePath}" does not exist`);
      }
    }
  }

  if (files !== undefined) {
    errors.push(...findFileOwners(features, files));
  }

  return errors;
}

export async function loadProjectConfig(root: string, files?: DiscoveredFile[]): Promise<ProjectConfigResult> {
  let contents: string;
  try {
    contents = await readFile(join(root, CONFIG_RELATIVE_PATH), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { present: false, config: emptyConfig(), errors: [] };
    }
    return { present: true, config: emptyConfig(), errors: [`${CONFIG_RELATIVE_PATH} could not be read: ${errorMessage(error)}`] };
  }

  let parsed: unknown;
  try {
    parsed = parse(contents);
  } catch (error) {
    return { present: true, config: emptyConfig(), errors: [`${CONFIG_RELATIVE_PATH} is malformed YAML: ${errorMessage(error)}`] };
  }

  const validate = await schemaValidator('project.schema.json');
  if (!validate(parsed)) {
    return { present: true, config: emptyConfig(), errors: [`${CONFIG_RELATIVE_PATH} ${formatSchemaErrors(validate.errors)}`] };
  }

  const raw = parsed as RawProjectConfig;
  const modules: ProjectConfigModule[] = (raw.modules ?? []).map((module) => ({
    id: module.id,
    path: module.path,
    languages: [...module.languages],
    sourceRoots: [...module.source_roots],
    testRoots: [...module.test_roots]
  }));
  const features: ProjectConfigFeature[] = (raw.features ?? []).map((feature) => ({
    id: feature.id,
    name: feature.name,
    moduleRoot: feature.module_root,
    paths: [...feature.paths]
  }));

  const errors = await collectErrors(root, modules, features, files);
  return { present: true, config: { version: 1, modules, features }, errors };
}
