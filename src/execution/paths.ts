import { basename, join } from 'node:path';
import { exists } from '../utils/fs.js';

/** Every durable execution location derived from one plan directory. */
export interface ExecutionPaths {
  planId: string;
  planDirectory: string;
  directory: string;
  run: string;
  events: string;
  checkpoints: string;
  lock: string;
}

/** Derive the execution overlay paths from the plan directory that owns them. */
export function executionPaths(planDirectory: string): ExecutionPaths {
  const directory = join(planDirectory, 'execution');
  return {
    planId: basename(planDirectory),
    planDirectory,
    directory,
    run: join(directory, 'run.json'),
    events: join(directory, 'events.jsonl'),
    checkpoints: join(directory, 'checkpoints'),
    lock: join(directory, 'lock.json'),
  };
}

/** A plan directory is only valid when it holds both frozen planning documents. */
export async function isPlanDirectory(directory: string): Promise<boolean> {
  const [spec, plan] = await Promise.all([
    exists(join(directory, 'spec.md')),
    exists(join(directory, 'plan.md')),
  ]);
  return spec && plan;
}
