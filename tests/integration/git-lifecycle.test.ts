import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createPlanWorktree, createTaskWorktree, commitTask, mergeTask, integratePlan, removeOwnedWorktrees } from '../../src/git/operator.js';
import { gitInit, temporary } from '../helpers.js';

describe('Git Operator lifecycle', () => {
  it('creates isolated worktrees, commits one task, merges DAG order and integrates non-fast-forward', async () => {
    const project = await temporary(); await gitInit(project); const runId = 'run-git'; const plan = await createPlanWorktree(project, runId, 'main'); const task = await createTaskWorktree(project, plan, runId, 'task-001-example');
    await writeFile(join(task.path, 'src.txt'), 'new\n'); const commit = await commitTask(task.path, 'task-001-example', ['src.txt']); expect(commit).toMatch(/^[0-9a-f]{40}$/); await mergeTask(plan.path, commit); expect(await readFile(join(plan.path, 'src.txt'), 'utf8')).toBe('new\n'); const integrated = await integratePlan(project, plan.branch, 'main'); expect(integrated).toMatch(/^[0-9a-f]{40}$/); expect(await readFile(join(project, 'src.txt'), 'utf8')).toBe('new\n'); await removeOwnedWorktrees(project, [task.path, plan.path]);
  });
  it('reports baseline drift and leaves worktrees for explicit cleanup', async () => {
    const project = await temporary(); await gitInit(project); const plan = await createPlanWorktree(project, 'run-drift', 'main'); await appendFile(join(project, 'README.md'), 'drift\n'); await expect(integratePlan(project, plan.branch, 'main', 'wrong-head')).rejects.toThrow(/drift/); await removeOwnedWorktrees(project, [plan.path]);
  });
});
