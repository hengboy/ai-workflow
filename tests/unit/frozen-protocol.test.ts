import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { generateWorkflow } from '../../src/workflow/generate.js';
import { invokeHost } from '../../src/adapters/process.js';
import { frozenPlan, temporary } from '../helpers.js';
import type { AgentPacket } from '../../src/generated/packet.schema.js';
const packet = (cwd: string): AgentPacket => ({ packet_version: '1.0.0', run_id: 'run', plan_id: '20260831-example', role: 'backend', objective: 'test', cwd, read_paths: [], write_paths: [], evidence: [], screenshot_dir: 'ai-workflow/plans/20260831-example/screenshot/', allowed_commands: [], timeout_ms: 1000, result_schema: 'schemas/result.schema.json' });
describe('frozen protocol validation', () => {
  it('rejects mismatched frozen plan identifiers and counts', async () => { const root = await temporary(); const plan = await frozenPlan(root); const content = await readFile(join(plan, 'plan.md'), 'utf8'); await writeFile(join(plan, 'plan.md'), content.replace('20260831-example', '20260831-other')); await expect(generateWorkflow(plan, 'codex')).rejects.toThrow(/plan_id|matching|count/i); });
  it('passes an absolute package schema path to the host CLI', async () => { const root = await temporary(); const script = join(root, 'args'); await writeFile(script, '#!/bin/sh\nprintf "%s" "$*" > args.txt\ncat >/dev/null\nprintf \'%s\\n\' \'{"status":"done","summary":"ok","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}\'\n'); await chmod(script, 0o755); await invokeHost('codex', 'prompt', packet(root), { executable: script }); const args = await readFile(join(root, 'args.txt'), 'utf8'); expect(args).toMatch(/output-schema/); expect(args).toMatch(/\/schemas\/result\.schema\.json/); });
});
