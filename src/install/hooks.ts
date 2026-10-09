import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite, exists, writeJson } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { packagePath } from '../utils/schema.js';
import type { Host } from '../workflow/types.js';

export interface SynchronizationDeployment {
  host: Host;
  status: 'installed' | 'trust_required' | 'restart_required' | 'disabled' | 'needs_attention';
  active: boolean;
  warnings: string[];
}

const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse'] as const;
type HookEvent = typeof events[number];
interface HookGroup { hooks: Array<{ type: 'command'; command: string }> }
interface HookRegistration { event: HookEvent; index: number; group: HookGroup }
export type SynchronizationOwnership =
  | { kind: 'configuration'; path: string; entries: HookRegistration[] }
  | { kind: 'plugin'; path: string; digest: string };
export type SynchronizationRecords = Partial<Record<Host, SynchronizationOwnership>>;

const nativePaths: Record<Host, string> = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  opencode: '.config/opencode/plugins/ai-workflow-sync.js',
};
const shadowSkills: Record<Host, string[]> = {
  claude: ['.claude/skills/sync-ai-workflow/SKILL.md'],
  codex: ['.codex/skills/sync-ai-workflow/SKILL.md'],
  opencode: ['.config/opencode/skills/sync-ai-workflow/SKILL.md', '.config/opencode/skill/sync-ai-workflow/SKILL.md', '.claude/skills/sync-ai-workflow/SKILL.md'],
};

function withoutHostRecord(records: SynchronizationRecords, host: Host): SynchronizationRecords {
  return Object.fromEntries(Object.entries(records).filter(([key]) => key !== host)) as SynchronizationRecords;
}

export function synchronizationPath(host: Host): string { return nativePaths[host]; }

function shellQuoted(path: string): string { return `"${path.replace(/["\\$`]/g, '\\$&')}"`; }
function hookCommand(host: Host): string {
  return `${shellQuoted(process.execPath)} ${shellQuoted(packagePath('dist', 'cli.js'))} sync-hook --host ${host}`;
}

function matchingGroupPositions(groups: unknown[], group: HookGroup): number[] {
  return groups.flatMap((candidate, index) => isDeepStrictEqual(candidate, group) ? [index] : []);
}

