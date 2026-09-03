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
import type { AgentPacket } from '../../src/generated/packet.schema.js';

const digest = `sha256:${'c'.repeat(64)}`;

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
    expect(() => requireActionSandbox(probe(overrides))).toThrowError(
      expect.objectContaining({ code: 'ACTION_SANDBOX_UNAVAILABLE' }),
    );
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

    await expect(invokeHost('codex', 'run', packet(root, ['src/output.ts']), { executable, args: [] })).rejects.toThrowError(
      expect.objectContaining({ code: 'ACTION_SANDBOX_UNAVAILABLE' }),
    );
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
});
