import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionSandboxError,
  BrokeredSandboxProvider,
  createActionSandboxCapability,
  requireActionSandbox,
  type SandboxProbe,
} from '../../src/security/sandbox.js';
import { invokeHost } from '../../src/adapters/process.js';
import { createProcessGroupIdentity, ProcessGroupRegistry, ProcessIdentityError, type ProcessGroupIdentity } from '../../src/adapters/process.js';
import { CodingWorkflowEngine, type ChildRun, type HostChildExecutor } from '../../src/runtime/engine.js';
import type { CallDescriptor, CodingAgentResult } from '../../src/runtime/protocol.js';
import type { AgentPacket } from '../../src/generated/packet.schema.js';

const digest = `sha256:${'c'.repeat(64)}`;
const identity: ProcessGroupIdentity = createProcessGroupIdentity(1201, 1201, '2026-09-03T14:00:00Z', 'spawn-1');

function packet(cwd: string, writePaths: string[] = []): AgentPacket {
  return {
    packet_version: '1.0.0',
    run_id: 'run-host-security',
    plan_id: '20260903-host-security',
    task_id: 'task-001-host',
    role: writePaths.length ? 'backend' : 'test',
    objective: 'run disposable action',
    cwd,
    read_paths: ['.'],
    write_paths: writePaths,
    evidence: [],
    screenshot_dir: '.ai-workflow/plans/20260903-host-security/screenshot/',
    allowed_commands: [],
    timeout_ms: 5000,
    result_schema: 'schemas/result.schema.json',
  };
}

function probe(overrides: Partial<SandboxProbe> = {}): SandboxProbe {
  return {
    platform: 'darwin',
    projectWriteEnforced: true,
    gitMetadataWriteDenied: true,
    actionExecutorNetworkDenied: true,
    modelTransportPartitioned: true,
    nativeToolBroker: true,
    processGroupControl: true,
    brokerAvailable: true,
    executorAvailable: true,
    credentialsVisibleToExecutor: false,
    ...overrides,
  };
}

