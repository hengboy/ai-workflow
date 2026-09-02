import { describe, expect, it } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invokeHost } from '../../src/adapters/process.js';
import { temporary } from '../helpers.js';
import type { AgentPacket } from '../../src/generated/packet.schema.js';

function packet(cwd: string, role: AgentPacket['role'] = 'backend'): AgentPacket { return { packet_version: '1.0.0', run_id: 'run', plan_id: '20260831-example', task_id: 'task-001-example', role, objective: 'test', cwd, read_paths: [], write_paths: [], evidence: [], screenshot_dir: '.ai-workflow/plans/20260831-example/screenshot/', allowed_commands: [], timeout_ms: 5000, result_schema: 'schemas/result.schema.json' }; }
describe('host adapter', () => {
  it('normalizes the legacy File Explorer answer and paths without losing information', async () => {
    const root = await temporary();
    const legacy = '{"status":"done","answer":"Located the requested files","paths":["src/App.tsx"],"evidence":["App.tsx:1"],"git_refs":[],"support_requests":[]}';
    const fake = join(root, 'file-explorer-legacy');
    await writeFile(fake, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${legacy}'\n`);
    await chmod(fake, 0o755);

    await expect(invokeHost('codex', 'prompt', packet(root, 'file-explorer'), { executable: fake, args: [] })).resolves.toMatchObject({
      status: 'done',
      summary: 'Located the requested files',
      changed_paths: ['src/App.tsx'],
      evidence: ['App.tsx:1'],
      tests: [],
      findings: [],
      support_requests: []
    });
  });
  it('normalizes a blocked legacy File Explorer result into the result schema', async () => {
    const root = await temporary();
    const legacy = '{"status":"blocked","answer":"Locator is unavailable","paths":[],"evidence":[],"git_refs":[],"support_requests":["Provide an authorized locator"]}';
    const fake = join(root, 'file-explorer-blocked');
    await writeFile(fake, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${legacy}'\n`);
    await chmod(fake, 0o755);

    await expect(invokeHost('codex', 'prompt', packet(root, 'file-explorer'), { executable: fake, args: [] })).resolves.toEqual({
      status: 'blocked',
      summary: 'Locator is unavailable',
      changed_paths: [],
      evidence: [],
      tests: [],
      findings: [],
      git_refs: [],
      support_requests: ['Provide an authorized locator']
    });
  });
  it('does not normalize the legacy File Explorer format for other roles', async () => {
    const root = await temporary();
    const legacy = '{"status":"done","answer":"Located the requested files","paths":["src/App.tsx"],"evidence":[],"git_refs":[],"support_requests":[]}';
    const fake = join(root, 'backend-legacy');
    await writeFile(fake, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${legacy}'\n`);
    await chmod(fake, 0o755);

    await expect(invokeHost('codex', 'prompt', packet(root, 'backend'), { executable: fake, args: [] })).rejects.toThrow(/Invalid host result/);
  });
  it('accepts a valid fake CLI result envelope', async () => { const root = await temporary(); const fake = join(root, 'fake-cli'); await writeFile(fake, '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"status":"done","summary":"ok","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}\'\n'); await chmod(fake, 0o755); const result = await invokeHost('codex', 'prompt', packet(root), { executable: fake, args: [] }); expect(result.status).toBe('done'); });
  it('accepts a direct JSON result from Claude', async () => { const root = await temporary(); const fake = join(root, 'claude-direct'); await writeFile(fake, '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"status":"done","summary":"direct","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}\'\n'); await chmod(fake, 0o755); await expect(invokeHost('claude', 'prompt', packet(root), { executable: fake, args: [] })).resolves.toMatchObject({ summary: 'direct' }); });
  it('accepts a result envelope from Claude', async () => { const root = await temporary(); const fake = join(root, 'claude-envelope'); await writeFile(fake, '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"result":{"status":"done","summary":"envelope","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}}\'\n'); await chmod(fake, 0o755); await expect(invokeHost('claude', 'prompt', packet(root), { executable: fake, args: [] })).resolves.toMatchObject({ summary: 'envelope' }); });
  it('accepts a JSONL result event from Claude', async () => { const root = await temporary(); const fake = join(root, 'claude-jsonl'); await writeFile(fake, '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"result","data":{"status":"done","summary":"jsonl","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}}\'\n'); await chmod(fake, 0o755); await expect(invokeHost('claude', 'prompt', packet(root), { executable: fake, args: [] })).resolves.toMatchObject({ summary: 'jsonl' }); });
  it('rejects malformed output and process failures', async () => { const root = await temporary(); const malformed = join(root, 'malformed'); await writeFile(malformed, '#!/bin/sh\ncat >/dev/null\nprintf \'{}\\n\'\n'); await chmod(malformed, 0o755); await expect(invokeHost('claude', 'prompt', packet(root), { executable: malformed, args: [] })).rejects.toThrow(/Invalid host result/); const failed = join(root, 'failed'); await writeFile(failed, '#!/bin/sh\ncat >/dev/null\necho bad >&2\nexit 3\n'); await chmod(failed, 0o755); await expect(invokeHost('opencode', 'prompt', packet(root), { executable: failed, args: [] })).rejects.toThrow(/exited 3/); });
  it('runs OpenCode file-explorer with one positional packet message', async () => {
    const root = await temporary();
    const result = '{"status":"done","summary":"ok","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}';
    const textEvent = JSON.stringify({ type: 'text', part: { text: result } });
    const script = join(root, 'opencode.mjs');
    await writeFile(script, `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
await writeFile('args.json', JSON.stringify(process.argv.slice(2)));
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
await writeFile('stdin.txt', stdin);
process.stdout.write(${JSON.stringify(`${textEvent}\n`)});
`);
    await chmod(script, 0o755);

    const response = await invokeHost('opencode', 'prompt', packet(root, 'file-explorer'), { executable: script, args: [] });
    const args = JSON.parse(await readFile(join(root, 'args.json'), 'utf8')) as string[];

    expect(response.status).toBe('done');
    expect(args).toHaveLength(7);
    expect(args.slice(0, 6)).toEqual(['run', '--agent', 'file-explorer', '--format', 'json', '--']);
    expect(args[6]).toContain('prompt');
    expect(args[6]).toContain('PACKET:\n');
    expect(args[6]).toContain('"role":"file-explorer"');
    expect(args[6]).toContain('Respond with exactly one JSON object conforming to schemas/result.schema.json. Do not output Markdown or explanations.');
    expect(args.filter((arg) => arg.includes('PACKET:'))).toEqual([args[6]]);
    expect(await readFile(join(root, 'stdin.txt'), 'utf8')).toBe('');
  });
  it('runs OpenCode successfully when the message starts with YAML frontmatter', async () => {
    const root = await temporary();
    const result = '{"status":"done","summary":"frontmatter","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}';
    const textEvent = JSON.stringify({ type: 'text', part: { text: result } });
    const script = join(root, 'opencode.mjs');
    await writeFile(script, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
await writeFile('args.json', JSON.stringify(process.argv.slice(2)));
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
await writeFile('stdin.txt', stdin);
if (process.argv[7] !== '--') {
  process.stderr.write('message interpreted as an option');
  process.exit(1);
}
process.stdout.write(${JSON.stringify(`${textEvent}\n`)});
`);
    await chmod(script, 0o755);

    const message = '---\nrole: file-explorer\n---\nInspect the repository.';
    const response = await invokeHost('opencode', message, packet(root, 'file-explorer'), { executable: script });
    const args = JSON.parse(await readFile(join(root, 'args.json'), 'utf8')) as string[];

    expect(response.summary).toBe('frontmatter');
    expect(args.slice(0, 6)).toEqual(['run', '--agent', 'file-explorer', '--format', 'json', '--']);
    expect(args).toHaveLength(7);
    expect(args[6]).toContain(message);
    expect(args.filter((arg) => arg.includes(message))).toEqual([args[6]]);
    expect(await readFile(join(root, 'stdin.txt'), 'utf8')).toBe('');
  });
  it('runs OpenCode frontend with one positional packet message', async () => {
    const root = await temporary();
    const result = '{"status":"done","summary":"ok","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}';
    const split = Math.floor(result.length / 2);
    const first = JSON.stringify({ type: 'text', part: { text: result.slice(0, split) } });
    const second = JSON.stringify({ type: 'text', part: { text: result.slice(split) } });
    const script = join(root, 'opencode.mjs');
    await writeFile(script, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
await writeFile('args.json', JSON.stringify(process.argv.slice(2)));
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
await writeFile('stdin.txt', stdin);
process.stdout.write(${JSON.stringify(`${first}\n${second}\n`)});
`);
    await chmod(script, 0o755);

    const response = await invokeHost('opencode', 'prompt', packet(root, 'frontend'), { executable: script, args: [] });
    const args = JSON.parse(await readFile(join(root, 'args.json'), 'utf8')) as string[];

    expect(response.status).toBe('done');
    expect(args).toHaveLength(7);
    expect(args.slice(0, 6)).toEqual(['run', '--agent', 'frontend', '--format', 'json', '--']);
    expect(args[6]).toContain('prompt');
    expect(args[6]).toContain('PACKET:\n');
    expect(args[6]).toContain('"role":"frontend"');
    expect(args[6]).toContain('Respond with exactly one JSON object conforming to schemas/result.schema.json. Do not output Markdown or explanations.');
    expect(args.filter((arg) => arg.includes('PACKET:'))).toEqual([args[6]]);
    expect(await readFile(join(root, 'stdin.txt'), 'utf8')).toBe('');
  });
  it('accepts fenced JSON in an OpenCode text event', async () => { const root = await temporary(); const result = '{"status":"done","summary":"fenced","changed_paths":[],"evidence":[],"tests":[],"findings":[],"git_refs":[],"support_requests":[]}'; const event = JSON.stringify({ type: 'text', part: { text: ['```json', result, '```'].join('\n') } }); const script = join(root, 'opencode'); await writeFile(script, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${event}'\n`); await chmod(script, 0o755); await expect(invokeHost('opencode', 'prompt', packet(root, 'frontend'), { executable: script })).resolves.toMatchObject({ summary: 'fenced' }); });
  it('reports invalid JSON returned in an OpenCode text event', async () => { const root = await temporary(); const event = JSON.stringify({ type: 'text', part: { text: 'not JSON' } }); const script = join(root, 'opencode'); await writeFile(script, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${event}'\n`); await chmod(script, 0o755); await expect(invokeHost('opencode', 'prompt', packet(root, 'frontend'), { executable: script })).rejects.toThrow(/OpenCode text did not contain valid JSON/); });
  it('reports invalid JSONL returned by OpenCode', async () => { const root = await temporary(); const script = join(root, 'opencode'); await writeFile(script, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' 'not JSONL'\n`); await chmod(script, 0o755); await expect(invokeHost('opencode', 'prompt', packet(root, 'frontend'), { executable: script })).rejects.toThrow(/OpenCode JSONL event is invalid/); });
  it('reports when OpenCode returns no text events', async () => { const root = await temporary(); const script = join(root, 'opencode'); await writeFile(script, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{"type":"start"}'\n`); await chmod(script, 0o755); await expect(invokeHost('opencode', 'prompt', packet(root, 'frontend'), { executable: script })).rejects.toThrow(/OpenCode did not return a text event/); });
  it('supports abort cancellation', async () => { const root = await temporary(); const fake = join(root, 'slow'); await writeFile(fake, '#!/bin/sh\ncat >/dev/null\nsleep 10\n'); await chmod(fake, 0o755); const controller = new AbortController(); setTimeout(() => controller.abort(), 30); await expect(invokeHost('codex', 'prompt', packet(root), { executable: fake, args: [], signal: controller.signal })).rejects.toThrow(); });
});
