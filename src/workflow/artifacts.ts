import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { InputArtifact } from '../generated/coding-manifest.schema.js';
import { objectDigest, sha256 } from '../utils/hash.js';

export interface RawArtifactCollection {
  artifacts: InputArtifact[];
  inputArtifactsDigest: string;
}

export interface CollectRawArtifactsOptions {
  projectDirectory: string;
  planDirectory: string;
}

const artifactNames: Array<{ relativePath: string; kind: InputArtifact['kind']; required?: boolean }> = [
  { relativePath: 'spec.md', kind: 'spec', required: true },
  { relativePath: 'plan.md', kind: 'plan', required: true },
  { relativePath: '.ai-workflow/index/navigation.json', kind: 'navigation-json', required: true },
  { relativePath: '.ai-workflow/index/navigation.md', kind: 'navigation-markdown', required: true },
  { relativePath: 'workflow.js', kind: 'script' },
  { relativePath: 'workflow.meta.json', kind: 'meta' },
  { relativePath: 'workflow.args.json', kind: 'args' },
];

function projectRelative(project: string, candidate: string): string {
  const value = relative(project, candidate).split(sep).join('/');
  if (!value || value === '..' || value.startsWith('../')) throw new Error(`Path is external to project: ${candidate}`);
  return value;
}

async function assertRegularFile(path: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`Artifact must not be a symlink: ${path}`);
  if (!stats.isFile()) throw new Error(`Artifact must be a regular file: ${path}`);
  return true;
}

async function taskArtifacts(planDirectory: string, planPath: string): Promise<InputArtifact[]> {
  let entries;
  try {
    entries = await (await import('node:fs/promises')).readdir(resolve(planDirectory, 'tasks'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const artifacts: InputArtifact[] = [];
  for (const entry of entries.filter((item) => /^task-\d{3}-.+\.md$/.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(planDirectory, 'tasks', entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Artifact must be a regular file: ${path}`);
    const bytes = await readFile(path);
    artifacts.push({ path: projectRelative(planPath, path), kind: 'task', bytes_digest: sha256(bytes) });
  }
  return artifacts;
}

export async function collectRawArtifacts(options: CollectRawArtifactsOptions): Promise<RawArtifactCollection> {
  const projectDirectory = resolve(options.projectDirectory);
  const planDirectory = resolve(options.planDirectory);
  const projectRealPath = await realpath(projectDirectory);
  const planRealPath = await realpath(planDirectory);
  projectRelative(projectRealPath, planRealPath);

  const planRelative = projectRelative(projectRealPath, planRealPath);
  if (!/^\.ai-workflow\/plans\/[^/]+$/.test(planRelative)) throw new Error(`Plan directory must be canonical and project-relative: ${planRelative}`);

  const artifacts: InputArtifact[] = [];
  for (const definition of artifactNames) {
    const path = resolve(definition.relativePath.startsWith('.ai-workflow/') ? projectRealPath : planRealPath, definition.relativePath);
    const exists = await assertRegularFile(path);
    if (!exists) {
      if (definition.required) throw new Error(`Missing required artifact: ${path}`);
      continue;
    }
    artifacts.push({ path: projectRelative(projectRealPath, path), kind: definition.kind, bytes_digest: sha256(await readFile(path)) });
  }
  artifacts.push(...await taskArtifacts(planRealPath, projectRealPath));
  artifacts.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  return { artifacts, inputArtifactsDigest: objectDigest(artifacts) };
}
