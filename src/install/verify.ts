import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from '../utils/hash.js';
import type { Host } from '../workflow/types.js';

export type InstallationCheckStatus = 'pass' | 'warn' | 'fail';

export interface InstallationCheck {
  id: string;
  status: InstallationCheckStatus;
  detail: string;
  recovery?: string;
}

export interface InstallationReport {
  home: string;
  valid: boolean;
  checks: InstallationCheck[];
}

interface ManifestFile { path: string; digest: string; kind: 'file' | 'directory' }
interface ContractRecord { path: string; digest: string; created: boolean }
interface HookGroup { hooks: Array<{ type: 'command'; command: string }> }
interface HookRegistration { event: string; index: number; group: HookGroup }
type SynchronizationOwnership =
  | { kind: 'configuration'; path: string; entries: HookRegistration[] }
  | { kind: 'plugin'; path: string; digest: string };
interface InstallManifest {
  skills?: ManifestFile[];
  hosts: Partial<Record<Host, ManifestFile[]>>;
  contracts?: Partial<Record<Host, ContractRecord>>;
  sync_hooks?: Partial<Record<Host, SynchronizationOwnership>>;
}

const hosts: Host[] = ['codex', 'claude', 'opencode'];
const manifestRelative = '.config/ai-workflow/install-manifest.json';
const sharedSkillsRelative = '.agents/skills';
const contractBegin = '<!-- ai-workflow:begin -->';
const contractEnd = '<!-- ai-workflow:end -->';
const hostSkillsLinks: Partial<Record<Host, string>> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  opencode: '.config/opencode/skills',
};

function check(id: string, status: InstallationCheckStatus, detail: string, recovery?: string): InstallationCheck {
  return { id, status, detail, ...(recovery === undefined ? {} : { recovery }) };
}

function installRecovery(home: string): string {
  return `ai-workflow install --host all --home "${home}"`;
}

