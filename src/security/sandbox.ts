import { access } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from '../utils/hash.js';

export interface SandboxProbe {
  platform: NodeJS.Platform;
  projectWriteEnforced: boolean;
  gitMetadataWriteDenied: boolean;
  actionExecutorNetworkDenied: boolean;
  modelTransportPartitioned: boolean;
  nativeToolBroker: boolean;
  processGroupControl: boolean;
  brokerAvailable: boolean;
  executorAvailable: boolean;
  credentialsVisibleToExecutor: boolean;
}

export interface ActionSandboxCapability {
  platform: 'darwin';
  project_write_enforcement: true;
  git_metadata_write_denied: true;
  action_executor_network_denied: true;
  model_transport_partitioned: true;
  native_tool_broker: true;
  process_group_control: true;
  policy_digest: string;
}

export interface SandboxSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface SandboxProviderOptions {
  projectRoot?: string;
  writePaths?: readonly string[];
  useSeatbelt?: boolean;
  brokerEnvironment?: Readonly<Record<string, string>>;
}

export class ActionSandboxError extends Error {
  readonly name = 'ActionSandboxError';

  constructor(readonly code: 'ACTION_SANDBOX_UNAVAILABLE', message: string) {
    super(message);
  }
}

function reject(message: string): never {
  throw new ActionSandboxError('ACTION_SANDBOX_UNAVAILABLE', message);
}

export function requireActionSandbox(probe: SandboxProbe): void {
  if (probe.platform !== 'darwin') reject(`brokered action sandbox requires darwin, received ${probe.platform}`);
  if (!probe.brokerAvailable || !probe.executorAvailable) reject('broker and action executor must both be available');
  if (probe.credentialsVisibleToExecutor) reject('executor credentials must remain broker-only');
  if (!probe.projectWriteEnforced || !probe.gitMetadataWriteDenied || !probe.actionExecutorNetworkDenied || !probe.modelTransportPartitioned || !probe.nativeToolBroker || !probe.processGroupControl) {
    reject('action sandbox does not satisfy the required capability boundary');
  }
}

export function createActionSandboxCapability(probe: SandboxProbe, policyDigest: string): ActionSandboxCapability {
  requireActionSandbox(probe);
  if (!/^sha256:[a-f0-9]{64}$/.test(policyDigest)) reject('policy digest is invalid');
  return {
    platform: 'darwin',
    project_write_enforcement: true,
    git_metadata_write_denied: true,
    action_executor_network_denied: true,
    model_transport_partitioned: true,
    native_tool_broker: true,
    process_group_control: true,
    policy_digest: policyDigest,
  };
}

function defaultProbe(): SandboxProbe {
  return {
    platform: process.platform,
    projectWriteEnforced: process.platform === 'darwin',
    gitMetadataWriteDenied: process.platform === 'darwin',
    actionExecutorNetworkDenied: process.platform === 'darwin',
    modelTransportPartitioned: process.platform === 'darwin',
    nativeToolBroker: process.platform === 'darwin',
    processGroupControl: true,
    brokerAvailable: process.platform === 'darwin',
    executorAvailable: process.platform === 'darwin',
    credentialsVisibleToExecutor: false,
  };
}

function quoteProfilePath(value: string): string {
  return JSON.stringify(value).replaceAll('\\', '\\\\');
}

function physicalPath(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}

function seatbeltProfile(projectRoot: string, writePaths: readonly string[]): string {
  const writes = writePaths.length
    ? writePaths.map((path) => `  (allow file-write* (literal ${quoteProfilePath(physicalPath(path))}))\n  (allow file-write* (subpath ${quoteProfilePath(physicalPath(path))}))`).join('\n')
    : '';
  const git = physicalPath(`${projectRoot}/.git`);
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow file-read*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    writes,
    `  (deny file-write* (subpath ${quoteProfilePath(git)}))`,
  ].filter(Boolean).join('\n');
}

function isCredentialKey(key: string): boolean {
  return /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|PRIVATE|AWS|AZURE|GCP)/i.test(key);
}

function executorEnvironment(brokerEnvironment: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const brokerKeys = new Set(Object.keys(brokerEnvironment ?? {}));
  for (const [key, value] of Object.entries(process.env)) if (!isCredentialKey(key) && !brokerKeys.has(key)) env[key] = value;
  env.AI_WORKFLOW_SANDBOX = 'brokered-executor';
  env.AI_WORKFLOW_NETWORK = 'denied';
  env.AI_WORKFLOW_CREDENTIALS = 'broker-only';
  return env;
}

export class BrokeredSandboxProvider {
  readonly mode = 'brokered-sandbox' as const;
  readonly capability: ActionSandboxCapability;
  private readonly options: SandboxProviderOptions;

  constructor(probe: SandboxProbe = defaultProbe(), options: SandboxProviderOptions = {}) {
    this.capability = createActionSandboxCapability(probe, sha256('ai-workflow-action-sandbox-v2'));
    this.options = options;
  }

  preflight(): ActionSandboxCapability {
    return this.capability;
  }

  spawnSpec(command: string, args: readonly string[], cwd: string): SandboxSpawnSpec {
    if (!cwd) reject('executor cwd is required');
    const useSeatbelt = this.options.useSeatbelt ?? true;
    if (!useSeatbelt) return { command, args: [...args], env: executorEnvironment(this.options.brokerEnvironment) };
    const projectRoot = this.options.projectRoot;
    if (!projectRoot) reject('Seatbelt executor requires projectRoot');
    const profile = seatbeltProfile(projectRoot, (this.options.writePaths ?? []).map((path) => resolve(projectRoot, path)));
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', profile, '--', command, ...args],
      env: executorEnvironment(this.options.brokerEnvironment),
    };
  }

  async available(): Promise<boolean> {
    if (this.options.useSeatbelt === false) return false;
    try { await access('/usr/bin/sandbox-exec', constants.X_OK); return true; } catch { return false; }
  }
}

export interface ModelTransportBroker {
  readonly networkOwner: 'host-native-broker';
  request(input: unknown): Promise<unknown>;
}

export function createModelTransportBroker(request: (input: unknown) => Promise<unknown>): ModelTransportBroker {
  return { networkOwner: 'host-native-broker', request };
}

export function runBrokerProbe(provider: BrokeredSandboxProvider): Promise<boolean> {
  return provider.available().then((available) => available && provider.mode === 'brokered-sandbox');
}
