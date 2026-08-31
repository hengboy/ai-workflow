import { describe, expect, it } from 'vitest';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invokeHost } from '../../src/adapters/process.js';
import { temporary } from '../helpers.js';
import type { AgentPacket } from '../../src/generated/packet.schema.js';

function packet(cwd: string): AgentPacket { return { packet_version: '1.0.0', run_id: 'run', plan_id: '20260831-example', task_id: 'task-001-example', role: 'backend', objective: 'test', cwd, read_paths: [], write_paths: [], evidence: [], screenshot_dir: 'ai-workflow/plans/20260831-example/screenshot/', allowed_commands: [], timeout_ms: 1000, result_schema: 'schemas/result.schema.json' }; }
describe('host adapter', () => {
  it('accepts a valid fake CLI result envelope', async () => { const root = await temporary(); const fake = join(root, 'fake-cli'); await writeFile(fake, '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"status":"done","summary":"ok","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}\'\n'); await chmod(fake, 0o755); const result = await invokeHost('codex', 'prompt', packet(root), { executable: fake, args: [] }); expect(result.status).toBe('done'); });
  it('rejects malformed output and process failures', async () => { const root = await temporary(); const malformed = join(root, 'malformed'); await writeFile(malformed, '#!/bin/sh\ncat >/dev/null\nprintf \'{}\\n\'\n'); await chmod(malformed, 0o755); await expect(invokeHost('claude', 'prompt', packet(root), { executable: malformed, args: [] })).rejects.toThrow(/Invalid host result/); const failed = join(root, 'failed'); await writeFile(failed, '#!/bin/sh\ncat >/dev/null\necho bad >&2\nexit 3\n'); await chmod(failed, 0o755); await expect(invokeHost('opencode', 'prompt', packet(root), { executable: failed, args: [] })).rejects.toThrow(/exited 3/); });
  it('supports abort cancellation', async () => { const root = await temporary(); const fake = join(root, 'slow'); await writeFile(fake, '#!/bin/sh\ncat >/dev/null\nsleep 10\n'); await chmod(fake, 0o755); const controller = new AbortController(); setTimeout(() => controller.abort(), 30); await expect(invokeHost('codex', 'prompt', packet(root), { executable: fake, args: [], signal: controller.signal })).rejects.toThrow(); });
});
