import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeJson } from '../../src/utils/fs.js';
import { generateWorkflow } from '../../src/workflow/generate.js';
import { approveWorkflow } from '../../src/workflow/approval.js';
import { cancelRun, cleanupRun, resumeRun, startRun } from '../../src/runtime/runner.js';
import { exists } from '../../src/utils/fs.js';
import { frozenPlan, gitInit, temporary } from '../helpers.js';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { renderNavigation, type NavigationIndex } from '../../src/context/navigation.js';
const done = { status: 'done' as const, summary: 'ok', changed_paths: [] as string[], evidence: [] as string[], tests: [], findings: [], git_refs: [], support_requests: [] as string[] };

describe('runtime lifecycle', () => {
  it('injects the verified more-tools locator and its exact read order into File Explorer', async () => {
    const root = await temporary();
    const capture = join(root, 'file-explorer-packet.json');
    const bin = await temporary('ai-workflow-host-');
    const plan = await frozenPlan(root);
    const readOrder = ['src/App.tsx', 'src/components/MoreToolsHub.tsx', 'src/components/Launcher.tsx', 'src/lib/navigation.ts', 'src/lib/launcherToolVisibility.ts', 'src/lib/moreToolPresentation.ts', 'src/App.moreToolsNavigation.test.tsx', 'src/components/MoreToolsHub.test.tsx', 'src/components/Launcher.test.tsx', 'src/lib/navigation.test.ts', 'src/lib/launcherToolVisibility.test.ts'];
    const navigation: NavigationIndex = {
      version: 1,
      module_roots: [{ id: 'app', path: 'src', owner_role: 'frontend', responsibility: 'application', language: 'typescript', entry_kinds: ['component'] }],
      features: [{ id: 'more-tools', name: 'More Tools', aliases: [], module_root: 'app', entries: readOrder.slice(0, 3), symbols: [], related_files: readOrder.slice(3, 6), tests: readOrder.slice(6), depends_on: [], relations: [], owner_role: 'frontend', responsibility: 'tool navigation', read_scope: readOrder, shared_entry: false }]
    };
    await gitInit(root);
    await mkdir(join(root, 'src/components'), { recursive: true });
    await mkdir(join(root, 'src/lib'), { recursive: true });
    for (const path of readOrder) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), 'export {};\n'); }
    await writeFile(join(root, '.ai-workflow/index/navigation.json'), `${JSON.stringify(navigation)}\n`);
    await writeFile(join(root, '.ai-workflow/index/navigation.md'), renderNavigation(navigation));
    await writeFile(join(plan, 'tasks/task-001-example.md'), renderMarkdown({ id: 'task-001-example', requirements: ['REQ-001'], acceptance_criteria: ['AC-001'], depends_on: [], surface: 'backend', feature: 'more-tools', locator_read_order: readOrder, read_scope: ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md', ...readOrder], write_scope: ['src/output.ts'], test_commands: ['pnpm test'] }, '# Task'));
    const host = join(bin, 'opencode');
    const result = JSON.stringify({ status: 'done', summary: 'ok', changed_paths: readOrder, evidence: [], tests: [], findings: [], git_refs: [], support_requests: [] });
    const explorerResult = result.replace(`"changed_paths":${JSON.stringify(readOrder)}`, `"changed_paths":${JSON.stringify(readOrder)}`);
    const ordinaryResult = JSON.stringify({ status: 'done', summary: 'ok', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [] });
    await writeFile(host, `#!/bin/sh\nif [ "$3" = "file-explorer" ]; then printf '%s' "$7" > "$AI_WORKFLOW_CAPTURE"; printf '%s\\n' '{"type":"text","part":{"text":"${explorerResult.replaceAll('"', '\\"')}"}}'; else printf '%s\\n' '{"type":"text","part":{"text":"${ordinaryResult.replaceAll('"', '\\"')}"}}'; fi\n`);
    await chmod(host, 0o755);
    const previousPath = process.env.PATH;
    const previousCapture = process.env.AI_WORKFLOW_CAPTURE;
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.AI_WORKFLOW_CAPTURE = capture;
    try {
      const workflow = await generateWorkflow(plan, 'opencode');
      const path = join(plan, 'workflow.json');
      await writeJson(path, workflow);
      await approveWorkflow(path, root);
      await expect(startRun({ workflowPath: path, host: 'opencode', project: root })).resolves.toMatchObject({ state: 'complete' });
    } finally {
      process.env.PATH = previousPath;
      if (previousCapture === undefined) delete process.env.AI_WORKFLOW_CAPTURE;
      else process.env.AI_WORKFLOW_CAPTURE = previousCapture;
    }

    const message = await readFile(capture, 'utf8');
    const packet = JSON.parse(message.slice(message.indexOf('PACKET:\n') + 'PACKET:\n'.length, message.indexOf('\n\nRespond with exactly'))) as { role: string; feature: string; read_paths: string[]; context_locator: { status: string; read_order: string[] } };
    expect(packet).toMatchObject({ role: 'file-explorer', feature: 'more-tools', read_paths: ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md', ...readOrder], context_locator: { status: 'hit', read_order: readOrder } });
  });
  it('records a schema-complete blocked File Explorer result when the locator is missing', async () => {
    const root = await temporary();
    await gitInit(root);
    const plan = await frozenPlan(root);
    const workflow = await generateWorkflow(plan, 'codex');
    const path = join(plan, 'workflow.json');
    await writeJson(path, workflow);
    await approveWorkflow(path, root);
    await rm(join(root, '.ai-workflow/index/navigation.json'));

    const run = await startRun({ workflowPath: path, host: 'codex', project: root });
    const result = run.nodes['task-001-example-explore']?.result;

    expect(run.state).toBe('paused');
    expect(result).toMatchObject({ status: 'blocked', changed_paths: [], tests: [], findings: [] });
    expect((result as { summary: string }).summary).toMatch(/Missing .*navigation\.json/i);
  });
  it('records a schema-complete blocked File Explorer result when the locator is invalid', async () => {
    const root = await temporary();
    await gitInit(root);
    const plan = await frozenPlan(root);
    const workflow = await generateWorkflow(plan, 'codex');
    const path = join(plan, 'workflow.json');
    await writeJson(path, workflow);
    await approveWorkflow(path, root);
    await writeFile(join(root, '.ai-workflow/index/navigation.json'), '{');

    const run = await startRun({ workflowPath: path, host: 'codex', project: root });
    const result = run.nodes['task-001-example-explore']?.result;

    expect(run.state).toBe('paused');
    expect(result).toMatchObject({ status: 'blocked', changed_paths: [], tests: [], findings: [] });
    expect((result as { summary: string }).summary).toMatch(/not valid JSON/i);
  });
  it('requires a matching receipt and completes nodes idempotently', async () => { const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'codex'); const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await expect(startRun({ workflowPath: path, host: 'codex', project: root })).rejects.toThrow(/receipt/); await approveWorkflow(path, root); const calls: string[] = []; const run = await startRun({ workflowPath: path, host: 'codex', project: root, executor: async (id, context) => { calls.push(id); if (id.endsWith('-implement')) { await (await import('node:fs/promises')).mkdir(join(context.cwd, 'src'), { recursive: true }); await (await import('node:fs/promises')).writeFile(join(context.cwd, 'src/output.ts'), 'done'); } return done; } }); expect(run.state).toBe('complete'); expect(calls.length).toBeGreaterThan(0); expect(await exists(join(root, '.ai-workflow/runs', run.run_id, 'summary.md'))).toBe(true); await cleanupRun(root, run.run_id); expect(await exists(join(root, '.ai-workflow/runs', `${run.run_id}.final.json`))).toBe(true); });
  it('pauses after retries and resumes without repeating success', async () => { const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'claude'); workflow.nodes.find((node) => node.id.endsWith('-explore'))!.retry = 0; const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await approveWorkflow(path, root); let failed = false; const run = await startRun({ workflowPath: path, host: 'claude', project: root, executor: async (id, context) => { if (!failed && id.endsWith('-explore')) { failed = true; throw new Error('boom'); } if (id.endsWith('-implement')) { await (await import('node:fs/promises')).mkdir(join(context.cwd, 'src'), { recursive: true }); await (await import('node:fs/promises')).writeFile(join(context.cwd, 'src/output.ts'), 'done'); } return done; } }); expect(run.state).toBe('paused'); const resumed = await resumeRun(root, run.run_id, async (id, context) => { if (id.endsWith('-implement')) { await (await import('node:fs/promises')).mkdir(join(context.cwd, 'src'), { recursive: true }); await (await import('node:fs/promises')).writeFile(join(context.cwd, 'src/output.ts'), 'done'); } return done; }); expect(resumed.state).toBe('complete'); });
  it('cancels and then permits cleanup', async () => { const root = await temporary(); await gitInit(root); const plan = await frozenPlan(root); const workflow = await generateWorkflow(plan, 'opencode'); const path = join(plan, 'workflow.json'); await writeJson(path, workflow); await approveWorkflow(path, root); const run = await startRun({ workflowPath: path, host: 'opencode', project: root, defer: true }); const cancelled = await cancelRun(root, run.run_id); expect(cancelled.state).toBe('cancelled'); await cleanupRun(root, run.run_id); });
});
