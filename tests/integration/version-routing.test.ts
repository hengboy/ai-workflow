import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitInit, temporary } from '../helpers.js';

const exec = promisify(execFile);

async function cli(project: string, arguments_: string[]): Promise<void> {
  const root = process.cwd();
  try {
    await exec(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), ...arguments_], { cwd: project });
  } catch (error) {
    const value = error as { message?: string; stderr?: string };
    throw new Error(`${value.message ?? String(error)}\n${value.stderr ?? ''}`);
  }
}

describe('v2-only CLI routing', () => {
  it('rejects every workflow command for a v1 artifact', async () => {
    const project = await temporary('ai-workflow-routing-');
    await gitInit(project);
    const workflow = join(project, 'workflow-v1.json');
    await writeFile(workflow, JSON.stringify({ schema_version: '1.0.0', plan_id: 'legacy', host: 'codex' }));

    for (const command of [
      ['workflow', 'validate', workflow, '--project', project],
      ['workflow', 'explain', workflow],
      ['workflow', 'approve', workflow, '--project', project],
      ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project],
    ]) {
      await expect(cli(project, command)).rejects.toThrow(/WORKFLOW_VERSION_UNSUPPORTED|Only v2 manifests are supported/);
    }
  });

  it('rejects every run command for a v1 state record without changing it', async () => {
    const project = await temporary('ai-workflow-routing-');
    await gitInit(project);
    const directory = join(project, '.ai-workflow', 'runs', 'legacy-run');
    await mkdir(directory, { recursive: true });
    const state = { record_version: '1.0.0', run_id: 'legacy-run', project, workflow_path: join(project, 'workflow.json'), workflow_digest: 'sha256:' + 'a'.repeat(64), plan_id: 'legacy', host: 'codex', state: 'paused', started_at: '2026-09-03T00:00:00.000Z', updated_at: '2026-09-03T00:00:00.000Z', cancelled: false, resources: { start_branch: 'main', start_head: 'a'.repeat(40), task_worktrees: {}, task_branches: {}, commits: {} }, nodes: {}, events: [] };
    const path = join(directory, 'state.json');
    await writeFile(path, JSON.stringify(state));

    for (const command of ['status', 'resume', 'cancel', 'cleanup']) {
      await expect(cli(project, ['run', command, 'legacy-run', '--project', project])).rejects.toThrow(/RUN_VERSION_UNSUPPORTED|v2 runs only/);
    }
    await expect(writeFile(path, JSON.stringify(state))).resolves.toBeUndefined();
  });
});
