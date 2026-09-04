import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { frozenPlan, gitInit, temporary } from '../helpers.js';

const exec = promisify(execFile);

function parseJson(value: string): unknown { return JSON.parse(value) as unknown; }

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
    const resumed = await workflowCli(project, ['run', 'resume', record.run_id, '--project', project]);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ run_state: 'paused', pause_reason: 'approved Worker restart authority is unavailable' });
    const pausedStatusValue = parseJson((await workflowCli(project, ['run', 'status', record.run_id, '--project', project])).stdout);
    if (!pausedStatusValue || typeof pausedStatusValue !== 'object' || !('resume_evidence' in pausedStatusValue) || !pausedStatusValue.resume_evidence || typeof pausedStatusValue.resume_evidence !== 'object') throw new Error('paused status is missing resume evidence');
    const evidence = pausedStatusValue.resume_evidence as Record<string, unknown>;
    for (const field of ['manifest_digest', 'script_digest', 'args_digest', 'approval_digest', 'profile_digest', 'sandbox_digest', 'baseline_digest']) expect(evidence[field]).toMatch(/^sha256:/);
    expect((await workflowCli(project, ['run', 'cancel', record.run_id, '--project', project])).stdout).toContain('"run_state": "cancelled"');
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

  it('persists a host-authority blocked reason when CLI start cannot complete lifecycle gates', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    await writeFile(join(plan, 'workflow.js'), "phase('cli-authority'); return { started: true };");
    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);
    const workflow = (JSON.parse(generated.stdout) as { workflow: string }).workflow;
    await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);

    const started = await workflowCli(project, ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project]);
    const record = JSON.parse(started.stdout) as { run_id: string; run_state: string; stop_reason?: string };
    expect(record).toMatchObject({ run_state: 'paused', stop_reason: 'blocked' });
    await expect(readFile(join(project, '.ai-workflow/runs', record.run_id, 'events.jsonl'), 'utf8')).resolves.toMatch(/approved script did not close every required task before host authority review/);
  });

  it('completes manifest-scoped plan, review, repair, test and targeted recheck authority through a temporary host', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    const bin = await temporary('ai-workflow-authority-host-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    await writeFile(join(project, 'src/output.ts'), 'baseline\n');
    await exec('git', ['add', 'MEMORY.md', 'src/input.ts', 'src/output.ts'], { cwd: project });
    await exec('git', ['commit', '-m', 'fixture source'], { cwd: project });
    await writeFile(join(plan, 'workflow.js'), 'await skipTask("task-001-example", "authority fixture", "control/skip");\n');
    const host = join(bin, 'codex');
    await writeFile(host, `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const input = readFileSync(0, 'utf8');
const packet = JSON.parse(input.split('PACKET:\\n')[1].split('\\n\\nRespond')[0]);
const result = (value = {}, changed_paths = [], tests = []) => process.stdout.write(JSON.stringify({ result_version: '2.0.0', status: 'done', summary: 'fake authority', changed_paths, evidence: [], tests, findings: [], git_refs: [], support_requests: [], value }));
const digest = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex');
if (packet.objective.includes('Host authority plan validation')) result({ result_version: '2.0.0', result_type: 'plan-validation', valid: true, errors: [] });
else if (packet.objective.includes('Host authority review standards-review')) result({ result_version: '2.0.0', result_type: 'review', gate_id: 'standards-review', findings: [{ severity: 'error', message: 'repair src output', path: 'src/output.ts', applicable_action_ids: ['task-001-example-implement'] }] });
else if (packet.objective.includes('Host authority review spec-review')) result({ result_version: '2.0.0', result_type: 'review', gate_id: 'spec-review', findings: [] });
else if (packet.objective.includes('Host authority aggregate repair')) { writeFileSync('src/output.ts', 'repaired\\n'); result({ result_version: '2.0.0', result_type: 'aggregate-repair', changed_paths: ['src/output.ts'] }, ['src/output.ts']); }
else if (packet.objective.includes('Host authority repair test')) result({ result_version: '2.0.0', result_type: 'repair-test', task_id: 'task-001-example', tests: [{ command: 'pnpm test', status: 'passed' }] }, [], [{ command: 'pnpm test', status: 'passed' }]);
else if (packet.objective.includes('Host authority finding recheck')) { const [source, repair] = packet.evidence; const finding = /finding-sha256:[a-f0-9]{64}/.exec(packet.objective)[0]; const evidence = readFileSync('src/output.ts'); result({ result_version: '2.0.0', result_type: 'finding-recheck', finding_id: finding, status: 'closed', evidence_paths: ['src/output.ts'], evidence_digests: [digest(evidence)], repair_diff_digest: repair, source_review_receipt_digest: source, message: 'recheck complete' }); }
else if (packet.write_paths.length) { writeFileSync('src/output.ts', 'implemented\\n'); result({}, ['src/output.ts']); }
else if (packet.role === 'test') result({}, [], [{ command: 'pnpm test', status: 'passed' }]);
else result();
`);
    await chmod(host, 0o755);
    const workflow = (JSON.parse((await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex'])).stdout) as { workflow: string }).workflow;
    const manifest = JSON.parse(await readFile(workflow, 'utf8')) as { tasks: Array<{ activation: string }> };
    manifest.tasks[0]!.activation = 'conditional';
    await writeFile(workflow, `${JSON.stringify(manifest, null, 2)}\n`);
    await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);

    const started = await workflowCli(project, ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project], { PATH: `${bin}:${process.env.PATH ?? ''}` });
    const record = JSON.parse(started.stdout) as { run_id: string; run_state: string };

    const events = await readFile(join(project, '.ai-workflow/runs', record.run_id, 'events.jsonl'), 'utf8');
    expect(record.run_state, events).toBe('complete');
    const authorityDirectory = join(project, '.ai-workflow/runs', record.run_id, 'receipts', 'authority');
    const recheck = (await readdir(authorityDirectory)).find((entry) => entry.startsWith('finding-recheck-'));
    if (!recheck) throw new Error('fake host did not produce a targeted recheck receipt');
    const receipt = parseJson(await readFile(join(authorityDirectory, recheck), 'utf8')) as { finding_id: string; source_review_receipt_digest: string; repair_diff_digest: string; evidence_digests: string[]; message: string };
    const review = parseJson(await readFile(join(authorityDirectory, 'standards-review.json'), 'utf8')) as { receipt_digest: string; findings: Array<{ finding_id: string; message_digest: string }> };
    expect(receipt.finding_id).toMatch(/^finding-sha256:/);
    expect(receipt.source_review_receipt_digest).toBe(review.receipt_digest);
    expect(receipt.repair_diff_digest).toMatch(/^sha256:/);
    expect(receipt.evidence_digests).toEqual([expect.stringMatching(/^sha256:/)]);
    expect(receipt.message).toBe('recheck complete');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]?.finding_id).toBe(receipt.finding_id);
    expect(review.findings[0]?.message_digest).toMatch(/^sha256:/);
    await expect(readFile(join(project, 'src/output.ts'), 'utf8')).resolves.toBe('repaired\n');
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

  it('acquires the v2 owner lease before CLI dynamic actions execute', async () => {
    const project = await temporary('ai-workflow-cli-v2-');
    const bin = await temporary('ai-workflow-host-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    await writeFile(join(plan, 'workflow.js'), 'await agent("explore", { actionId: "task-001-example-explore", callId: "call/owner-lease" });\n');
    const host = join(bin, 'codex');
    await writeFile(host, '#!/bin/sh\nif test -f "$PWD/../../../control/owner.json"; then summary=active; else summary=missing; fi\nprintf \'%s\\n\' "{\\"result_version\\":\\"2.0.0\\",\\"status\\":\\"done\\",\\"summary\\":\\"$summary\\",\\"changed_paths\\":[],\\"evidence\\":[],\\"tests\\":[],\\"findings\\":[],\\"git_refs\\":[],\\"support_requests\\":[]}"\n');
    await chmod(host, 0o755);
    const generated = await workflowCli(project, ['workflow', 'generate', '--plan', plan, '--host', 'codex']);
    const workflow = (JSON.parse(generated.stdout) as { workflow: string }).workflow;
    await workflowCli(project, ['workflow', 'approve', workflow, '--project', project]);

    const started = await workflowCli(project, ['run', 'start', '--workflow', workflow, '--host', 'codex', '--project', project], { PATH: `${bin}:${process.env.PATH ?? ''}` });
    const record = JSON.parse(started.stdout) as { run_state: string; call_ledger: Array<{ call_id: string; result?: { summary?: string } }> };
    expect(record.run_state).toBe('paused');
    expect(record.call_ledger.find((entry) => entry.call_id === 'call/owner-lease')?.result?.summary).toBe('active');
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
