import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { frozenPlan, gitInit, temporary } from '../helpers.js';

const exec = promisify(execFile);

async function workflowCli(project: string, arguments_: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const root = process.cwd();
  return exec(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), ...arguments_], { cwd: project, ...(env === undefined ? {} : { env: { ...process.env, ...env } }) });
}

describe('v2 CLI artifacts', () => {
  it('generates a v2 manifest from plan-local script and args files', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    const plan = await frozenPlan(project);
    const script = join(plan, 'custom-workflow.js');
    const args = join(plan, 'custom-args.json');
    await writeFile(script, 'await agent("explore", { actionId: "task-001-example-explore", callId: "call/explore" });\n');
    await writeFile(args, '{"mode":"test"}\n');

    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex', '--script', script, '--args', args]);
    const output = JSON.parse(generated.stdout) as { workflow: string; manifest: { schema_version: string; engine: string } };

    expect(output.manifest).toEqual({ schema_version: '2.0.0', engine: 'worker-thread-trusted' });
    expect(JSON.parse(await readFile(output.workflow, 'utf8'))).toMatchObject({ schema_version: '2.0.0', engine: 'worker-thread-trusted' });
    await expect(readFile(join(plan, 'workflow.js'), 'utf8')).resolves.toBe(await readFile(script, 'utf8'));
    await expect(readFile(join(plan, 'workflow.args.json'), 'utf8')).resolves.toBe(await readFile(args, 'utf8'));
  });

  it('validates, explains and approves a v2 manifest', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);
    const generatedOutput = JSON.parse(generated.stdout) as { workflow: string };
    const workflow = generatedOutput.workflow;

    const validation = await workflowCli(project, ['workflow', 'validate', workflow, '--project', project]);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
    const explanation = await workflowCli(project, ['workflow', 'explain', workflow]);
    expect(explanation.stdout).toContain('Engine: worker-thread-trusted');
    expect(explanation.stdout).toContain('Actions:');
    expect(explanation.stdout).toContain('Gates:');

    const approval = await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);
    expect(JSON.parse(approval.stdout)).toMatchObject({ receipt_version: '2.0.0', engine: 'worker-thread-trusted', plan_id: '20260831-example', host: 'codex' });
  });

  it('starts and controls a durable v2 run without accepting runtime artifact replacement', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);
    const generatedOutput = JSON.parse(generated.stdout) as { workflow: string };
    const workflow = generatedOutput.workflow;
    await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);

    const started = await workflowCli(project, ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project]);
    const record = JSON.parse(started.stdout) as { record_version: string; run_id: string; engine: string; run_state: string };
    expect(record).toMatchObject({ record_version: '2.0.0', engine: 'worker-thread-trusted', run_state: 'paused' });

    const status = await workflowCli(project, ['run', 'status', record.run_id, '--project', project]);
    expect(JSON.parse(status.stdout)).toMatchObject({ record_version: '2.0.0', run_id: record.run_id });
    const cancelled = await workflowCli(project, ['run', 'cancel', record.run_id, '--project', project]);
    expect(JSON.parse(cancelled.stdout)).toMatchObject({ run_state: 'cancelled', stop_reason: 'cancelled' });
    const cleanup = await workflowCli(project, ['run', 'cleanup', record.run_id, '--project', project]);
    expect(JSON.parse(cleanup.stdout)).toMatchObject({ cleaned: record.run_id });
  });

  it('executes the approved plan-local Worker script during run start', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    await writeFile(join(plan, 'workflow.js'), `phase('cli-started'); log('script-ran'); return { started: true };\n`);
    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);
    const workflow = (JSON.parse(generated.stdout) as { workflow: string }).workflow;
    await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);

    const started = await workflowCli(project, ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project]);
    const record = JSON.parse(started.stdout) as { run_id: string; run_state: string };
    expect(record.run_state).toBe('paused');
    await expect(readFile(join(project, '.ai-workflow/runs', record.run_id, 'events.jsonl'), 'utf8')).resolves.toMatch(/cli-started|script-ran/);
  });

  it('records an approved Worker action through the durable call ledger before pausing for lifecycle gates', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    const bin = await temporary('ai-workflow-host-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    await writeFile(join(plan, 'workflow.js'), 'await agent("explore", { actionId: "task-001-example-explore", callId: "call/explore" });\n');
    const host = join(bin, 'codex');
    await writeFile(host, '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"done","summary":"explored","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}\'\n');
    await chmod(host, 0o755);
    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);
    const workflow = (JSON.parse(generated.stdout) as { workflow: string }).workflow;
    await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);

    const started = await workflowCli(project, ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project], { PATH: `${bin}:${process.env.PATH ?? ''}` });
    const record = JSON.parse(started.stdout) as { run_id: string; run_state: string; call_ledger: Array<{ call_id: string; state: string }> };
    expect(record.run_state).toBe('paused');
    expect(record.call_ledger).toEqual(expect.arrayContaining([expect.objectContaining({ call_id: 'call/explore', state: 'checkpointed' })]));
  });

  it('does not checkpoint an action result that reports paths outside its approved scope', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    const bin = await temporary('ai-workflow-host-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    await writeFile(join(plan, 'workflow.js'), 'await agent("explore", { actionId: "task-001-example-explore", callId: "call/out-of-scope" });\n');
    const host = join(bin, 'codex');
    await writeFile(host, '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"done","summary":"invalid scope","changed_paths":["src/output.ts"],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}\'\n');
    await chmod(host, 0o755);
    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);
    const workflow = (JSON.parse(generated.stdout) as { workflow: string }).workflow;
    await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);

    const started = await workflowCli(project, ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project], { PATH: `${bin}:${process.env.PATH ?? ''}` });
    const record = JSON.parse(started.stdout) as { run_state: string; call_ledger: Array<{ call_id: string; state: string }> };
    expect(record.run_state).toBe('paused');
    expect(record.call_ledger).toEqual(expect.arrayContaining([expect.objectContaining({ call_id: 'call/out-of-scope', state: 'observed' })]));
    expect(record.call_ledger).not.toEqual(expect.arrayContaining([expect.objectContaining({ call_id: 'call/out-of-scope', state: 'checkpointed' })]));
  });

  it('runs an approved dynamic action inside its owned task worktree', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    const bin = await temporary('ai-workflow-host-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    await writeFile(join(plan, 'workflow.js'), 'await agent("explore", { actionId: "task-001-example-explore", callId: "call/explore-worktree" });\n');
    const host = join(bin, 'codex');
    await writeFile(host, '#!/bin/sh\nprintf \'%s\\n\' "{\\"status\\":\\"done\\",\\"summary\\":\\"$PWD\\",\\"changed_paths\\":[],\\"evidence\\":[],\\"tests\\":[],\\"findings\\":[],\\"git_refs\\":[],\\"support_requests\\":[]}"\n');
    await chmod(host, 0o755);
    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);
    const workflow = (JSON.parse(generated.stdout) as { workflow: string }).workflow;
    await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);

    const started = await workflowCli(project, ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project], { PATH: `${bin}:${process.env.PATH ?? ''}` });
    const record = JSON.parse(started.stdout) as { run_state: string; call_ledger: Array<{ call_id: string; state: string; result?: { summary?: string } }>; resources: Array<{ kind?: string; canonical_path?: string }> };
    expect(record.run_state).toBe('paused');
    expect(record.call_ledger).toEqual(expect.arrayContaining([expect.objectContaining({ call_id: 'call/explore-worktree', state: 'checkpointed' })]));
    expect(record.resources.some((resource) => resource.kind === 'task-worktree' && resource.canonical_path?.includes('worktrees/tasks/task-001-example'))).toBe(true);
    expect(record.call_ledger[0]?.result?.summary?.includes('worktrees/tasks/task-001-example')).toBe(true);
  });

  it('fails closed when an approved v2 artifact changes before start', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);
    const generatedOutput = JSON.parse(generated.stdout) as { workflow: string };
    const workflow = generatedOutput.workflow;
    await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);
    await writeFile(join(plan, 'workflow.args.json'), '{"changed":true}\n');

    await expect(workflowCli(project, ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project])).rejects.toThrow(/digest drift|approval/i);
  });

  it('initializes the v2 run path and installs all host coding guidance in an isolated home', async () => {
    const project = await temporary('ai-workflow-cli-v2-project-');
    const home = await temporary('ai-workflow-cli-v2-home-');
    await gitInit(project);

    await workflowCli(project, ['init', project]);
    const ignore = await readFile(join(project, '.gitignore'), 'utf8');
    expect(ignore).toContain('.ai-workflow/runs/*/worktrees/');
    expect(JSON.parse(await readFile(join(project, '.ai-workflow/project-manifest.json'), 'utf8'))).toMatchObject({ workflow_version: '2.0.0', worktree_root: '.ai-workflow/runs/<runId>/worktrees' });

    await workflowCli(project, ['install', '--host', 'all', '--home', home]);
    await expect(readFile(join(home, '.agents/skills/coding/SKILL.md'), 'utf8')).resolves.toContain('workflow.args.json');
    for (const path of [
      join(home, '.codex/agents/backend.toml'),
      join(home, '.claude/agents/backend.md'),
      join(home, '.config/opencode/agents/backend.md'),
    ]) await expect(readFile(path, 'utf8')).resolves.toContain('backend');
    expect(JSON.parse(await readFile(join(home, '.config/ai-workflow/install-manifest.json'), 'utf8'))).toMatchObject({ workflow_version: '2.0.0' });
  });
});
