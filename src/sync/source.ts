import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generatedArtifacts, generatedDocumentError } from './artifacts.js';

const repository = 'hengboy/ai-workflow';
const branch = 'main';
const sourceUrl = 'https://github.com/hengboy/ai-workflow.git';
const projectDirectory = 'templates/project';

export type GitRunner = (arguments_: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

/** Short bound so a stalled system-proxy helper never delays the clone indefinitely. */
const systemProxyTimeoutMs = 2000;

/** Fixed upper bound for one template clone; a stalled transport must not hang acquisition indefinitely. */
const defaultCloneTimeoutMs = 60_000;

/**
 * A template clone that was killed or exceeded its bound. The message names the operation, the
 * fixed source and branch, and the bound so a stalled acquisition is distinguishable from an
 * ordinary clone failure.
 */
export class TemplateSourceTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateSourceTimeoutError';
  }
}

/** Proxy variables the git transport already honors; any of them makes the OS lookup unnecessary. */
const explicitProxyVariables = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'] as const;

/** A single proxy route to merge into the child's copied environment. */
interface SystemProxy {
  variable: string;
  value: string;
}

function hasExplicitProxy(env: NodeJS.ProcessEnv): boolean {
  return explicitProxyVariables.some((variable) => (env[variable] ?? '').trim() !== '');
}

/** Build a `host:port` authority, bracketing IPv6 literals; invalid hosts or ports yield nothing. */
function proxyAuthority(host: string | undefined, port: string | undefined): string | undefined {
  if (host === undefined || host === '' || port === undefined) return undefined;
  if (!/^\d{1,5}$/.test(port) || Number(port) <= 0 || Number(port) > 65535) return undefined;
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

/**
 * Read the enabled static settings from `scutil --proxy` and select one route. HTTPS wins and uses
 * `http://` for CONNECT; an enabled SOCKS proxy is the fallback. Nothing is inferred when the
 * helper is unavailable or no usable enabled proxy is configured.
 */
function parseSystemProxy(output: string): SystemProxy | undefined {
  const settings = new Map<string, string>();
  for (const line of output.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (/^[A-Za-z]+$/.test(key) && value !== '') settings.set(key, value);
  }
  if (settings.get('HTTPSEnable') === '1') {
    const authority = proxyAuthority(settings.get('HTTPSProxy'), settings.get('HTTPSPort'));
    if (authority !== undefined) return { variable: 'https_proxy', value: `http://${authority}` };
  }
  if (settings.get('SOCKSEnable') === '1') {
    const authority = proxyAuthority(settings.get('SOCKSProxy'), settings.get('SOCKSPort'));
    if (authority !== undefined) return { variable: 'all_proxy', value: `socks5h://${authority}` };
  }
  return undefined;
}

/**
 * On macOS only, translate the system HTTPS/SOCKS proxy into the child git environment when no
 * explicit proxy variable was supplied. A helper that is missing, fails, times out or reports no
 * enabled proxy leaves the environment untouched, preserving ordinary Git behavior.
 */
async function systemProxyEnvironment(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  if (process.platform !== 'darwin' || hasExplicitProxy(env)) return {};
  let output: string;
  try {
    const result = await execFileAsync('scutil', ['--proxy'], { timeout: systemProxyTimeoutMs });
    output = result.stdout;
  } catch {
    return {};
  }
  const proxy = parseSystemProxy(output);
  if (proxy === undefined) return {};
  return { [proxy.variable]: proxy.value };
}

/** Apply the clone bound only to the clone call; other git invocations keep their ordinary behavior. */
function defaultGitRunner(cloneTimeoutMs: number): GitRunner {
  return async (arguments_) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const isClone = arguments_[0] === 'clone';
    if (isClone) Object.assign(env, await systemProxyEnvironment(env));
    const options: { env: NodeJS.ProcessEnv; timeout?: number } = { env };
    if (isClone) options.timeout = cloneTimeoutMs;
    const { stdout } = await execFileAsync('git', arguments_, options);
    return { stdout };
  };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Recognize a clone killed by a bound or rejected by one of the timeout-like transport shapes. */
function isCloneTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { killed?: unknown; signal?: unknown; code?: unknown };
  if (candidate.killed === true) return true;
  if (candidate.code === 'ETIMEDOUT') return true;
  if (typeof candidate.signal === 'string' && candidate.signal !== '') return true;
  return /timed?\s*out|timeout|killed|SIGTERM|SIGKILL/i.test(candidate.message);
}

function cloneTimeoutError(bound: number): TemplateSourceTimeoutError {
  return new TemplateSourceTimeoutError(
    `Template clone timed out: git clone ${sourceUrl} --branch ${branch} did not finish within ${bound}ms; the process was killed`,
  );
}

/**
 * Acquire exactly the five generated sources at one immutable public commit. A shallow clone of
 * the fixed public address is pinned by a 40-hex commit; every required member must be present and
 * be markerless Markdown with a level-one title. Extras are ignored, and a missing or malformed
 * member rejects so no target can be written from an incomplete snapshot.
 */
export async function resolveTemplateSnapshot(options: { runGit?: GitRunner; timeoutMs?: number } = {}): Promise<{
  source: { repository: string; branch: string; commit: string };
  files: Record<string, string>;
}> {
  const cloneBound = options.timeoutMs ?? defaultCloneTimeoutMs;
  const git = options.runGit ?? defaultGitRunner(cloneBound);
  const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-source-'));
  try {
    try {
      await git(['clone', '--depth', '1', '--branch', branch, sourceUrl, directory]);
    } catch (error) {
      if (isCloneTimeout(error)) throw cloneTimeoutError(cloneBound);
      throw error;
    }
    const commit = (await git(['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error(`Template source branch has no immutable commit: ${branch}`);
    }
    try {
      if (!(await stat(join(directory, projectDirectory))).isDirectory()) {
        throw new Error(`Template source directory is unavailable: ${projectDirectory}`);
      }
    } catch (error) {
      if (isMissing(error)) throw new Error(`Template source directory is unavailable: ${projectDirectory}`);
      throw error;
    }
    const files: Record<string, string> = {};
    for (const artifact of generatedArtifacts) {
      const path = artifact.source;
      let text: string;
      try {
        if (!(await stat(join(directory, path))).isFile()) throw new Error(`Template source file is unavailable: ${path}`);
        text = await readFile(join(directory, path), 'utf8');
      } catch (error) {
        if (isMissing(error)) throw new Error(`Template source is incomplete; a required generated member is missing: ${path}`);
        throw error;
      }
      const formatError = generatedDocumentError(text);
      if (formatError !== undefined) throw new Error(`Template source structure is invalid: ${path} (${formatError})`);
      files[path] = text;
    }
    return { source: { repository, branch, commit }, files };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
