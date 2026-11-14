import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { install } from '../install/index.js';
import { verifyInstallation, type InstallationCheckStatus } from '../install/verify.js';
import { sha256 } from '../utils/hash.js';
import type { Host } from '../workflow/types.js';

const execFileAsync = promisify(execFile);
const defaultTimeoutMs = 120_000;
const versionTimeoutMs = 5_000;
const markerFile = 'SMOKE_MARKER.txt';

export type HostSmokeHost = Host | 'all';
export type HostSmokeStatus = 'PASS' | 'UNVERIFIED' | 'BLOCKED';

export interface HostSmokeOptions {
  host: HostSmokeHost;
  home?: string;
  live?: boolean;
  keep?: boolean;
  timeoutMs?: number;
  realHome?: string;
  tmpRoot?: string;
}

export interface HostSmokeStaticCheck {
  id: string;
  status: InstallationCheckStatus;
  detail: string;
}

export interface HostSmokeLive {
  attempted: boolean;
  exit_code?: number;
  marker_found?: boolean;
  elapsed_ms?: number;
}

export interface HostSmokeEntry {
  host: Host;
  version: string;
  static_checks: HostSmokeStaticCheck[];
  live: HostSmokeLive;
  status: HostSmokeStatus;
  reason: string;
}

export interface HostSmokeReport {
  matrix: HostSmokeEntry[];
  retained?: { home: string; fixture: string };
}

function hostList(value: HostSmokeHost): Host[] {
  return value === 'all' ? ['codex', 'claude', 'opencode'] : [value];
}

function inside(parent: string, child: string): boolean {
  const location = relative(parent, child);
  return location === '' || (!location.startsWith('..') && !isAbsolute(location));
}

interface SmokePaths {
  tmpRoot: string;
  suppliedHome?: string;
}

/**
 * Refuse unsafe or occupied targets before creating the HOME, fixture or any host write.
 * A supplied HOME must be absent or empty and must stay clear of the real home and fixture root.
 */
async function preflightSmoke(options: HostSmokeOptions): Promise<SmokePaths> {
  const realHome = resolve(options.realHome ?? homedir());
  const tmpRoot = resolve(options.tmpRoot ?? tmpdir());
  const suppliedHome = options.home === undefined ? undefined : resolve(options.home);
  if (suppliedHome !== undefined) {
    if (inside(realHome, suppliedHome)) throw new Error(`Refusing to use a smoke home equal to or inside the real home: ${suppliedHome}`);
    if (inside(suppliedHome, realHome)) throw new Error(`Refusing to use a smoke home that contains the real home: ${suppliedHome}`);
    if (inside(suppliedHome, tmpRoot)) throw new Error(`Refusing to use a smoke home that contains the fixture root: ${suppliedHome}`);
    let homeInfo: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      homeInfo = await lstat(suppliedHome);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (homeInfo !== undefined) {
      if (!homeInfo.isDirectory()) throw new Error(`Refusing to use a smoke home that is not a directory: ${suppliedHome}`);
      if ((await readdir(suppliedHome)).length > 0) throw new Error(`Refusing to use a non-empty smoke home: ${suppliedHome}`);
    }
  } else if (inside(realHome, tmpRoot)) {
    throw new Error(`Refusing to create a smoke home inside the real home: ${tmpRoot}`);
  }
  let rootInfo: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    rootInfo = await stat(tmpRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (rootInfo !== undefined && !rootInfo.isDirectory()) throw new Error(`Smoke fixture root is not a directory: ${tmpRoot}`);
  return { tmpRoot, ...(suppliedHome === undefined ? {} : { suppliedHome }) };
}

interface ProcessResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
}

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error: Error) => finish({ stdout, stderr, error: error as NodeJS.ErrnoException, timedOut }));
    child.once('close', (code) => {
      const result: ProcessResult = { stdout, stderr, timedOut };
      if (code !== null) result.exitCode = code;
      finish(result);
    });
  });
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      const key = relative(root, absolute).split(sep).join('/');
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isSymbolicLink()) snapshot.set(key, 'symlink');
      else if (entry.isFile()) snapshot.set(key, sha256(await readFile(absolute)));
    }
  }
  await walk(root);
  return snapshot;
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((path) => before.get(path) !== after.get(path)).sort();
}

function frozenDocument(title: string, body: string): string {
  return [
    '---',
    'plan_id: "smoke-fixture"',
    'status: frozen',
    'created_at: "2026-01-01T00:00:00.000Z"',
    'requirement_count: 1',
    'acceptance_criteria_count: 1',
    'digest: "sha256:smoke-fixture"',
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

async function prepareFixture(fixture: string, marker: string): Promise<void> {
  const planDirectory = join(fixture, '.ai-workflow/plans/smoke-fixture');
  await mkdir(planDirectory, { recursive: true });
  await writeFile(join(fixture, markerFile), `${marker}\n`);
  await writeFile(join(planDirectory, 'spec.md'), frozenDocument('Specification', 'The isolated fixture exposes a marker file for a read-only host dispatch.'));
  await writeFile(join(planDirectory, 'plan.md'), frozenDocument('Implementation Plan', 'Read the fixture marker file with the host and leave the fixture unchanged.'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: fixture });
  await execFileAsync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: fixture });
  await execFileAsync('git', ['config', 'user.name', 'Smoke Fixture'], { cwd: fixture });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: fixture });
  await execFileAsync('git', ['add', '-A'], { cwd: fixture });
  await execFileAsync('git', ['commit', '-m', 'smoke fixture'], { cwd: fixture });
}

