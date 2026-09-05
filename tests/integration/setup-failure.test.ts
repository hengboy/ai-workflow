import { describe, expect, it } from 'vitest';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { generateManifest } from '../../src/workflow/generate.js';
import { runV2Script } from '../../src/runtime/runner.js';
import { frozenPlan, gitInit, temporary } from '../helpers.js';

const exec = promisify(execFile);

async function approve(project: string, workflowPath: string): Promise<void> {
  const root = process.cwd();
  await exec(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), 'workflow', 'approve', workflowPath, '--project', project], { cwd: project });
}

async function missing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

describe('v2 setup failure cleanup', () => {
  it('closes the cancel socket, releases its lease, and records a plan setup failure', async () => {
    const project = await temporary('ai-workflow-v2-setup-failure-');
    const home = await temporary('ai-workflow-v2-setup-home-');
    const bin = await temporary('ai-workflow-v2-setup-host-');
    const host = join(bin, 'codex');
    await writeFile(host, '#!/bin/sh\nexit 99\n');
    await chmod(host, 0o755);
    await gitInit(project);
    const plan = await frozenPlan(project);
    const manifest = await generateManifest(plan, 'codex');
    const runId = 'run-plan-setup-failure';
    const runDirectory = join(project, '.ai-workflow/runs', runId);
    await approve(project, join(plan, 'workflow.json'));

    await mkdir(join(runDirectory, 'worktrees/tasks/task-001-example'), { recursive: true });

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      await expect(runV2Script({
        project,
        runId,
        manifest,
        script: await readFile(join(plan, 'workflow.js'), 'utf8'),
        args: {},
        scriptDigest: manifest.script.bytes_digest,
        argsDigest: manifest.args.bytes_digest,
      })).rejects.toThrow();
    } finally {
      process.env.HOME = previousHome;
      process.env.PATH = previousPath;
    }

    const authority = JSON.parse(await readFile(join(runDirectory, 'control/cancel-authority.json'), 'utf8')) as { socket_path: string };
    await missing(authority.socket_path);
    await missing(join(runDirectory, 'control/owner.json'));
    const state = JSON.parse(await readFile(join(runDirectory, 'state.json'), 'utf8')) as { run_state: string; stop_reason?: string; resources: Array<{ kind?: string }> };
    expect(state).toMatchObject({ run_state: 'paused', stop_reason: 'error' });
    expect(state.resources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'plan-worktree' })]));
    await expect(readFile(join(runDirectory, 'events.jsonl'), 'utf8')).resolves.toMatch(/run\/error/);
    await expect(readFile(join(runDirectory, 'events.jsonl'), 'utf8')).resolves.toMatch(/resource\/retained/);
    await expect(access(join(runDirectory, 'worktrees/plan'))).rejects.toThrow();
    await expect(access(join(runDirectory, 'worktrees/tasks/task-001-example'))).resolves.toBeUndefined();
    await expect(exec('git', ['worktree', 'list', '--porcelain'], { cwd: project })).resolves.not.toHaveProperty('stdout', expect.stringContaining(runId));
  });

  it('retains a run with durable evidence when owner acquisition is busy after socket startup', async () => {
    const project = await temporary('ai-workflow-v2-owner-failure-');
    await gitInit(project);
    const plan = await frozenPlan(project);
    await rm(join(plan, 'tasks'), { recursive: true, force: true });
    const manifest = await generateManifest(plan, 'codex');
    await approve(project, join(plan, 'workflow.json'));
    const runId = 'run-owner-setup-failure';
    const runDirectory = join(project, '.ai-workflow/runs', runId);
    const controlDirectory = join(runDirectory, 'control');
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(join(controlDirectory, 'owner.json'), JSON.stringify({ leaseVersion: '1.0.0', runId: 'other-run', owner: { osUid: process.getuid?.() ?? 0, identityDigest: 'other-owner' }, process: { pid: process.pid, pgid: process.pid, startIdentity: 'other', spawnNonce: 'other' }, fencingEpoch: 1, leaseExpiresAt: Date.now() + 60_000, socketPath: '/tmp/other.sock', status: 'active' }));

    await expect(runV2Script({ project, runId, manifest, script: await readFile(join(plan, 'workflow.js'), 'utf8'), args: {}, scriptDigest: manifest.script.bytes_digest, argsDigest: manifest.args.bytes_digest })).rejects.toThrow(/owner|lease/i);
    const authority = JSON.parse(await readFile(join(controlDirectory, 'cancel-authority.json'), 'utf8')) as { socket_path: string };
    await missing(authority.socket_path);
    await expect(readFile(join(runDirectory, 'events.jsonl'), 'utf8')).resolves.toMatch(/run\/error/);
    await expect(readFile(join(runDirectory, 'state.json'), 'utf8')).resolves.toMatch(/preflight|error/i);
  });

  it('closes setup resources and records a host authority failure from a fake host', async () => {
    const project = await temporary('ai-workflow-v2-authority-failure-');
    const home = await temporary('ai-workflow-v2-authority-home-');
    const bin = await temporary('ai-workflow-v2-authority-host-');
    await writeFile(join(bin, 'codex'), '#!/bin/sh\nif grep -q "Host authority"; then exit 99; fi\nprintf \'%s\\n\' \'{"result_version":"2.0.0","status":"done","summary":"ok","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}\'\n');
    await chmod(join(bin, 'codex'), 0o755);
    await gitInit(project);
    const plan = await frozenPlan(project);
    await writeFile(join(plan, 'workflow.js'), 'await finalizeTask("task-001-plan", "control/finalize");\n');
    await rm(join(plan, 'tasks'), { recursive: true, force: true });
    const manifest = await generateManifest(plan, 'codex');
    await approve(project, join(plan, 'workflow.json'));
    const runId = 'run-action-setup-failure';
    const runDirectory = join(project, '.ai-workflow/runs', runId);
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    let record: { run_state: string; stop_reason?: string };
    try {
      record = await runV2Script({ project, runId, manifest, script: await readFile(join(plan, 'workflow.js'), 'utf8'), args: {}, scriptDigest: manifest.script.bytes_digest, argsDigest: manifest.args.bytes_digest });
    } finally {
      process.env.HOME = previousHome;
      process.env.PATH = previousPath;
    }

    expect(record).toMatchObject({ run_state: 'paused', stop_reason: 'error' });
    const authority = JSON.parse(await readFile(join(runDirectory, 'control/cancel-authority.json'), 'utf8')) as { socket_path: string };
    await missing(authority.socket_path);
    await missing(join(runDirectory, 'control/owner.json'));
    await expect(readFile(join(runDirectory, 'events.jsonl'), 'utf8')).resolves.toMatch(/run\/error/);
    await expect(exec('git', ['worktree', 'list', '--porcelain'], { cwd: project })).resolves.not.toHaveProperty('stdout', expect.stringContaining(runId));
  });

  it('treats owner renewal loss as a setup failure instead of a user cancellation', async () => {
    const project = await temporary('ai-workflow-v2-renewal-failure-');
    const home = await temporary('ai-workflow-v2-renewal-home-');
    const bin = await temporary('ai-workflow-v2-renewal-host-');
    await writeFile(join(bin, 'codex'), '#!/bin/sh\nsleep 20\n');
    await chmod(join(bin, 'codex'), 0o755);
    await gitInit(project);
    const plan = await frozenPlan(project);
    await writeFile(join(plan, 'workflow.js'), 'await agent("hold", { actionId: "task-001-example-explore", callId: "call/renewal" });\n');
    const manifest = await generateManifest(plan, 'codex');
    await approve(project, join(plan, 'workflow.json'));
    const runId = 'run-renewal-failure';
    const runDirectory = join(project, '.ai-workflow/runs', runId);
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    const run = runV2Script({ project, runId, manifest, script: await readFile(join(plan, 'workflow.js'), 'utf8'), args: {}, scriptDigest: manifest.script.bytes_digest, argsDigest: manifest.args.bytes_digest });
    try {
      const ownerPath = join(runDirectory, 'control/owner.json');
      await waitFor(async () => { await access(ownerPath); return true; });
      const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<string, unknown>;
      await writeFile(ownerPath, JSON.stringify({ ...owner, fencingEpoch: 99 }));
      const record = await run;
      expect(record).toMatchObject({ run_state: 'paused', stop_reason: 'error' });
      await expect(readFile(join(runDirectory, 'events.jsonl'), 'utf8')).resolves.toMatch(/owner lease renewal failed|run\/error/);
      const authority = JSON.parse(await readFile(join(runDirectory, 'control/cancel-authority.json'), 'utf8')) as { socket_path: string };
      await missing(authority.socket_path);
    } finally {
      process.env.HOME = previousHome;
      process.env.PATH = previousPath;
    }
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch { /* setup state is not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for setup state');
}
