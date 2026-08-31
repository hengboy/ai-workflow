import { spawn } from 'node:child_process';
import type { AgentPacket } from '../generated/packet.schema.js';
import type { AgentResult } from '../generated/result.schema.js';
import type { Host } from '../workflow/types.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';
import { redact } from '../security/policy.js';

const commands: Record<Host, { command: string; args: string[] }> = {
  codex: { command: 'codex', args: ['exec', '--json', '--output-schema', 'schemas/result.schema.json', '-'] },
  claude: { command: 'claude', args: ['--print', '--output-format', 'json', '--json-schema', 'schemas/result.schema.json'] },
  opencode: { command: 'opencode', args: ['run', '--format', 'json'] }
};

export interface ProcessOptions { executable?: string; args?: string[]; signal?: AbortSignal; maxOutputBytes?: number }

export async function invokeHost(host: Host, prompt: string, packet: AgentPacket, options: ProcessOptions = {}): Promise<AgentResult> {
  const command = options.executable ?? commands[host].command; const args = options.args ?? commands[host].args;
  const output = await new Promise<string>((resolve, reject) => {
    const timeoutController = new AbortController(); const timeout = setTimeout(() => timeoutController.abort(), packet.timeout_ms); const signal = options.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal;
    const child = spawn(command, args, { cwd: packet.cwd, stdio: ['pipe', 'pipe', 'pipe'], signal, env: { ...process.env, AI_WORKFLOW_HOST: host } });
    const chunks: Buffer[] = []; const errors: Buffer[] = []; let size = 0; const limit = options.maxOutputBytes ?? 1_000_000;
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= limit) chunks.push(chunk); }); child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', reject); child.once('close', (code) => { clearTimeout(timeout); if (size > limit) reject(new Error('Host output exceeded limit')); else if (code !== 0) reject(new Error(`Host exited ${String(code)}: ${redact(Buffer.concat(errors).toString('utf8')).slice(0, 10000)}`)); else resolve(Buffer.concat(chunks).toString('utf8')); });
    child.stdin.end(`${prompt}\n\nPACKET:\n${JSON.stringify(packet)}\n`);
  });
  const result = parseHostResult(output); const validate = await schemaValidator('result.schema.json'); if (!validate(result)) throw new Error(`Invalid host result: ${formatSchemaErrors(validate.errors)}`); return result as AgentResult;
}

function parseHostResult(output: string): unknown {
  const trimmed = output.trim(); try { const direct = JSON.parse(trimmed) as unknown; if (direct && typeof direct === 'object' && 'result' in direct) return (direct as { result: unknown }).result; return direct; } catch { /* event stream */ }
  const lines = trimmed.split(/\r?\n/).filter(Boolean); for (let index = lines.length - 1; index >= 0; index--) { try { const event = JSON.parse(lines[index] ?? '') as Record<string, unknown>; if (event.result) return event.result; if (event.type === 'result' && event.data) return event.data; } catch { continue; } } throw new Error('Host did not return JSON result');
}