describe('host security', () => {
  it('reports a complete brokered-sandbox capability with a distinct executor boundary', () => {
    const capability = createActionSandboxCapability(probe(), digest);

    expect(capability).toEqual({
      platform: 'darwin',
      project_write_enforcement: true,
      git_metadata_write_denied: true,
      action_executor_network_denied: true,
      model_transport_partitioned: true,
      native_tool_broker: true,
      process_group_control: true,
      policy_digest: digest,
    });
    expect(new BrokeredSandboxProvider(probe()).mode).toBe('brokered-sandbox');
  });

  it.each([
    ['broker', { brokerAvailable: false }],
    ['executor', { executorAvailable: false }],
    ['executor network', { actionExecutorNetworkDenied: false }],
    ['project write enforcement', { projectWriteEnforced: false }],
    ['Git metadata denial', { gitMetadataWriteDenied: false }],
    ['credential partition', { credentialsVisibleToExecutor: true }],
  ] as const)('fails closed when %s is unavailable', (_reason, overrides) => {
    expect(() => requireActionSandbox(probe(overrides))).toThrowError(ActionSandboxError);
  });

  it('does not pass broker credentials into the action executor environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-sandbox-'));
    const executable = join(root, 'credential-check.mjs');
    await writeFile(executable, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
await writeFile('executor-env.json', JSON.stringify({ token: process.env.BROKER_TOKEN ?? null }));
process.stdout.write(JSON.stringify({ status: 'done', summary: 'ok', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [] }));
`);
    await chmod(executable, 0o755);
    const provider = new BrokeredSandboxProvider(probe(), { brokerEnvironment: { BROKER_TOKEN: 'secret' } });

    const result = await invokeHost('codex', 'run', packet(root), { executable, args: [], sandbox: provider });
    expect(result.status).toBe('done');
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(join(root, 'executor-env.json'), 'utf8'))).resolves.toBe('{"token":null}');
  });

  it('rejects a write/test adapter invocation without a brokered sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-sandbox-'));
    const executable = join(root, 'should-not-run');
    await writeFile(executable, 'process.exit(0);');

    await expect(invokeHost('codex', 'run', packet(root, ['src/output.ts']), { executable, args: [] })).rejects.toThrowError(ActionSandboxError);
    expect(() => new ActionSandboxError('ACTION_SANDBOX_UNAVAILABLE', 'missing')).toBeTruthy();
  });

  it('runs a disposable action executor through macOS Seatbelt with network denied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-workflow-seatbelt-'));
    const executable = join(root, 'seatbelt-check');
    await writeFile(executable, `#!/usr/bin/env node
try {
  await fetch('http://127.0.0.1:9');
  process.stdout.write(JSON.stringify({ status: 'failed', summary: 'network unexpectedly available', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [] }));
} catch {
  process.stdout.write(JSON.stringify({ status: 'done', summary: 'executor network denied', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [] }));
}
`);
    await chmod(executable, 0o755);
    const provider = new BrokeredSandboxProvider(probe(), { projectRoot: root, useSeatbelt: true });
    await expect(invokeHost('codex', 'run', packet(root), { executable, args: [], sandbox: provider })).resolves.toMatchObject({ summary: 'executor network denied' });
  });

  it('refuses to signal or release a process group when its identity cannot be verified', () => {
    const registry = new ProcessGroupRegistry();
    registry.register('run-1', 'call-1', identity);
    expect(registry.verify('run-1', 'call-1', identity)).toBe(true);
    expect(() => registry.verify('run-1', 'call-1', { ...identity, spawn_nonce: 'stale' })).toThrowError(/could not be verified/);
    expect(() => registry.release('run-1', 'call-1', { ...identity, pgid: 9999 })).toThrowError(/could not be verified/);
    expect(registry.has('run-1', 'call-1')).toBe(true);
    expect(() => registry.signal('run-1', 'call-1', undefined)).toThrowError(ProcessIdentityError);
  });

  it('keeps child failure separate from host fatal sandbox failure and audits after reap', async () => {
    const done: CodingAgentResult = { result_version: '2.0.0', status: 'done', summary: 'ok', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [], value: 'ok' };
    const order: string[] = [];
    let resolveReaped!: () => void;
    const reaped = new Promise<void>((resolve) => { resolveReaped = () => { order.push('reaped'); resolve(); }; });
    const executor: HostChildExecutor = {
      async start() {
        order.push('start');
        return { id: 'child-1', identity, result: Promise.reject(new Error('child failed')), dispose: async () => { order.push('dispose'); resolveReaped(); }, reaped } as ChildRun;
      },
    };
    const run = new CodingWorkflowEngine().start({
      script: `const result = await agent('child', { actionId: 'build', callId: 'call-1' }); return result;`,
      manifestDigest: `sha256:${'d'.repeat(64)}`, scriptDigest: digest, argsDigest: digest,
      actions: [{ action_id: 'build', task_id: 'task-001-host' }], childExecutor: executor, disposeGraceMs: 100,
      sandboxPreflight: () => { order.push('preflight'); },
      audit: (_descriptor: CallDescriptor, event: 'before-dispatch' | 'after-dispose') => { order.push(`audit:${event}`); },
      processRegistry: (event) => { order.push(`registry:${event.type}`); },
    });
    await expect(run.result).resolves.toMatchObject({ stop_reason: 'completed', value: null });
    await run.dispose();
    expect(order).toEqual(['preflight', 'audit:before-dispatch', 'start', 'registry:registered', 'dispose', 'reaped', 'audit:after-dispose', 'registry:released']);
    expect(done.status).toBe('done');
  });

  it('returns a host fatal result when sandbox preflight rejects an action', async () => {
    const run = new CodingWorkflowEngine().start({
      script: `await agent('blocked', { actionId: 'build', callId: 'call-fatal' });`,
      manifestDigest: digest, scriptDigest: digest, argsDigest: digest,
      actions: [{ action_id: 'build', task_id: 'task-001-host' }], disposeGraceMs: 50,
      childExecutor: { async start(): Promise<never> { throw new Error('executor must not start'); } },
      sandboxPreflight: () => { throw new ActionSandboxError('ACTION_SANDBOX_UNAVAILABLE', 'fixture sandbox unavailable'); },
    });

    await expect(run.result).resolves.toMatchObject({ stop_reason: 'error', error: 'fixture sandbox unavailable' });
    await run.dispose();
  });
});
