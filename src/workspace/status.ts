import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { classifySlice, computeSliceFiles, resolveWorkspacePlan, type ResolvedWorkspacePlan, type SliceFileState } from './distribute.js';

const RESERVED_ROOT = 'workspace';

export type ImplementationRecordState = 'missing' | 'in-progress' | 'completed';
export type SlicePresence = 'missing' | 'divergent' | 'present';

export interface StatusRepository {
  name: string;
  path: string;
  slice: SlicePresence;
  record: ImplementationRecordState;
  delivery_commit: string | null;
}

export interface StatusWorkspaceRootEntry {
  name: string;
  path: string;
  record: ImplementationRecordState;
}

export interface StatusResult {
  valid: boolean;
  plan_id?: string;
  workspace_root?: string;
  order?: string[];
  repositories?: StatusRepository[];
  workspace_root_entry?: StatusWorkspaceRootEntry;
  next_repository?: string | null;
  ready_for_finalization?: boolean;
  errors?: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read `<directory>/implementation.yaml`; a missing or malformed file reports `missing`. */
async function readRecordState(directory: string): Promise<{ state: ImplementationRecordState; commit: string | null }> {
  let source: string;
  try {
    source = await readFile(join(directory, 'implementation.yaml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', commit: null };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    return { state: 'missing', commit: null };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'missing', commit: null };
  const record = parsed as Record<string, unknown>;
  if (record.status === 'completed') return { state: 'completed', commit: typeof record.commit === 'string' ? record.commit : null };
  if (record.status === 'in-progress') return { state: 'in-progress', commit: null };
  return { state: 'missing', commit: null };
}

function slicePresence(states: Map<string, SliceFileState>): SlicePresence {
  let anyPresent = false;
  let allIdentical = true;
  for (const state of states.values()) {
    if (state !== 'missing') anyPresent = true;
    if (state !== 'identical') allIdentical = false;
  }
  if (!anyPresent) return 'missing';
  return allIdentical ? 'present' : 'divergent';
}

export async function workspaceStatus(planDirectory: string): Promise<StatusResult> {
  let resolved: ResolvedWorkspacePlan;
  try {
    resolved = await resolveWorkspacePlan(planDirectory);
  } catch (error) {
    return { valid: false, errors: [errorMessage(error)] };
  }

  const { root, plan, manifest } = resolved;
  if (manifest === undefined || manifest.role !== 'workspace') {
    return { valid: false, plan_id: plan.planId, errors: ['workspace status requires a workspace manifest (role "workspace")'] };
  }

  const order = manifest.repositories.map((repository) => repository.name);
  const repositories: StatusRepository[] = [];
  for (const repository of manifest.repositories) {
    if (repository.name === RESERVED_ROOT) continue;
    const sliceDirectory = join(root, repository.path, '.ai-workflow', 'plans', plan.planId);
    const expected = await computeSliceFiles(resolved, repository);
    const states = await classifySlice(sliceDirectory, expected);
    const record = await readRecordState(sliceDirectory);
    repositories.push({
      name: repository.name,
      path: repository.path,
      slice: slicePresence(states),
      record: record.state,
      delivery_commit: record.commit,
    });
  }

  const workspaceEntry = manifest.repositories.find((repository) => repository.name === RESERVED_ROOT);
  const workspaceRecord = await readRecordState(join(root, '.ai-workflow', 'plans', plan.planId));
  const nextRepository = repositories.find((repository) => repository.record !== 'completed')?.name ?? null;
  return {
    valid: true,
    plan_id: plan.planId,
    workspace_root: root,
    order,
    repositories,
    workspace_root_entry: {
      name: workspaceEntry?.name ?? RESERVED_ROOT,
      path: workspaceEntry?.path ?? '.',
      record: workspaceRecord.state,
    },
    next_repository: nextRepository,
    ready_for_finalization: repositories.every((repository) => repository.record === 'completed'),
  };
}
