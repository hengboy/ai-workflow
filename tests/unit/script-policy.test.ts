import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotWorkflowScript } from '../../src/workflow/script.js';
import { temporary } from '../helpers.js';

const actions = ['task-001-example-explore', 'task-001-example-implement', 'task-001-example-test', 'task-001-example-finalize'];

describe('workflow script policy', () => {
  it('creates a deterministic default script and canonical empty args snapshot', async () => {
    const project = await temporary('ai-workflow-script-');
    const plan = join(project, '.ai-workflow/plans/20260831-example');
    await mkdir(plan, { recursive: true });

    const first = await snapshotWorkflowScript({ projectDirectory: project, planDirectory: plan, planId: '20260831-example', actionIds: actions });
    const second = await snapshotWorkflowScript({ projectDirectory: project, planDirectory: plan, planId: '20260831-example', actionIds: actions });

    expect(first.script.bytes.equals(second.script.bytes)).toBe(true);
    expect(first.args.bytes.toString('utf8')).toBe('{}\n');
    expect(await readFile(join(plan, 'workflow.args.json'), 'utf8')).toBe('{}\n');
    expect(first.script.path).toBe('workflow.js');
    expect(first.script.bytes.toString('utf8')).toContain('agent(');
    expect(first.script.bytes.toString('utf8')).not.toContain('workflow.');
    expect(first.args.path).toBe('workflow.args.json');
  });

  it('snapshots plan-local meta and args using their raw bytes', async () => {
    const project = await temporary('ai-workflow-script-');
    const plan = join(project, '.ai-workflow/plans/20260831-example');
    await mkdir(plan, { recursive: true });
    const meta = '{\n  "description": "Example",\n  "name": "Example"\n}\n';
    const args = '{"z":1,"a":2}\n';
    await writeFile(join(plan, 'workflow.meta.json'), meta);
    await writeFile(join(plan, 'workflow.args.json'), args);

    const snapshot = await snapshotWorkflowScript({ projectDirectory: project, planDirectory: plan, planId: '20260831-example', actionIds: actions });

    expect(snapshot.meta).toEqual({ name: 'Example', description: 'Example' });
    expect(snapshot.args.bytes.toString('utf8')).toBe(args);
    expect(snapshot.args.bytes_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ['import', 'import fs from "node:fs";'],
    ['process', 'process.env.HOME;'],
    ['eval', 'eval("1");'],
    ['random', 'Math.random();'],
    ['date', 'new Date();'],
  ])('rejects %s in a plan-local custom script', async (_name, source) => {
    const project = await temporary('ai-workflow-script-');
    const plan = join(project, '.ai-workflow/plans/20260831-example');
    await mkdir(plan, { recursive: true });
    await writeFile(join(plan, 'workflow.js'), source);

    await expect(snapshotWorkflowScript({ projectDirectory: project, planDirectory: plan, planId: '20260831-example', actionIds: actions })).rejects.toThrow(/policy|forbidden|unsupported/i);
  });

  it('rejects unknown action IDs and duplicate pipeline item keys', async () => {
    const project = await temporary('ai-workflow-script-');
    const plan = join(project, '.ai-workflow/plans/20260831-example');
    await mkdir(plan, { recursive: true });
    await writeFile(join(plan, 'workflow.js'), `agent("unknown", { actionId: "unknown-action", callId: "call-1" });\npipeline(["a", "b"], { itemKeys: ["same", "same"] }, (value) => value);\n`);

    await expect(snapshotWorkflowScript({ projectDirectory: project, planDirectory: plan, planId: '20260831-example', actionIds: actions })).rejects.toThrow(/action|item key/i);
  });

  it.each([
    ['missing call ID', 'agent("prompt", { actionId: "task-001-example-test" });'],
    ['dynamic action ID', 'const id = "task-001-example-test"; agent("prompt", { actionId: id, callId: "call-1" });'],
    ['dynamic pipeline items', 'pipeline("items", { itemKeys: items }, (value) => value);'],
  ])('rejects %s', async (_name, source) => {
    const project = await temporary('ai-workflow-script-');
    const plan = join(project, '.ai-workflow/plans/20260831-example');
    await mkdir(plan, { recursive: true });
    await writeFile(join(plan, 'workflow.js'), source);

    await expect(snapshotWorkflowScript({ projectDirectory: project, planDirectory: plan, planId: '20260831-example', actionIds: actions })).rejects.toThrow(/script|identifier|literal|itemKeys|call ID/i);
  });
});
