import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { validateContext } from '../context/validate.js';
import { verifyInstallation, type InstallationCheck } from '../install/verify.js';
import { validateNotes } from '../notes/validate.js';
import { readStoredProjectGate } from '../sync/gate.js';
import { exists } from '../utils/fs.js';
import { validatePlanDirectory } from '../workflow/validate.js';
import { readWorkspaceManifest } from '../workflow/workspace.js';
import { workspaceStatus } from '../workspace/status.js';
import type { Host } from '../workflow/types.js';

export interface DoctorOptions {
  project?: string;
  host?: Host;
  plan?: string;
  home?: string;
  runtimeDirectory?: string;
}

export interface DoctorReport {
  project: string | null;
  valid: boolean;
  checks: InstallationCheck[];
}

const hosts: Host[] = ['codex', 'claude', 'opencode'];
const manifestRelative = '.config/ai-workflow/install-manifest.json';
const execFileAsync = promisify(execFile);

function check(id: string, status: InstallationCheck['status'], detail: string, recovery?: string): InstallationCheck {
  return { id, status, detail, ...(recovery === undefined ? {} : { recovery }) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHost(value: string): value is Host {
  return hosts.includes(value as Host);
}

async function recordedHosts(home: string): Promise<Host[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, manifestRelative), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const manifest = parsed as { hosts?: Partial<Record<Host, unknown>>; contracts?: Partial<Record<Host, unknown>>; sync_hooks?: Partial<Record<Host, unknown>> };
    return hosts.filter((host) =>
      (Array.isArray(manifest.hosts?.[host]) && manifest.hosts[host].length > 0)
      || manifest.contracts?.[host] !== undefined
      || manifest.sync_hooks?.[host] !== undefined);
  } catch {
    return [];
  }
}

async function hostReadiness(host: Host, home: string): Promise<InstallationCheck> {
  const recovery = `ai-workflow install --host ${host} --home "${home}"`;
  try {
    const { stdout } = await execFileAsync(host, ['--version'], { timeout: 5000 });
    const version = stdout.trim().split(/\r?\n/)[0] ?? '';
    return check(`host.readiness.${host}`, 'warn', `Host ${host} executable reported ${version || 'no version'}; authentication and trust are not verified.`, recovery);
  } catch (error) {
    return check(`host.readiness.${host}`, 'warn', `Host ${host} executable or authentication is unavailable; trust is not verified: ${errorMessage(error)}`, recovery);
  }
}

