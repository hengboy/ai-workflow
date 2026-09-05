import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { frozenPlan, temporary } from '../helpers.js';

const exec = promisify(execFile);

function workflowCli(project: string, arguments_: string[]): Promise<{ stdout: string }> {
  const root = process.cwd();
  return exec(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), ...arguments_], { cwd: project });
}

describe('workflow generate CLI', () => {
  it('documents the canonical output in command help without an output option', async () => {
    const project = await temporary('ai-workflow-generate-cli-');

    const help = await workflowCli(project, ['workflow', 'generate', '--help']);

    expect(help.stdout).toContain('Generate canonical .ai-workflow/plans/<plan-id>/workflow.json');
    expect(help.stdout).not.toContain('--output');
  });

  it('writes the canonical workflow and produces a workflow accepted by validate', async () => {
    const project = await temporary('ai-workflow-generate-cli-');
    const plan = await frozenPlan(project);
    const canonical = join(plan, 'workflow.json');

    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);

    expect(JSON.parse(generated.stdout)).toMatchObject({ workflow: canonical });
    expect(JSON.parse(await readFile(canonical, 'utf8'))).toMatchObject({ plan_id: '20260831-example' });
    const validation = await workflowCli(project, ['workflow', 'validate', canonical, '--project', '.']);
    expect(validation.stdout).toContain('"valid": true');
  });

  it('rejects custom output and never creates a candidate workflow', async () => {
    const project = await temporary('ai-workflow-generate-cli-');
    const plan = await frozenPlan(project);
    const candidate = join(plan, 'workflow.candidate.json');

    await expect(workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex', '--output', candidate])).rejects.toThrow(/unknown option '--output'/);
    await expect(readFile(candidate, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a non-canonical plan directory without writing a workflow', async () => {
    const project = await temporary('ai-workflow-generate-cli-');
    const canonicalPlan = await frozenPlan(project);
    const nonCanonicalPlan = join(project, 'plans/20260831-example');
    await mkdir(nonCanonicalPlan, { recursive: true });
    const [spec, plan] = await Promise.all([readFile(join(canonicalPlan, 'spec.md'), 'utf8'), readFile(join(canonicalPlan, 'plan.md'), 'utf8')]);
    await Promise.all([writeFile(join(nonCanonicalPlan, 'spec.md'), spec), writeFile(join(nonCanonicalPlan, 'plan.md'), plan)]);

    await expect(workflowCli(project, ['workflow', 'generate', '--plan', nonCanonicalPlan, '--host', 'codex'])).rejects.toThrow(/canonical.*\.ai-workflow\/plans\/20260831-example/i);
    await expect(readFile(join(nonCanonicalPlan, 'workflow.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