async function readVersion(host: Host, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runProcess(host, ['--version'], cwd, env, versionTimeoutMs);
  const version = result.stdout.trim();
  if (version !== '') return version;
  return result.error === undefined ? 'unknown' : 'unavailable';
}

interface LiveOutcome {
  live: HostSmokeLive;
  reason: string;
  pass: boolean;
  blocked: boolean;
}

async function runLive(host: Host, fixture: string, home: string, marker: string, timeoutMs: number, before: Map<string, string>): Promise<LiveOutcome> {
  const prompt = `Read the file ${markerFile} in the current directory and reply with its exact contents.`;
  const invocation = host === 'codex'
    ? { command: 'codex', args: ['exec', '--skip-git-repo-check', '-C', fixture, '--sandbox', 'read-only', prompt] }
    : host === 'claude'
      ? { command: 'claude', args: ['-p', prompt] }
      : { command: 'opencode', args: ['run', '--dir', fixture, prompt] };
  const started = Date.now();
  const result = await runProcess(invocation.command, invocation.args, fixture, { ...process.env, HOME: home }, timeoutMs);
  const elapsed = Date.now() - started;
  const live: HostSmokeLive = { attempted: true, marker_found: result.stdout.includes(marker), elapsed_ms: elapsed };
  if (result.exitCode !== undefined) live.exit_code = result.exitCode;
  if (result.error !== undefined) {
    return { live, reason: `${host} executable is unavailable: ${result.error.message}`, pass: false, blocked: true };
  }
  if (result.timedOut) {
    return { live, reason: `${host} live dispatch timed out after ${timeoutMs}ms`, pass: false, blocked: true };
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 500);
    return { live, reason: `${host} live dispatch exited with code ${result.exitCode ?? 'unknown'}${detail === '' ? '' : `: ${detail}`}`, pass: false, blocked: false };
  }
  if (live.marker_found !== true) {
    return { live, reason: `${host} live dispatch exited 0 without reporting the fixture marker`, pass: false, blocked: false };
  }
  const changed = changedPaths(before, await snapshotTree(fixture));
  if (changed.length > 0) {
    return { live, reason: `${host} live dispatch modified the fixture: ${changed.join(', ')}`, pass: false, blocked: false };
  }
  return { live, reason: `${host} live dispatch exited 0, reported the fixture marker and left the fixture unchanged`, pass: true, blocked: false };
}

interface SmokeEntryInput {
  host: Host;
  version: string;
  staticChecks: HostSmokeStaticCheck[];
  live: boolean;
  fixture: string;
  home: string;
  marker: string;
  timeoutMs: number;
}

async function smokeEntry(input: SmokeEntryInput): Promise<HostSmokeEntry> {
  const { host, version, staticChecks, live, fixture, home, marker, timeoutMs } = input;
  if (!live) {
    return {
      host,
      version,
      static_checks: staticChecks,
      live: { attempted: false },
      status: 'UNVERIFIED',
      reason: `not_attempted: ${host} live dispatch was not requested`,
    };
  }
  const outcome = await runLive(host, fixture, home, marker, timeoutMs, await snapshotTree(fixture));
  const staticFailures = staticChecks.filter((check) => check.status === 'fail');
  if (staticFailures.length > 0) {
    return {
      host,
      version,
      static_checks: staticChecks,
      live: outcome.live,
      status: 'BLOCKED',
      reason: `static installation checks failed: ${staticFailures.map((check) => check.id).join(', ')}; ${outcome.reason}`,
    };
  }
  return {
    host,
    version,
    static_checks: staticChecks,
    live: outcome.live,
    status: outcome.pass ? 'PASS' : outcome.blocked ? 'BLOCKED' : 'UNVERIFIED',
    reason: outcome.reason,
  };
}

/**
 * Run one isolated host smoke matrix: create a temporary HOME and an external Git fixture,
 * install only the requested hosts into that HOME, verify the installation, optionally invoke
 * one non-interactive read-only dispatch and retain both paths only when requested.
 */
export async function runHostSmoke(options: HostSmokeOptions): Promise<HostSmokeReport> {
  const requested = hostList(options.host);
  const { tmpRoot, suppliedHome } = await preflightSmoke(options);
  const keep = options.keep === true;
  const live = options.live === true;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const marker = `ai-workflow-smoke-${randomUUID()}`;
  let home: string | undefined;
  let fixture: string | undefined;
  try {
    await mkdir(tmpRoot, { recursive: true });
    home = suppliedHome ?? await mkdtemp(join(tmpRoot, 'ai-workflow-smoke-home-'));
    if (suppliedHome !== undefined) await mkdir(suppliedHome, { recursive: true });
    fixture = await mkdtemp(join(tmpRoot, 'ai-workflow-smoke-fixture-'));
    await prepareFixture(fixture, marker);
    await install(requested, { home });
    const env = { ...process.env, HOME: home };
    const matrix: HostSmokeEntry[] = [];
    for (const host of requested) {
      const verification = await verifyInstallation(home, [host]);
      const staticChecks = verification.checks.map((check) => ({ id: check.id, status: check.status, detail: check.detail }));
      const version = await readVersion(host, fixture, env);
      matrix.push(await smokeEntry({ host, version, staticChecks, live, fixture, home, marker, timeoutMs }));
    }
    return { matrix, ...(keep ? { retained: { home, fixture } } : {}) };
  } catch (error) {
    throw new Error(`Smoke setup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!keep) {
      if (home !== undefined) await rm(home, { recursive: true, force: true });
      if (fixture !== undefined) await rm(fixture, { recursive: true, force: true });
    }
  }
}