async function nativeConfig(path: string): Promise<Record<string, unknown> & { hooks?: Record<string, unknown[]> }> {
  if (!(await exists(path))) return {};
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Native hook configuration must be an object: ${path}`);
  const config = value as Record<string, unknown> & { hooks?: Record<string, unknown[]> };
  if (config.hooks !== undefined) {
    if (config.hooks === null || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error(`Invalid native hooks table: ${path}`);
    for (const event of events) if (config.hooks[event] !== undefined && !Array.isArray(config.hooks[event])) throw new Error(`Invalid native hook groups: ${path}:${event}`);
  }
  return config;
}

async function codexHooksDisabled(home: string): Promise<boolean> {
  const path = join(home, '.codex/config.toml');
  if (!(await exists(path))) return false;
  let features = false;
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (heading) features = heading[1]?.trim() === 'features';
    else if (features && /^\s*hooks\s*=\s*false\s*(?:#.*)?$/.test(line)) return true;
  }
  return false;
}

export async function installSynchronization(
  home: string,
  hosts: Host[],
  previous: SynchronizationRecords,
  sharedWarnings: string[],
): Promise<{ records: SynchronizationRecords; reports: SynchronizationDeployment[]; skipped: string[] }> {
  let records = { ...previous };
  const reports: SynchronizationDeployment[] = [];
  const skipped: string[] = [];
  for (const host of hosts) {
    const relativePath = nativePaths[host];
    const path = join(home, relativePath);
    const prior = records[host];
    const warnings = [...sharedWarnings];
    for (const skill of shadowSkills[host]) if (await exists(join(home, skill))) warnings.push(`Existing host-scoped synchronization skill is preserved: ${skill}; resolve it if it shadows the shared safe skill.`);
    let status: SynchronizationDeployment['status'] = host === 'claude' ? 'installed' : host === 'codex' ? 'trust_required' : 'restart_required';
    if (host === 'opencode') {
      warnings.push('Quit and restart OpenCode to load the installed plugin; installation does not prove it is active.');
      const disk = await exists(path) ? await readFile(path) : undefined;
      if (disk !== undefined && (prior?.kind !== 'plugin' || prior.path !== relativePath || sha256(disk) !== prior.digest)) {
        status = 'needs_attention';
        warnings.push(`Unowned or modified plugin is preserved and was not refreshed: ${relativePath}`);
        skipped.push(relativePath);
      } else {
        const template = await readFile(packagePath('templates', 'hooks', 'opencode.js'), 'utf8');
        const contents = template.replace("'__AI_WORKFLOW_NODE__'", () => JSON.stringify(process.execPath)).replace("'__AI_WORKFLOW_CLI__'", () => JSON.stringify(packagePath('dist', 'cli.js')));
        if (disk?.toString('utf8') !== contents) await atomicWrite(path, contents);
        records[host] = { kind: 'plugin', path: relativePath, digest: sha256(contents) };
      }
    } else {
      const config = await nativeConfig(path);
      if ((host === 'claude' && config.disableAllHooks === true) || (host === 'codex' && await codexHooksDisabled(home))) {
        status = 'disabled';
        warnings.push(`Native hooks are disabled in ${host === 'claude' ? relativePath : '.codex/config.toml'}; the disabling configuration was not changed.`);
      } else {
        warnings.push(host === 'codex' ? 'Review and trust the native hooks using /hooks; no trust bypass was applied.' : 'Hooks are installed, but loading in an existing Claude session has not been verified.');
        const hooks = config.hooks ?? {};
        const entries: HookRegistration[] = [];
        let changed = false;
        for (const event of events) {
          const groups = hooks[event] ?? [];
          const owned = prior?.kind === 'configuration' && prior.path === relativePath ? prior.entries.find((entry) => entry.event === event) : undefined;
          const group: HookGroup = { hooks: [{ type: 'command', command: hookCommand(host) }] };
          const matches = owned ? matchingGroupPositions(groups, owned.group) : [];
          if (owned && matches.length > 1) {
            entries.push(owned);
            warnings.push(`Ambiguous owned registration is preserved: ${relativePath}:${event}; multiple groups match the recorded whole group.`);
            skipped.push(relativePath);
            status = 'needs_attention';
            continue;
          }
          if (owned && matches.length === 1) {
            const index = matches[0];
            if (index === undefined) continue;
            if (!isDeepStrictEqual(groups[index], group)) { groups[index] = group; changed = true; }
            entries.push({ event, index, group });
          } else if (owned && groups[owned.index] !== undefined) {
            entries.push(owned);
            warnings.push(`Modified owned registration is preserved: ${relativePath}:${event}[${owned.index}]`);
            skipped.push(relativePath);
            status = 'needs_attention';
            continue;
          } else {
            if (groups.some((entry) => isDeepStrictEqual(entry, group))) {
              warnings.push(`An unowned matching registration is preserved, not adopted: ${relativePath}:${event}; resolve the duplicate explicitly.`);
              skipped.push(relativePath);
              status = 'needs_attention';
              continue;
            }
            entries.push({ event, index: groups.length, group });
            groups.push(group);
            changed = true;
          }
          hooks[event] = groups;
        }
        if (changed) { config.hooks = hooks; await writeJson(path, config); }
        if (entries.length) records[host] = { kind: 'configuration', path: relativePath, entries };
        else records = withoutHostRecord(records, host);
      }
    }
    reports.push({ host, status, active: false, warnings });
  }
  return { records, reports, skipped: [...new Set(skipped)] };
}

export async function uninstallSynchronization(home: string, host: Host, records: SynchronizationRecords, skipped: string[]): Promise<void> {
  const record = records[host];
  if (!record) return;
  const relativePath = nativePaths[host];
  if (record.path !== relativePath) throw new Error(`Unexpected native synchronization ownership path: ${record.path}`);
  const path = join(home, relativePath);
  if (!(await exists(path))) { Reflect.deleteProperty(records, host); return; }
  if (record.kind === 'plugin') {
    if (sha256(await readFile(path)) !== record.digest) { skipped.push(relativePath); return; }
    await rm(path);
    Reflect.deleteProperty(records, host);
    return;
  }
  const config = await nativeConfig(path);
  const retained: HookRegistration[] = [];
  let changed = false;
  for (const entry of record.entries) {
    const groups = config.hooks?.[entry.event] ?? [];
    const matches = matchingGroupPositions(groups, entry.group);
    if (matches.length > 1 || (matches.length === 0 && groups[entry.index] !== undefined)) { retained.push(entry); skipped.push(relativePath); continue; }
    if (matches.length === 0) continue;
    const index = matches[0];
    if (index === undefined) continue;
    groups.splice(index, 1);
    if (groups.length === 0) config.hooks = Object.fromEntries(Object.entries(config.hooks ?? {}).filter(([event]) => event !== entry.event));
    changed = true;
  }
  if (changed) {
    if (config.hooks && Object.keys(config.hooks).length === 0) delete config.hooks;
    await writeJson(path, config);
  }
  if (retained.length) records[host] = { ...record, entries: retained };
  else Reflect.deleteProperty(records, host);
}
