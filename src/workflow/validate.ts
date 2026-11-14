import { readPlan, readTasks } from './parse.js';
import { readExecutionOrder } from './order.js';
import { readWorkspaceManifest, validateWorkspaceManifest, validateWorkspaceRepositoryOrder } from './workspace.js';

export interface PlanValidationResult {
  valid: true;
  plan_id: string;
  digests: { spec: string; plan: string; combined: string };
  execution_order?: string[][];
  repos?: { name: string; path: string; depends_on: string[] }[];
}

/**
 * Validate a frozen plan directory, its task documents, its execution schedule and its
 * workspace declaration or manifest. The returned structure is the stable `plan validate`
 * report; invalid inputs throw with the same diagnostics as the CLI command.
 */
export async function validatePlanDirectory(directory: string): Promise<PlanValidationResult> {
  const document = await readPlan(directory);
  const tasks = await readTasks(directory);
  const digests = { spec: document.specDigest, plan: document.planDigest, combined: document.digest };
  const manifest = await readWorkspaceManifest(directory);
  if (!tasks.length) return { valid: true, plan_id: document.planId, digests };
  const schedule = await readExecutionOrder(directory, document.planId, tasks);
  if (manifest) {
    const errors = validateWorkspaceManifest(manifest, document, tasks, schedule);
    if (errors.length) throw new Error(errors.join('\n'));
  } else if (document.workspaceRepos) {
    const errors = validateWorkspaceRepositoryOrder(document.workspaceRepos.map((repository) => ({ name: repository.name, dependsOn: repository.depends_on })), tasks, schedule);
    if (errors.length) throw new Error(errors.join('\n'));
  }
  const output: PlanValidationResult = {
    valid: true,
    plan_id: document.planId,
    digests,
    execution_order: schedule.phases.map((phase) => phase.parallel),
  };
  if (manifest?.role === 'workspace') output.repos = manifest.repositories.map((repository) => ({ name: repository.name, path: repository.path, depends_on: repository.dependsOn }));
  return output;
}