function insideHome(home: string, path: string): boolean {
  const location = relative(home, path);
  return location !== '..' && !location.startsWith('../') && !isAbsolute(location);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function locateContractBlock(contents: string): { blockText: string } | undefined {
  if (countOccurrences(contents, contractBegin) !== 1 || countOccurrences(contents, contractEnd) !== 1) return undefined;
  const begin = contents.indexOf(contractBegin);
  const end = contents.indexOf(contractEnd);
  if (begin > end) return undefined;
  return { blockText: contents.slice(begin, end + contractEnd.length) };
}

async function readManifest(home: string): Promise<{ manifest: InstallManifest } | { error: string }> {
  const path = join(home, manifestRelative);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: `${manifestRelative} (${path}) must contain a JSON object` };
    return { manifest: parsed as InstallManifest };
  } catch (error) {
    return { error: `${manifestRelative} (${path}) is not readable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function verifyFile(home: string, file: ManifestFile, checks: InstallationCheck[], recovery: string): Promise<void> {
  const path = resolve(home, file.path);
  const id = `install.file.${file.path}`;
  if (!insideHome(home, path)) {
    checks.push(check(id, 'fail', `Managed path escapes the installation root: ${file.path} (${path}).`, recovery));
    return;
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    checks.push(check(id, 'fail', `Managed ${file.kind} is missing: ${file.path} (${path}); expected ${file.digest}.`, recovery));
    return;
  }
  if (file.kind === 'directory') {
    checks.push(info.isDirectory()
      ? check(id, 'pass', `Managed directory exists: ${file.path} (${path}).`)
      : check(id, 'fail', `Managed directory is not a directory: ${file.path} (${path}).`, recovery));
    return;
  }
  if (!info.isFile()) {
    checks.push(check(id, 'fail', `Managed file is not a regular file: ${file.path} (${path}).`, recovery));
    return;
  }
  const actual = sha256(await readFile(path));
  checks.push(actual === file.digest
    ? check(id, 'pass', `Managed file digest matches: ${file.path} (${file.digest}).`)
    : check(id, 'fail', `Managed file differs from its recorded digest: ${file.path} (${path}); expected ${file.digest}, actual ${actual}.`, recovery));
}

async function verifyContract(home: string, host: Host, record: ContractRecord, checks: InstallationCheck[], recovery: string): Promise<void> {
  const path = resolve(home, record.path);
  const id = `install.contract.${host}`;
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    checks.push(check(id, 'fail', `Managed contract entry is missing: ${record.path} (${path}); expected ${record.digest}.`, recovery));
    return;
  }
  const block = locateContractBlock(contents);
  if (block === undefined) {
    checks.push(check(id, 'fail', `Managed contract entry has no unique ai-workflow block: ${record.path} (${path}).`, recovery));
    return;
  }
  const actual = sha256(block.blockText);
  checks.push(actual === record.digest
    ? check(id, 'pass', `Managed contract block digest matches: ${record.path} (${record.digest}).`)
    : check(id, 'fail', `Managed contract block differs from its recorded digest: ${record.path} (${path}); expected ${record.digest}, actual ${actual}.`, recovery));
}

function matchingGroupPositions(groups: unknown[], group: HookGroup): number[] {
  return groups.flatMap((candidate, index) => isDeepStrictEqual(candidate, group) ? [index] : []);
}

async function codexHooksDisabled(home: string): Promise<{ disabled: boolean; path: string }> {
  const path = join(home, '.codex/config.toml');
  try {
    let features = false;
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
      const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (heading) features = heading[1]?.trim() === 'features';
      else if (features && /^\s*hooks\s*=\s*false\s*(?:#.*)?$/.test(line)) return { disabled: true, path };
    }
  } catch {
    return { disabled: false, path };
  }
  return { disabled: false, path };
}

async function verifySynchronization(
  home: string,
  host: Host,
  record: SynchronizationOwnership | undefined,
  checks: InstallationCheck[],
  recovery: string,
): Promise<void> {
  const id = `install.sync.${host}`;
  if (record === undefined) {
    checks.push(check(id, 'fail', `Synchronization ownership is missing for ${host} under ${home}.`, recovery));
    return;
  }
  const path = resolve(home, record.path);
  if (record.kind === 'plugin') {
    let contents: Buffer;
    try {
      contents = await readFile(path);
    } catch {
      checks.push(check(id, 'fail', `Owned plugin is missing: ${record.path} (${path}); expected ${record.digest}.`, recovery));
      return;
    }
    const actual = sha256(contents);
    checks.push(actual === record.digest
      ? check(id, 'pass', `Owned plugin digest matches: ${record.path} (${record.digest}).`)
      : check(id, 'fail', `Owned plugin differs from its recorded digest: ${record.path} (${path}); expected ${record.digest}, actual ${actual}.`, recovery));
    return;
  }
  let config: Record<string, unknown> & { hooks?: Record<string, unknown[]> };
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
    config = parsed as Record<string, unknown> & { hooks?: Record<string, unknown[]> };
  } catch (error) {
    checks.push(check(id, 'fail', `Owned hook configuration is unreadable: ${record.path} (${path}): ${error instanceof Error ? error.message : String(error)}`, recovery));
    return;
  }
  const disabled = host === 'claude'
    ? config.disableAllHooks === true
    : host === 'codex' && (await codexHooksDisabled(home)).disabled;
  if (disabled) {
    const disabledPath = host === 'codex' ? join(home, '.codex/config.toml') : path;
    checks.push(check(`install.hooks-disabled.${host}`, 'warn', `Native hooks are disabled by user configuration in ${relative(home, disabledPath)} (${disabledPath}); the disabling configuration was not changed.`, recovery));
  }
  for (const entry of record.entries) {
    const groups = config.hooks?.[entry.event];
    const matches = Array.isArray(groups) ? matchingGroupPositions(groups, entry.group) : [];
    const entryId = `install.hook.${host}.${entry.event}.${entry.index}`;
    if (matches.length === 1) {
      checks.push(check(entryId, 'pass', `Hook registration ${entry.event} is present.`));
    } else if (matches.length > 1) {
      checks.push(check(entryId, 'warn', `Hook registration ${entry.event} is ambiguous in ${record.path} (${path}); multiple groups match the recorded group.`, recovery));
    } else {
      checks.push(check(entryId, 'fail', `Hook registration ${entry.event} is missing or changed in ${record.path} (${path}).`, recovery));
    }
  }
}

async function verifySkillsLink(home: string, host: Host, checks: InstallationCheck[]): Promise<void> {
  const linkRelative = hostSkillsLinks[host];
  if (linkRelative === undefined) return;
  const path = join(home, linkRelative);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return;
  }
  if (!info.isSymbolicLink()) return;
  const expectedPath = join(home, sharedSkillsRelative);
  let expected: string;
  try {
    expected = await realpath(expectedPath);
  } catch {
    expected = expectedPath;
  }
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    checks.push(check(`install.skills-link.${host}`, 'fail', `Host-scoped skills link ${linkRelative} (${path}) is broken; expected it to resolve to ${sharedSkillsRelative} (${expectedPath}).`, `ln -sfn ../.agents/skills "${path}"`));
    return;
  }
  checks.push(resolved === expected
    ? check(`install.skills-link.${host}`, 'pass', `Host-scoped skills link ${linkRelative} resolves to ${sharedSkillsRelative} (${expected}).`)
    : check(`install.skills-link.${host}`, 'fail', `Host-scoped skills link ${linkRelative} (${path}) resolves to ${resolved}; expected ${sharedSkillsRelative} (${expected}).`, `ln -sfn ../.agents/skills "${path}"`));
}

/**
 * Verify installation integrity without repairing anything: recorded file digests, contract
 * blocks, plugin and hook ownership, disabled hook configuration and host-scoped shared-skill
 * link identity. The check ids are stable and each fault names the exact path, identity or SHA.
 */
export async function verifyInstallation(home: string, targetHosts?: Host[]): Promise<InstallationReport> {
  const root = resolve(home);
  const checks: InstallationCheck[] = [];
  const recovery = installRecovery(root);
  const read = await readManifest(root);
  if ('error' in read) {
    checks.push(check('install.manifest', 'fail', `Installation manifest is invalid: ${read.error}.`, recovery));
    return { home: root, valid: false, checks };
  }
  const manifest = read.manifest;
  checks.push(check('install.manifest', 'pass', `Installation manifest is readable: ${relative(root, join(root, manifestRelative))} (${join(root, manifestRelative)}).`));

  for (const file of manifest.skills ?? []) await verifyFile(root, file, checks, recovery);

  const recorded = hosts.filter((host) => (manifest.hosts[host]?.length ?? 0) > 0 || manifest.sync_hooks?.[host] !== undefined || manifest.contracts?.[host] !== undefined);
  const selected = targetHosts ?? recorded;
  for (const host of selected) {
    const files = manifest.hosts[host] ?? [];
    const contract = manifest.contracts?.[host];
    const synchronization = manifest.sync_hooks?.[host];
    if (files.length === 0 && contract === undefined && synchronization === undefined) {
      checks.push(check(`install.host.${host}`, 'fail', `Host ${host} is not installed under ${root}.`, `ai-workflow install --host ${host} --home "${root}"`));
      continue;
    }
    for (const file of files) await verifyFile(root, file, checks, recovery);
    if (contract === undefined) checks.push(check(`install.contract.${host}`, 'fail', `Managed contract ownership is missing for ${host} under ${root}.`, recovery));
    else await verifyContract(root, host, contract, checks, recovery);
    await verifySynchronization(root, host, synchronization, checks, recovery);
    await verifySkillsLink(root, host, checks);
  }

  return { home: root, valid: !checks.some((entry) => entry.status === 'fail'), checks };
}
