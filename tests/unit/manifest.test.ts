import { describe, expect, it } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectRawArtifacts } from '../../src/workflow/artifacts.js';
import { compileTaskCapabilities, type TaskCapabilityInput } from '../../src/workflow/manifest.js';
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

describe('task capability compiler', () => {
  it('compiles a writable code task into a closed action graph', () => {
    const task: TaskCapabilityInput = {
      id: 'task-001-example', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], dependsOn: [],
      surface: 'backend', feature: 'example', locatorReadOrder: ['src/input.ts'],
      readScope: ['MEMORY.md', 'src/input.ts'], newModuleDirectories: [],
      writeScope: ['src/output.ts'], testCommands: ['pnpm test'],
    };

    const compiled = compileTaskCapabilities([task]);
    const actionIds = compiled.actions.map((action) => action.action_id);

    expect(compiled.tasks).toEqual([expect.objectContaining({
      task_id: 'task-001-example', activation: 'required',
      required_actions: ['task-001-example-explore', 'task-001-example-implement', 'task-001-example-test'],
      optional_actions: ['task-001-example-repair'], finalization_action: 'task-001-example-finalize', finalization_mode: 'commit-and-merge',
    })]);
    expect(actionIds).toEqual([
      'task-001-example-explore', 'task-001-example-implement', 'task-001-example-test', 'task-001-example-repair', 'task-001-example-finalize',
    ]);
    expect(compiled.actions[1]).toMatchObject({
      role: 'backend', write_scope: ['src/output.ts'], allowed_commands: ['pnpm test'],
      test_commands: ['pnpm test'], output_schema: 'schemas/coding-agent-result.schema.json',
      requires_actions: ['task-001-example-explore'], max_attempts: 1, write_access: true, host_only: false,
    });
    expect(compiled.actions[3]).toMatchObject({ operation: 'repair', repair_for_action_id: 'task-001-example-test', optional: true });
    expect(compiled.actions[4]).toMatchObject({ role: 'git-operator', write_scope: [], host_only: true });
    expect(compiled.aggregate_repair.action_id).toBe('plan-aggregate-repair');
    expect(compiled.review_rechecks.map((item) => item.gate_id)).toEqual(['standards-review', 'spec-review']);
    expect(compiled.mandatory_gates.map((gate) => gate.gate_id)).toEqual([
      'task-closure', 'plan-validation', 'standards-review', 'spec-review', 'repair-closure', 'baseline-stable', 'integration',
    ]);
  });

  it('gives a read-only task only a read-only finalization mode', () => {
    const task: TaskCapabilityInput = {
      id: 'task-002-diagnose', requirements: [], acceptanceCriteria: ['AC-002'], dependsOn: [],
      surface: 'research', feature: 'diagnose', locatorReadOrder: ['src/input.ts'],
      readScope: ['MEMORY.md', 'src/input.ts'], newModuleDirectories: [], writeScope: [], testCommands: ['pnpm test'],
    };

    const compiled = compileTaskCapabilities([task]);

    expect(compiled.tasks[0]).toMatchObject({ finalization_mode: 'read-only-finalize' });
    expect(compiled.actions.filter((item) => item.task_id === task.id).every((item) => !item.write_access && item.write_scope.length === 0)).toBe(true);
  });

  it('records write scope conflicts without changing task declarations', () => {
    const task = (id: string, dependsOn: string[] = []): TaskCapabilityInput => ({
      id, requirements: [], acceptanceCriteria: [], dependsOn, surface: 'backend', feature: id,
      locatorReadOrder: ['src/input.ts'], readScope: ['MEMORY.md', 'src/input.ts'], newModuleDirectories: [],
      writeScope: ['src/shared.ts'], testCommands: ['pnpm test'],
    });

    const compiled = compileTaskCapabilities([task('task-001-first'), task('task-002-second')]);

    expect(compiled.tasks.map((item) => item.depends_on)).toEqual([[], []]);
    expect(compiled.scope_conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'write-write', left_action_id: 'task-001-first-implement', right_action_id: 'task-002-second-implement' }),
    ]));
  });

  it('rejects a cyclic task dependency graph', () => {
    const task = (id: string, dependsOn: string[]): TaskCapabilityInput => ({
      id, requirements: [], acceptanceCriteria: [], dependsOn, surface: 'backend', feature: id,
      locatorReadOrder: ['src/input.ts'], readScope: ['MEMORY.md', 'src/input.ts'], newModuleDirectories: [],
      writeScope: [`src/${id}.ts`], testCommands: ['pnpm test'],
    });

    expect(() => compileTaskCapabilities([task('task-001-first', ['task-002-second']), task('task-002-second', ['task-001-first'])]))
      .toThrow(/cycle/i);
  });
});
