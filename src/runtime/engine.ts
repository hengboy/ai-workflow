import { randomUUID } from 'node:crypto';
import type { ActionProjection } from './worker-runtime.js';
import { WorkerRun, type HostAuditCallback, type HostChildExecutor, type ProcessRegistryCallback, type SandboxPreflightCallback, type WorkflowObserver } from './worker-host.js';

export interface CodingWorkflowStartOptions {
  runId?: string;
  script: string;
  args?: unknown;
  manifestDigest: string;
  scriptDigest: string;
  argsDigest: string;
  actions?: readonly ActionProjection[];
  maxConcurrentAgents?: number;
  maxTotalAgents?: number;
  maxItemsPerCall?: number;
  maxScriptBytes?: number;
  maxResultBytes?: number;
  syncTimeoutMs?: number;
  disposeGraceMs?: number;
  childExecutor?: HostChildExecutor;
  observer?: WorkflowObserver;
  audit?: HostAuditCallback;
  sandboxPreflight?: SandboxPreflightCallback;
  processRegistry?: ProcessRegistryCallback;
}

export class CodingWorkflowEngine {
  start(options: CodingWorkflowStartOptions): WorkerRun {
    const runId = options.runId ?? `run-${randomUUID()}`;
    return new WorkerRun({
      runId,
      worker: {
        runId,
        script: options.script,
        ...(options.args === undefined ? {} : { args: options.args }),
        manifestDigest: options.manifestDigest,
        scriptDigest: options.scriptDigest,
        argsDigest: options.argsDigest,
        actions: options.actions ?? [],
        maxConcurrentAgents: options.maxConcurrentAgents ?? 3,
        maxTotalAgents: options.maxTotalAgents ?? 32,
        maxItemsPerCall: options.maxItemsPerCall ?? 256,
        maxScriptBytes: options.maxScriptBytes ?? 262_144,
        maxResultBytes: options.maxResultBytes ?? 1_048_576,
        syncTimeoutMs: options.syncTimeoutMs ?? 5_000,
      },
      childExecutor: options.childExecutor,
      observer: options.observer,
      audit: options.audit,
      sandboxPreflight: options.sandboxPreflight,
      processRegistry: options.processRegistry,
      disposeGraceMs: options.disposeGraceMs ?? 5_000,
    });
  }
}

export type { HostAuditCallback, HostChildExecutor, ProcessRegistryCallback, SandboxPreflightCallback, WorkflowObserver } from './worker-host.js';
export type { ChildRun } from './worker-host.js';