/**
 * Aggregate read-only adoption, synchronization, navigation, notes, plan, installation and
 * host-readiness checks. The doctor never repairs, installs, trusts, restarts, stages or
 * fetches anything; `valid` is true only when no check fails.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  if (options.host !== undefined && !isHost(options.host)) throw new Error(`Invalid host: ${options.host}`);
  const home = resolve(options.home ?? homedir());
  const project = options.project === undefined ? null : resolve(options.project);
  const checks: InstallationCheck[] = [];
  const installed = await recordedHosts(home);

  if (project !== null) {
    const contractRelative = '.ai-workflow/AGENTS.md';
    const contractPath = join(project, contractRelative);
    if (!(await exists(contractPath))) {
      checks.push(check('project.contract', 'fail', `Project contract is missing: ${contractRelative} (${contractPath}).`, `ai-workflow init "${project}" --upgrade`));
    } else {
      checks.push(check('project.contract', 'pass', `Project contract is present: ${contractRelative} (${contractPath}).`));
    }

    const memoryRelative = 'MEMORY.md';
    const memoryPath = join(project, memoryRelative);
    if (!(await exists(memoryPath))) {
      checks.push(check('project.memory', 'fail', `Project memory is missing: ${memoryRelative} (${memoryPath}).`, `ai-workflow init "${project}"`));
    } else {
      checks.push(check('project.memory', 'pass', `Project memory is present: ${memoryRelative} (${memoryPath}).`));
    }

    const navigationRelative = '.ai-workflow/index/navigation.json';
    const navigationPath = join(project, navigationRelative);
    const navigation = await validateContext(project);
    if (navigation.valid) {
      checks.push(check('project.navigation', 'pass', `Navigation validates: ${navigationRelative} (${navigationPath}).`));
    } else {
      checks.push(check('project.navigation', 'fail', `Navigation validation failed for ${navigationRelative} (${navigationPath}): ${navigation.errors.join('; ')}`, `ai-workflow context rebuild --project "${project}" --write`));
    }

    const notes = await validateNotes(project);
    if (notes.valid) {
      checks.push(check('project.notes', 'pass', `Notes validate under ${join(project, '.ai-workflow/notes')}.`));
    } else {
      checks.push(check('project.notes', 'fail', `Notes validation failed under ${join(project, '.ai-workflow/notes')}: ${notes.errors.join('; ')}`, `ai-workflow notes validate --project "${project}"`));
    }

    const storedHosts = options.host === undefined ? installed : [options.host];
    for (const host of storedHosts) {
      const result = await readStoredProjectGate({
        host,
        project,
        ...(options.runtimeDirectory === undefined ? {} : { runtimeDirectory: options.runtimeDirectory }),
      });
      if (result?.report === undefined) {
        const command = `ai-workflow sync-hook --host ${host} --phase --project "${project}"`;
        checks.push(check(`sync.stored.${host}`, 'warn', `No stored synchronization check exists for ${project} on host ${host}. Run ${command} to create one; no current synchronization result is claimed.`, command));
        continue;
      }
      const status = result.report.status;
      if (status === 'conflict' || status === 'failed' || result.decision === 'deny') {
        checks.push(check(`sync.stored.${host}`, 'fail', `Stored synchronization for host ${host} reports ${status}: ${result.context.split(/\r?\n/).join(' ')}`));
      } else if (status === 'synchronized' && result.report.verified) {
        checks.push(check(`sync.stored.${host}`, 'pass', `Stored synchronization for host ${host} is synchronized at ${result.report.source.commit ?? 'an unrecorded commit'}.`));
      } else {
        checks.push(check(`sync.stored.${host}`, 'warn', `Stored synchronization for host ${host} reports ${status}; no current synchronization result is claimed.`));
      }
    }
  }

  if (options.plan !== undefined) {
    const directory = resolve(options.plan);
    try {
      const result = await validatePlanDirectory(directory);
      checks.push(check('plan.validate', 'pass', `Plan ${result.plan_id} validates at ${directory}.`));
      if ((await readWorkspaceManifest(directory)) !== undefined) {
        const status = await workspaceStatus(directory);
        if (status.valid) {
          checks.push(check('plan.workspace', 'pass', `Workspace plan ${status.plan_id ?? result.plan_id} status is valid at ${directory}.`));
        } else {
          checks.push(check('plan.workspace', 'fail', `Workspace status failed for ${directory}: ${(status.errors ?? []).join('; ')}`, `ai-workflow workspace audit --plan "${directory}"`));
        }
      }
    } catch (error) {
      checks.push(check('plan.validate', 'fail', `Plan validation failed for ${directory}: ${errorMessage(error)}`, `ai-workflow plan validate --plan "${directory}"`));
    }
  }

  const targetHosts = options.host === undefined ? installed : installed.includes(options.host) ? [options.host] : [];
  const installation = await verifyInstallation(home, targetHosts);
  checks.push(...installation.checks);
  if (options.host !== undefined && !installed.includes(options.host)) {
    checks.push(check(`host.install.${options.host}`, 'fail', `Host ${options.host} is not installed under ${home}.`, `ai-workflow install --host ${options.host} --home "${home}"`));
  }
  if (options.host !== undefined) checks.push(await hostReadiness(options.host, home));

  return { project, valid: !checks.some((entry) => entry.status === 'fail'), checks };
}
