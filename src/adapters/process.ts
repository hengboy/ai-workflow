import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentPacket } from '../generated/packet.schema.js';
import type { AgentResult } from '../generated/result.schema.js';
import type { Host } from '../workflow/types.js';
import { formatSchemaErrors, schemaValidator } from '../utils/schema.js';
import { redact } from '../security/policy.js';
import { packagePath } from '../utils/schema.js';
import { ActionSandboxError, BrokeredSandboxProvider, requireActionSandbox, type SandboxSpawnSpec } from '../security/sandbox.js';

const commands: Record<Host, { command: string; args: string[] }> = {
  codex: { command: 'codex', args: ['exec', '--json', '--output-schema', 'schemas/result.schema.json', '-'] },
  claude: { command: 'claude', args: ['--print', '--output-format', 'json', '--json-schema', 'schemas/result.schema.json'] },
  opencode: { command: 'opencode', args: ['run', '--format', 'json'] }
};

export interface ProcessGroupIdentity { pid: number; pgid: number; start_identity: string; spawn_nonce: string }

export function createProcessGroupIdentity(pid: number, pgid: number, startIdentity: string, spawnNonce: string = randomUUID()): ProcessGroupIdentity {
  const identity = { pid, pgid, start_identity: startIdentity, spawn_nonce: spawnNonce };
  if (!validIdentity(identity)) throw new ProcessIdentityError('CLEANUP_OWNERSHIP_UNPROVEN', 'process identity is incomplete');
  return identity;
}

export class ProcessIdentityError extends Error {
  readonly name = 'ProcessIdentityError';

  constructor(readonly code: 'CLEANUP_OWNERSHIP_UNPROVEN', message: string) {
    super(message);
  }
}

function validIdentity(identity: ProcessGroupIdentity | undefined): identity is ProcessGroupIdentity {
  return identity !== undefined
    && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && Number.isSafeInteger(identity.pgid) && identity.pgid > 0
    && identity.start_identity.length > 0 && identity.spawn_nonce.length > 0;
}

export class ProcessGroupRegistry {
  private readonly records = new Map<string, ProcessGroupIdentity>();

  register(runId: string, callId: string, identity: ProcessGroupIdentity): void {
    if (!validIdentity(identity)) throw new ProcessIdentityError('CLEANUP_OWNERSHIP_UNPROVEN', 'process identity is incomplete');
    this.records.set(`${runId}:${callId}`, { ...identity });
  }

  verify(runId: string, callId: string, observed: ProcessGroupIdentity | undefined): true {
    const expected = this.records.get(`${runId}:${callId}`);
    if (!expected || !validIdentity(observed) || expected.pid !== observed.pid || expected.pgid !== observed.pgid || expected.start_identity !== observed.start_identity || expected.spawn_nonce !== observed.spawn_nonce) {
      throw new ProcessIdentityError('CLEANUP_OWNERSHIP_UNPROVEN', `process identity could not be verified: ${runId}/${callId}`);
    }
    return true;
  }

  signal(runId: string, callId: string, observed: ProcessGroupIdentity | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
    const identity = this.records.get(`${runId}:${callId}`);
    if (!identity) throw new ProcessIdentityError('CLEANUP_OWNERSHIP_UNPROVEN', `process identity could not be verified: ${runId}/${callId}`);
    this.verify(runId, callId, observed);
    try { process.kill(-identity.pgid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  release(runId: string, callId: string, observed: ProcessGroupIdentity | undefined): void {
    this.verify(runId, callId, observed);
    this.records.delete(`${runId}:${callId}`);
  }

  has(runId: string, callId: string): boolean {
    return this.records.has(`${runId}:${callId}`);
  }
}

export interface ProcessOptions { executable?: string; args?: string[]; signal?: AbortSignal; maxOutputBytes?: number; sandbox?: BrokeredSandboxProvider }

export async function invokeHost(host: Host, prompt: string, packet: AgentPacket, options: ProcessOptions = {}): Promise<AgentResult> {
  const requiresSandbox = packet.role === 'test' || packet.write_paths.length > 0;
  if (requiresSandbox && !options.sandbox) {
    throw new ActionSandboxError('ACTION_SANDBOX_UNAVAILABLE', 'write/test action requires brokered sandbox');
  }
  if (options.sandbox) {
    requireActionSandbox({
      platform: 'darwin', projectWriteEnforced: true, gitMetadataWriteDenied: true,
      actionExecutorNetworkDenied: true, modelTransportPartitioned: true, nativeToolBroker: true,
      processGroupControl: true, brokerAvailable: true, executorAvailable: true, credentialsVisibleToExecutor: false,
    });
  }
  const command = options.executable ?? commands[host].command; const defaultArgs = commands[host].args.map((arg) => arg.includes('schemas/result.schema.json') ? packagePath('schemas', 'result.schema.json') : arg); const message = `${prompt}\n\nPACKET:\n${JSON.stringify(packet)}\n\nRespond with exactly one JSON object conforming to schemas/result.schema.json. Do not output Markdown or explanations.`; const args = host === 'opencode' ? ['run', '--agent', packet.role, '--format', 'json', '--', message] : options.args ?? defaultArgs;
  const output = await new Promise<string>((resolve, reject) => {
    const timeoutController = new AbortController(); const timeout = setTimeout(() => timeoutController.abort(), packet.timeout_ms); const signal = options.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal;
     const spec: SandboxSpawnSpec = options.sandbox?.spawnSpec(command, args, packet.cwd) ?? { command, args, env: { ...process.env } };
     spec.env.AI_WORKFLOW_HOST = host;
     const child = spawn(spec.command, spec.args, { cwd: packet.cwd, stdio: ['pipe', 'pipe', 'pipe'], signal, detached: true, env: spec.env });
    const chunks: Buffer[] = []; const errors: Buffer[] = []; let size = 0; const limit = options.maxOutputBytes ?? 1_000_000;
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= limit) chunks.push(chunk); }); child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', reject); child.once('close', (code) => { clearTimeout(timeout); if (size > limit) reject(new Error('Host output exceeded limit')); else if (code !== 0) reject(new Error(`Host exited ${String(code)}: ${redact(Buffer.concat(errors).toString('utf8')).slice(0, 10000)}`)); else resolve(Buffer.concat(chunks).toString('utf8')); });
    if (host === 'opencode') child.stdin.end(); else child.stdin.end(`${prompt}\n\nPACKET:\n${JSON.stringify(packet)}\n`);
  });
  const parsed = parseHostResult(output, host); const result = packet.role === 'file-explorer' ? normalizeFileExplorerResult(parsed) : parsed; const validate = await schemaValidator('result.schema.json'); if (!validate(result)) throw new Error(`Invalid host result: ${formatSchemaErrors(validate.errors)}`); return result as AgentResult;
}

function normalizeFileExplorerResult(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  if (!('answer' in source) && !('paths' in source)) return value;
  const status = source.status;
  return {
    status,
    summary: typeof source.answer === 'string' ? source.answer : '',
    changed_paths: status === 'done' && Array.isArray(source.paths) ? source.paths : [],
    evidence: Array.isArray(source.evidence) ? source.evidence : [],
    tests: Array.isArray(source.tests) ? source.tests : [],
    findings: Array.isArray(source.findings) ? source.findings : [],
    git_refs: Array.isArray(source.git_refs) ? source.git_refs : [],
    support_requests: Array.isArray(source.support_requests) ? source.support_requests : []
  };
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
