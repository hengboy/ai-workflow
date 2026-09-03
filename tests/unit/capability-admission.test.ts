import { describe, expect, it } from 'vitest';
import {
  ActionAdmissionError,
  admitAction,
  buildAgentPacket,
  type ActionAdmissionRequest,
  type ActionCapabilityManifest,
} from '../../src/security/capability.js';

const digest = `sha256:${'a'.repeat(64)}`;

function manifest(overrides: Partial<ActionCapabilityManifest> = {}): ActionCapabilityManifest {
  return {
    plan_id: '20260903-host-security',
    host: 'codex',
    host_execution: {
      adapter: 'codex',
      mode: 'brokered-sandbox',
      model_transport: { owner: 'host-native-broker', network_allowed: true, project_write_allowed: false, credential_visibility: 'broker-only' },
      action_executor: { process_group: true, network_allowed: false, project_write_enforced: true, git_metadata_write_allowed: false },
      native_tool_authorization: 'unavailable',
      capability_digest: digest,
    },
    tasks: [{
      task_id: 'task-001-host',
      depends_on: [],
      required_actions: ['build'],
      optional_actions: [],
      finalization_action: 'task-001-host-finalize',
    }],
    actions: [{
      action_id: 'build',
      task_id: 'task-001-host',
      operation: 'implement',
      role: 'backend',
      locator_read_order: ['src/input.ts'],
      read_scope: ['src'],
      write_scope: ['src/output.ts'],
      new_module_directories: [],
      allowed_commands: ['pnpm test'],
      test_commands: ['pnpm test'],
      output_schema: 'schemas/coding-agent-result.schema.json',
      requires_actions: [],
      max_attempts: 2,
      optional: false,
      write_access: true,
      host_only: false,
    }],
    ...overrides,
  };
}

function request(overrides: Partial<ActionAdmissionRequest> = {}): ActionAdmissionRequest {
  return {
    manifest: manifest(),
    action_id: 'build',
    run_id: 'run-host-security',
    cwd: '/tmp/task-worktree',
    attempt: 1,
    task_states: { 'task-001-host': 'ready' },
    action_states: {},
    active_hosts: [],
    ...overrides,
  };
}

describe('action capability admission', () => {
  it('admits a manifest action and builds a packet from capability fields', () => {
    const admission = admitAction(request());
    const packet = buildAgentPacket({
      admission,
      objective: 'Implement the authorized change.',
      evidence: ['task-001-host-explore'],
      screenshot_dir: '.ai-workflow/plans/20260903-host-security/screenshot/',
      timeout_ms: 20_000,
    });

    expect(admission.action.action_id).toBe('build');
    expect(packet).toMatchObject({
      packet_version: '1.0.0',
      run_id: 'run-host-security',
      plan_id: '20260903-host-security',
      task_id: 'task-001-host',
      role: 'backend',
      cwd: '/tmp/task-worktree',
      read_paths: ['src'],
      write_paths: ['src/output.ts'],
      allowed_commands: ['pnpm test'],
      result_schema: 'schemas/result.schema.json',
    });
  });

  it('rejects an action that is not in the manifest', () => {
    expect(() => admitAction(request({ action_id: 'secret-action' }))).toThrowError(/action is not authorized/);
  });

  it('rejects an action while its task dependency is not ready', () => {
    expect(() => admitAction(request({ task_states: { 'task-001-host': 'pending' } }))).toThrowError(/task is not ready/);
  });

  it('rejects a second host when one host is already active', () => {
    expect(() => admitAction(request({ active_hosts: ['claude'] }))).toThrowError(/one-host policy/);
  });

  it('rejects attempts beyond the immutable action budget', () => {
    expect(() => admitAction(request({ attempt: 3 }))).toThrowError(/attempt exceeds action budget/);
  });

  it('fails closed when a write action lacks brokered sandbox capability', () => {
    const unsafe = manifest({ host_execution: { ...manifest().host_execution, mode: 'unsupported' } });
    expect(() => admitAction(request({ manifest: unsafe }))).toThrowError(/lacks brokered sandbox/);
  });

  it.each(['role', 'operation', 'cwd', 'read_scope', 'write_scope', 'allowed_commands', 'output_schema'] as const)(
    'rejects script or agent override of %s',
    (field) => {
      const overrides = { [field]: field === 'cwd' ? '/tmp/other' : field === 'role' ? 'frontend' : field === 'operation' ? 'test' : field === 'output_schema' ? 'schemas/other.schema.json' : ['outside'] };
      expect(() => admitAction(request({ overrides }))).toThrowError(/override is not allowed/);
    },
  );

  it('exposes a stable admission error contract', () => {
    try {
      admitAction(request({ action_id: 'missing' }));
    } catch (error) {
      expect(error).toBeInstanceOf(ActionAdmissionError);
      expect((error as ActionAdmissionError).code).toBe('ACTION_NOT_AUTHORIZED');
    }
  });
});
