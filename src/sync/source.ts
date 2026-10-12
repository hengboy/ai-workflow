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

const defaultGitRunner: GitRunner = async (arguments_) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (arguments_[0] === 'clone') Object.assign(env, await systemProxyEnvironment(env));
  const { stdout } = await execFileAsync('git', arguments_, { env });
  return { stdout };
};

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Acquire exactly the five generated sources at one immutable public commit. A shallow clone of
 * the fixed public address is pinned by a 40-hex commit; every required member must be present and
 * be markerless Markdown with a level-one title. Extras are ignored, and a missing or malformed
 * member rejects so no target can be written from an incomplete snapshot.
 */
export async function resolveTemplateSnapshot(options: { runGit?: GitRunner } = {}): Promise<{
  source: { repository: string; branch: string; commit: string };
  files: Record<string, string>;
}> {
  const git = options.runGit ?? defaultGitRunner;
  const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-source-'));
  try {
    await git(['clone', '--depth', '1', '--branch', branch, sourceUrl, directory]);
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
