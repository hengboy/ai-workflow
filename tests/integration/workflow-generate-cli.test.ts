import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { frozenPlan, temporary } from '../helpers.js';

const exec = promisify(execFile);

function workflowCli(project: string, arguments_: string[]): Promise<{ stdout: string }> {
  const root = process.cwd();
  return exec(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), ...arguments_], { cwd: project });
}

describe('workflow generate CLI', () => {
  it('writes the canonical workflow and produces a workflow accepted by validate', async () => {
    const project = await temporary('ai-workflow-generate-cli-');
    const plan = await frozenPlan(project);
    const canonical = join(plan, 'workflow.json');

    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);

    expect(JSON.parse(generated.stdout)).toMatchObject({ workflow: canonical });
    await expect(readFile(canonical, 'utf8')).resolves.toContain('"plan_id": "20260831-example"');
    await expect(workflowCli(project, ['workflow', 'validate', canonical, '--project', '.'])).resolves.toMatchObject({ stdout: expect.stringContaining('"valid": true') });
  });

  it('rejects custom output and never creates a candidate workflow', async () => {
    const project = await temporary('ai-workflow-generate-cli-');
    const plan = await frozenPlan(project);
    const candidate = join(plan, 'workflow.candidate.json');

    await expect(workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex', '--output', candidate])).rejects.toThrow(/unknown option '--output'/);
    await expect(readFile(candidate, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
