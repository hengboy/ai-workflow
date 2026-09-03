import { describe, expect, it } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectRawArtifacts } from '../../src/workflow/artifacts.js';
import { frozenPlan, temporary } from '../helpers.js';

describe('raw workflow artifacts', () => {
  it('collects every existing raw input in deterministic path order', async () => {
    const project = await temporary('ai-workflow-artifacts-');
    const plan = await frozenPlan(project);
    await mkdir(join(plan, 'tasks'), { recursive: true });
    await writeFile(join(plan, 'workflow.js'), 'export default []\n');
    await writeFile(join(plan, 'workflow.meta.json'), '{"name":"Example","description":"Example"}\n');
    await writeFile(join(plan, 'workflow.args.json'), '{"z":1,"a":2}\n');

    const result = await collectRawArtifacts({ projectDirectory: project, planDirectory: plan });

    expect(result.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`)).toEqual([
      'navigation-json:.ai-workflow/index/navigation.json',
      'navigation-markdown:.ai-workflow/index/navigation.md',
      'plan:.ai-workflow/plans/20260831-example/plan.md',
      'spec:.ai-workflow/plans/20260831-example/spec.md',
      'task:.ai-workflow/plans/20260831-example/tasks/task-001-example.md',
      'args:.ai-workflow/plans/20260831-example/workflow.args.json',
      'script:.ai-workflow/plans/20260831-example/workflow.js',
      'meta:.ai-workflow/plans/20260831-example/workflow.meta.json',
    ]);
    expect(result.inputArtifactsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.artifacts.every((artifact) => artifact.bytes_digest.startsWith('sha256:'))).toBe(true);
  });

  it('changes the raw digest when only a task comment or newline changes', async () => {
    const project = await temporary('ai-workflow-artifacts-');
    const plan = await frozenPlan(project);
    const first = await collectRawArtifacts({ projectDirectory: project, planDirectory: plan });

    const planPath = join(plan, 'plan.md');
    await writeFile(planPath, `${await readFile(planPath, 'utf8')}\n# comment\n`);
    const second = await collectRawArtifacts({ projectDirectory: project, planDirectory: plan });

    expect(second.inputArtifactsDigest).not.toBe(first.inputArtifactsDigest);
    expect(second.artifacts.find((artifact) => artifact.kind === 'plan')?.bytes_digest)
      .not.toBe(first.artifacts.find((artifact) => artifact.kind === 'plan')?.bytes_digest);
  });

  it('rejects a symlinked input artifact', async () => {
    const project = await temporary('ai-workflow-artifacts-');
    const plan = await frozenPlan(project);
    const target = join(project, 'outside.md');
    await writeFile(target, 'outside\n');
    await symlink(target, join(plan, 'workflow.meta.json'));

    await expect(collectRawArtifacts({ projectDirectory: project, planDirectory: plan })).rejects.toThrow(/symlink|regular file/i);
  });

  it('rejects a plan directory outside the project root', async () => {
    const project = await temporary('ai-workflow-artifacts-');
    const outside = await temporary('ai-workflow-outside-');
    await expect(collectRawArtifacts({ projectDirectory: project, planDirectory: outside })).rejects.toThrow(/project-relative|outside|external/i);
  });
});
