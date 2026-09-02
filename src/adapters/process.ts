import { spawn } from 'node:child_process';
import type { AgentPacket } from '../generated/packet.schema.js';
import type { AgentResult } from '../generated/result.schema.js';
import type { Host } from '../workflow/types.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';
import { redact } from '../security/policy.js';
import { packagePath } from '../utils/schema.js';

const commands: Record<Host, { command: string; args: string[] }> = {
  codex: { command: 'codex', args: ['exec', '--json', '--output-schema', 'schemas/result.schema.json', '-'] },
  claude: { command: 'claude', args: ['--print', '--output-format', 'json', '--json-schema', 'schemas/result.schema.json'] },
  opencode: { command: 'opencode', args: ['run', '--format', 'json'] }
};

export interface ProcessOptions { executable?: string; args?: string[]; signal?: AbortSignal; maxOutputBytes?: number }

export async function invokeHost(host: Host, prompt: string, packet: AgentPacket, options: ProcessOptions = {}): Promise<AgentResult> {
  const command = options.executable ?? commands[host].command; const defaultArgs = commands[host].args.map((arg) => arg.includes('schemas/result.schema.json') ? packagePath('schemas', 'result.schema.json') : arg); const message = `${prompt}\n\nPACKET:\n${JSON.stringify(packet)}\n\nRespond with exactly one JSON object conforming to schemas/result.schema.json. Do not output Markdown or explanations.`; const args = host === 'opencode' ? ['run', '--agent', packet.role, '--format', 'json', '--', message] : options.args ?? defaultArgs;
  const output = await new Promise<string>((resolve, reject) => {
    const timeoutController = new AbortController(); const timeout = setTimeout(() => timeoutController.abort(), packet.timeout_ms); const signal = options.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal;
    const child = spawn(command, args, { cwd: packet.cwd, stdio: ['pipe', 'pipe', 'pipe'], signal, env: { ...process.env, AI_WORKFLOW_HOST: host } });
    const chunks: Buffer[] = []; const errors: Buffer[] = []; let size = 0; const limit = options.maxOutputBytes ?? 1_000_000;
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= limit) chunks.push(chunk); }); child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', reject); child.once('close', (code) => { clearTimeout(timeout); if (size > limit) reject(new Error('Host output exceeded limit')); else if (code !== 0) reject(new Error(`Host exited ${String(code)}: ${redact(Buffer.concat(errors).toString('utf8')).slice(0, 10000)}`)); else resolve(Buffer.concat(chunks).toString('utf8')); });
    if (host === 'opencode') child.stdin.end(); else child.stdin.end(`${prompt}\n\nPACKET:\n${JSON.stringify(packet)}\n`);
  });
  const result = parseHostResult(output, host); const validate = await schemaValidator('result.schema.json'); if (!validate(result)) throw new Error(`Invalid host result: ${formatSchemaErrors(validate.errors)}`); return result as AgentResult;
}

function parseHostResult(output: string, host: Host): unknown {
  if (host === 'opencode') return parseOpenCodeResult(output);
  const trimmed = output.trim(); try { const direct = JSON.parse(trimmed) as unknown; if (direct && typeof direct === 'object') { if ('result' in direct) return (direct as { result: unknown }).result; if ((direct as Record<string, unknown>).type === 'result' && (direct as Record<string, unknown>).data) return (direct as Record<string, unknown>).data; } return direct; } catch { /* event stream */ }
  const lines = trimmed.split(/\r?\n/).filter(Boolean); for (let index = lines.length - 1; index >= 0; index--) { try { const event = JSON.parse(lines[index] ?? '') as Record<string, unknown>; if (event.result) return event.result; if (event.type === 'result' && event.data) return event.data; } catch { continue; } } throw new Error('Host did not return JSON result');
}

function parseOpenCodeResult(output: string): unknown {
  const text: string[] = [];
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch (error) { throw new Error(`OpenCode JSONL event is invalid: ${error instanceof Error ? error.message : String(error)}`); }
    if (event.type === 'text' && event.part && typeof event.part === 'object' && typeof (event.part as Record<string, unknown>).text === 'string') text.push((event.part as Record<string, unknown>).text as string);
  }
  if (!text.length) throw new Error('OpenCode did not return a text event');
  const combined = text.join('').trim(); const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(combined); const source = fenced?.[1]?.trim() ?? combined;
  try { return JSON.parse(source) as unknown; } catch (error) { throw new Error(`OpenCode text did not contain valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
