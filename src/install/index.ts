import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { atomicWrite, exists, readJson, writeJson } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { packagePath } from '../utils/schema.js';
import { renderHost, renderSkills, type RenderedFile } from './render.js';
import type { OpencodeVersionOption } from './opencode-version.js';
import { resolveOpencodeVersion } from './opencode-version.js';
import { installSynchronization, synchronizationPath, uninstallSynchronization, type SynchronizationDeployment, type SynchronizationRecords } from './hooks.js';
import { loadProfile, type Profile } from '../profile/index.js';
import { loadSettings, writeActiveProfile } from '../settings/index.js';
import { applyTemplateSnapshot, notesStructureDirectories, reconcileIgnoreFile, type SyncReport } from '../sync/index.js';
import { renderNavigation } from '../context/navigation.js';
import { scanProject } from '../context/discovery/scanner.js';
import { loadProjectConfig } from '../context/discovery/project-config.js';
import { buildNavigation } from '../context/discovery/builder.js';
import { validateNavigationModel } from '../context/validate.js';
import type { Host } from '../workflow/types.js';

interface ManifestFile { path: string; digest: string; kind: 'file' | 'directory' }
export interface ContractRecord { path: string; digest: string; created: boolean }
interface InstallManifest { version: string; installed_at: string; skills?: ManifestFile[]; hosts: Partial<Record<Host, ManifestFile[]>>; contracts?: Partial<Record<Host, ContractRecord>>; sync_hooks?: SynchronizationRecords; synchronization?: SynchronizationDeployment[]; skipped?: string[] }
export interface AgentInstallation {
  name: string;
  path: string;
  model?: string;
  reasoning_effort?: string;
}
export interface HostInstallation {
  host: Host;
  agents_directory: string;
  agents: AgentInstallation[];
}
export interface ProfileActivationReport {
  active_profile: string;
  hosts: Host[];
  installations: HostInstallation[];
}
const manifestRelative = '.config/ai-workflow/install-manifest.json';
const settingsRelative = '.config/ai-workflow/config.yaml';
const navigationJsonRelative = '.ai-workflow/index/navigation.json';
const navigationMarkdownRelative = '.ai-workflow/index/navigation.md';
const marketplaceRelative = '.agents/plugins/marketplace.json';
const skillsRelative = '.agents/skills';
const projectTemplates = ['MEMORY.md', 'navigation.json', 'navigation.md', 'AGENTS.md', 'notes/AGENTS.md', 'notes/README.md', 'notes/implemented/AGENTS.md', 'notes/archived/AGENTS.md', 'notes/archived/manifest.json'] as const;
const contractBegin = '<!-- ai-workflow:begin -->';
const contractEnd = '<!-- ai-workflow:end -->';
const globalInstructionRelative: Record<Host, string> = { opencode: '.config/opencode/AGENTS.md', claude: '.claude/CLAUDE.md', codex: '.codex/AGENTS.md' };
function projectTargets(): Array<{ source: string; target: string }> {
  return projectTemplates.map((name) => ({ source: join('templates/project', name), target: name === 'MEMORY.md' ? name : name === 'navigation.json' || name === 'navigation.md' ? `.ai-workflow/index/${name}` : `.ai-workflow/${name}` }));
}
async function readTemplateContents(targets: Array<{ source: string; target: string }>): Promise<Array<{ target: string; contents: string }>> {
  return Promise.all(targets.map(async ({ source, target }) => ({ target, contents: await readFile(new URL(`../../${source}`, import.meta.url), 'utf8') })));
}
async function projectTemplateContents(): Promise<Array<{ target: string; contents: string }>> {
  return readTemplateContents(projectTargets());
}
function agentsRoot(home: string, host: Host): string {
  if (host === 'codex') return join(home, '.codex/agents');
  if (host === 'claude') return join(home, '.claude/agents');
  return join(home, '.config/opencode/agents');
}
function skillsRoot(home: string): string { return join(home, skillsRelative); }

async function writeOwnedFile(home: string, file: RenderedFile, previous: ManifestFile[] | undefined, root: string, snapshots: Map<string, Buffer | undefined>, newDirectories: Set<string>): Promise<boolean> {
  const path = join(root, file.relativePath);
  const owned = previous?.find((item) => item.path === relative(home, path));
  if (owned && (await exists(path)) && sha256(await readFile(path)) !== owned.digest) return false;
  await snapshotInstallationPath(path, snapshots, newDirectories);
  await atomicWrite(path, file.contents);
  return true;
}

async function readManifest(home: string): Promise<InstallManifest> {
  const path = join(home, manifestRelative); return await exists(path) ? readJson<InstallManifest>(path) : { version: '1', installed_at: new Date(0).toISOString(), hosts: {} };
}

function settingsConfigPath(home: string): string { return join(home, settingsRelative); }

async function readIfExists(path: string): Promise<Buffer | undefined> { return (await exists(path)) ? readFile(path) : undefined; }
async function restoreIfChanged(path: string, contents: Buffer | undefined): Promise<void> {
  if (contents === undefined) await rm(path, { force: true }); else await atomicWrite(path, contents);
}

async function snapshotInstallationPath(path: string, snapshots: Map<string, Buffer | undefined>, newDirectories: Set<string>): Promise<void> {
  if (snapshots.has(path)) return;
  snapshots.set(path, await readIfExists(path));
  let directory = dirname(path);
  while (!(await exists(directory))) {
    newDirectories.add(directory);
    directory = dirname(directory);
  }
}

// Legacy migration: previous versions recorded the Codex plugin in the shared marketplace.
// ai-workflow no longer ships a Codex plugin, so strip only its own entry and leave other entries intact.
async function removeMarketplaceEntry(home: string): Promise<void> {
  const path = join(home, marketplaceRelative);
  if (!(await exists(path))) return;
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { return; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const content = parsed as Record<string, unknown>;
  if (!Array.isArray(content.plugins)) return;
  const retained = content.plugins.filter((entry) => !(entry && typeof entry === 'object' && (entry as Record<string, unknown>).name === 'ai-workflow'));
  if (retained.length === content.plugins.length) return;
  content.plugins = retained;
  await writeJson(path, content);
}

async function removeStaleOwnedFiles(home: string, previous: ManifestFile[], current: ManifestFile[]): Promise<void> {
  const retained = new Set(current.map((file) => file.path));
  for (const file of previous) {
    if (retained.has(file.path) || file.path === marketplaceRelative) continue;
    const path = resolve(home, file.path);
    if (!path.startsWith(`${home}/`)) throw new Error(`Unsafe manifest path: ${file.path}`);
    if (file.kind === 'file' && (await exists(path)) && sha256(await readFile(path)) !== file.digest) continue;
    await rm(path, { recursive: file.kind === 'directory', force: true });
  }
}

function globalInstructionPath(home: string, host: Host): string { return join(home, globalInstructionRelative[host]); }

function countOccurrences(haystack: string, needle: string): number {
  let count = 0; let index = haystack.indexOf(needle);
  while (index !== -1) { count += 1; index = haystack.indexOf(needle, index + needle.length); }
  return count;
}

interface ContractBlock { begin: number; end: number; blockText: string }
function locateContractBlock(contents: string): ContractBlock | undefined {
  if (countOccurrences(contents, contractBegin) !== 1 || countOccurrences(contents, contractEnd) !== 1) return undefined;
  const begin = contents.indexOf(contractBegin); const end = contents.indexOf(contractEnd);
  if (begin > end) return undefined;
  return { begin, end, blockText: contents.slice(begin, end + contractEnd.length) };
}
function hasAnyContractMarker(contents: string): boolean { return contents.includes(contractBegin) || contents.includes(contractEnd); }
function contractBlockText(template: string): string { return `${contractBegin}\n${template}${contractEnd}`; }

async function installContracts(home: string, hosts: Host[], manifest: InstallManifest, skipped: string[]): Promise<void> {
  const template = await readFile(packagePath('templates', 'contract', 'AGENTS.md'), 'utf8');
  const current = contractBlockText(template); const currentDigest = sha256(current);
  const contracts: Partial<Record<Host, ContractRecord>> = manifest.contracts ?? {};
  for (const host of hosts) {
    const path = globalInstructionPath(home, host); const relativePath = relative(home, path); const prior = contracts[host];
    const disk = (await exists(path)) ? await readFile(path, 'utf8') : undefined;
    if (disk === undefined) {
      await atomicWrite(path, `${current}\n`);
      contracts[host] = { path: relativePath, digest: currentDigest, created: true };
      continue;
    }
    const block = locateContractBlock(disk);
    if (block) {
      if (prior && prior.digest !== sha256(block.blockText)) { skipped.push(relativePath); continue; }
      await atomicWrite(path, disk.slice(0, block.begin) + current + disk.slice(block.end + contractEnd.length));
      contracts[host] = { path: relativePath, digest: currentDigest, created: false };
      continue;
    }
    if (hasAnyContractMarker(disk)) { skipped.push(relativePath); continue; }
    const separator = disk === '' || disk.endsWith('\n') ? '' : '\n';
    await atomicWrite(path, `${disk}${separator}${current}\n`);
    contracts[host] = { path: relativePath, digest: currentDigest, created: false };
  }
  if (Object.keys(contracts).length) manifest.contracts = contracts; else delete manifest.contracts;
}

async function installUnsafe(hosts: Host[], options: { home?: string; version?: string; profile?: Profile; opencodeVersion?: OpencodeVersionOption }, snapshots: Map<string, Buffer | undefined>, newDirectories: Set<string>): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const version = options.version ?? '0.1.0'; const manifest = await readManifest(home);
  // Resolve settings once before any render or write so an invalid active_profile aborts pre-write.
  const settings = await loadSettings(home);
  const explicit = options.profile;
  const profile = explicit ?? (settings.active_profile ? await loadProfile(home, settings.active_profile) : undefined);
  const opencodeVersion = hosts.includes('opencode') ? await resolveOpencodeVersion(options.opencodeVersion ?? 'v2') : 'v2';
  // Shared skills are host-neutral and installed once, independent of the requested host list.
  const skills = await renderSkills();
  const ownedSkills: ManifestFile[] = []; const skipped: string[] = [];
  const sharedSyncSkill = `${skillsRelative}/sync-ai-workflow/SKILL.md`;
  const priorSyncSkill = manifest.skills?.find((file) => file.path === sharedSyncSkill);
  const preserveSyncSkill = await exists(join(home, sharedSyncSkill)) && (!priorSyncSkill || sha256(await readFile(join(home, sharedSyncSkill))) !== priorSyncSkill.digest);
  for (const file of skills) {
    const path = join(skillsRoot(home), file.relativePath);
    if (preserveSyncSkill && file.relativePath.startsWith('sync-ai-workflow/')) {
      const prior = manifest.skills?.find((item) => item.path === relative(home, path));
      if (prior) ownedSkills.push(prior);
      skipped.push(relative(home, path));
      continue;
    }
    if (await writeOwnedFile(home, file, manifest.skills, skillsRoot(home), snapshots, newDirectories)) ownedSkills.push({ path: relative(home, path), digest: sha256(file.contents), kind: 'file' }); else { const prior = manifest.skills?.find((item) => item.path === relative(home, path)); if (prior) { ownedSkills.push(prior); skipped.push(prior.path); } }
  }
  await removeStaleOwnedFiles(home, manifest.skills ?? [], ownedSkills);
  manifest.skills = ownedSkills;
  const renderedHosts = new Map<Host, RenderedFile[]>(); for (const host of hosts) renderedHosts.set(host, await renderHost(host, profile, host === 'opencode' ? { opencodeVersion } : undefined));
  for (const host of hosts) {
    const rendered = renderedHosts.get(host); if (!rendered) throw new Error(`Missing rendered host: ${host}`);
    const target = agentsRoot(home, host);
    const owned: ManifestFile[] = [];
    for (const file of rendered) { const path = join(target, file.relativePath); if (await writeOwnedFile(home, file, manifest.hosts[host], target, snapshots, newDirectories)) owned.push({ path: relative(home, path), digest: sha256(file.contents), kind: 'file' }); else { const prior = manifest.hosts[host]?.find((item) => item.path === relative(home, path)); if (prior) { owned.push(prior); skipped.push(prior.path); } } }
    if (host === 'codex') await removeMarketplaceEntry(home);
    await removeStaleOwnedFiles(home, manifest.hosts[host] ?? [], owned);
    manifest.hosts[host] = owned;
  }
  await installContracts(home, hosts, manifest, skipped);
  const synchronization = await installSynchronization(home, hosts, manifest.sync_hooks ?? {}, preserveSyncSkill ? [`Existing shared synchronization skill is preserved: ${sharedSyncSkill}; resolve it explicitly before installing the shared safe skill.`] : []);
  manifest.sync_hooks = synchronization.records;
  manifest.synchronization = synchronization.reports;
  skipped.push(...synchronization.skipped);
  manifest.version = version; manifest.installed_at = new Date().toISOString(); if (skipped.length) manifest.skipped = skipped; else delete manifest.skipped; await writeJson(join(home, manifestRelative), manifest);
  return manifest;
}

export async function install(hosts: Host[], options: { home?: string; version?: string; profile?: Profile; opencodeVersion?: OpencodeVersionOption } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir());
  const snapshots = new Map<string, Buffer | undefined>();
  const newDirectories = new Set<string>();
  for (const path of [join(home, manifestRelative), settingsConfigPath(home), ...hosts.flatMap((host) => [globalInstructionPath(home, host), join(home, synchronizationPath(host))])]) await snapshotInstallationPath(path, snapshots, newDirectories);
  try { return await installUnsafe(hosts, options, snapshots, newDirectories); } catch (error) {
    for (const [path, contents] of [...snapshots].reverse()) await restoreIfChanged(path, contents);
    for (const directory of [...newDirectories].sort((left, right) => right.length - left.length)) await removeEmptyDirectory(directory);
    throw error;
  }
}

export async function getActiveProfile(home: string): Promise<string | undefined> {
  return (await loadSettings(resolve(home))).active_profile;
}

function profileInstallations(home: string, hosts: Host[], manifest: InstallManifest, profile: Profile): HostInstallation[] {
  return hosts.map((host) => {
    const agentsDirectory = agentsRoot(home, host);
    const agents = (manifest.hosts[host] ?? []).flatMap((file): AgentInstallation[] => {
      const path = resolve(home, file.path);
      if (file.kind !== 'file' || dirname(path) !== agentsDirectory) return [];
      const agentName = basename(path, extname(path));
      const settings = profile.agents[agentName]?.[host];
      return [{
        name: agentName,
        path,
        ...(settings ? { model: settings.model, reasoning_effort: settings.reasoning_effort } : {})
      }];
    });
    return { host, agents_directory: agentsDirectory, agents };
  });
}

export async function activateProfile(name: string, options: { home?: string; version?: string; opencodeVersion?: OpencodeVersionOption } = {}): Promise<ProfileActivationReport> {
  const home = resolve(options.home ?? homedir()); const profile = await loadProfile(home, name);
  // Validate the existing configuration before any mutation so an illegal active_profile aborts pre-write.
  await loadSettings(home);
   const manifest = await readManifest(home);
   const hosts = ['codex', 'claude', 'opencode'] as Host[];
   const reportedHosts = hosts.filter((host) => (manifest.hosts[host] ?? []).length > 0);
  for (const host of hosts) for (const file of manifest.hosts[host] ?? []) {
    const path = resolve(home, file.path);
    if (file.kind === 'file' && await exists(path) && sha256(await readFile(path)) !== file.digest) throw new Error(`Cannot activate profile because managed file was modified: ${file.path}`);
  }
  const snapshots = await Promise.all(hosts.flatMap((host) => (manifest.hosts[host] ?? []).filter((file) => file.kind === 'file').map(async (file) => ({ path: resolve(home, file.path), contents: await readFile(resolve(home, file.path)) }))));
  const configPath = settingsConfigPath(home); const manifestPath = join(home, manifestRelative);
  const configBefore = await readIfExists(configPath); const manifestBefore = await readIfExists(manifestPath);
  try {
    const installed = hosts.length ? await install(hosts, { home, version: options.version ?? manifest.version, profile, ...(options.opencodeVersion ? { opencodeVersion: options.opencodeVersion } : {}) }) : manifest;
    await writeActiveProfile(home, name);
     return { active_profile: name, hosts: reportedHosts, installations: profileInstallations(home, reportedHosts, installed, profile) };
  } catch (error) {
    for (const snapshot of snapshots) await atomicWrite(snapshot.path, snapshot.contents);
    await restoreIfChanged(configPath, configBefore);
    await restoreIfChanged(manifestPath, manifestBefore);
    throw error;
  }
}

async function uninstallContracts(home: string, host: Host, manifest: InstallManifest, skipped: string[]): Promise<void> {
  const contracts = manifest.contracts; const record = contracts?.[host];
  if (!contracts || !record) return;
  const path = resolve(home, record.path);
  if (!path.startsWith(`${home}/`)) throw new Error(`Unsafe manifest path: ${record.path}`);
  const disk = (await exists(path)) ? await readFile(path, 'utf8') : undefined;
  if (disk === undefined) { Reflect.deleteProperty(contracts, host); return; }
  const block = locateContractBlock(disk);
  if (!block) { Reflect.deleteProperty(contracts, host); return; }
  if (sha256(block.blockText) !== record.digest) { skipped.push(record.path); return; }
  const remaining = disk.slice(0, block.begin) + disk.slice(block.end + contractEnd.length);
  if (record.created && remaining.trim() === '') await rm(path, { force: true });
  else await atomicWrite(path, remaining);
  Reflect.deleteProperty(contracts, host);
}

export async function uninstall(hosts: Host[], options: { home?: string } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const manifest = await readManifest(home);
  const skipped: string[] = [];
  for (const host of hosts) {
    if (manifest.sync_hooks) await uninstallSynchronization(home, host, manifest.sync_hooks, skipped);
    for (const file of manifest.hosts[host] ?? []) {
      const path = resolve(home, file.path); if (!path.startsWith(`${home}/`)) throw new Error(`Unsafe manifest path: ${file.path}`);
      if (file.path === marketplaceRelative) continue;
      if (file.kind === 'file' && (await exists(path)) && sha256(await readFile(path)) !== file.digest) { skipped.push(file.path); continue; }
      await rm(path, { recursive: file.kind === 'directory', force: true });
    }
    await uninstallContracts(home, host, manifest, skipped);
    if (host === 'codex') await removeMarketplaceEntry(home);
    const retained = (manifest.hosts[host] ?? []).filter((file) => skipped.includes(file.path));
    manifest.hosts = Object.fromEntries(Object.entries(manifest.hosts).filter(([key]) => key !== host)) as InstallManifest['hosts'];
    if (retained.length) manifest.hosts[host] = retained;
  }
  if (manifest.contracts && Object.keys(manifest.contracts).length === 0) delete manifest.contracts;
  if (manifest.sync_hooks && Object.keys(manifest.sync_hooks).length === 0) delete manifest.sync_hooks;
  if (manifest.synchronization) {
    manifest.synchronization = manifest.synchronization.filter((entry) => !hosts.includes(entry.host));
    if (manifest.synchronization.length === 0) delete manifest.synchronization;
  }
  if (Object.keys(manifest.hosts).length === 0) {
    for (const file of manifest.skills ?? []) {
      const path = resolve(home, file.path); if (!path.startsWith(`${home}/`)) throw new Error(`Unsafe manifest path: ${file.path}`);
       if (file.kind === 'file' && (await exists(path)) && sha256(await readFile(path)) !== file.digest) { skipped.push(file.path); continue; }
       await rm(path, { recursive: file.kind === 'directory', force: true });
    }
    if (skipped.length) manifest.skills = (manifest.skills ?? []).filter((file) => skipped.includes(file.path));
    else delete manifest.skills;
  }
  if (skipped.length) manifest.skipped = skipped; else delete manifest.skipped;
  await writeJson(join(home, manifestRelative), manifest); return manifest;
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try { await rmdir(path); } catch { /* missing or not empty */ }
}

export async function initializeProject(project: string): Promise<string[]> {
  const root = resolve(project);
  const templates = await projectTemplateContents();
  const conflicts: Array<{ target: string; contents: string }> = [];
  for (const item of templates) if (await exists(join(root, item.target))) conflicts.push(item);
  if (conflicts.length) throw new Error(`Initialization conflicts; no files written. Merge these templates manually:\n${conflicts.map((item) => `${item.target}\n--- proposed ---\n${item.contents}`).join('\n')}`);

  const requiredDirectories = ['.ai-workflow', '.ai-workflow/index', ...notesStructureDirectories()];
  const directoryConflicts: string[] = [];
  for (const target of requiredDirectories) {
    try {
      if (!(await stat(join(root, target))).isDirectory()) directoryConflicts.push(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (directoryConflicts.length) throw new Error(`Initialization conflicts; no files written. Required directories are occupied by non-directories:\n${directoryConflicts.join('\n')}`);

  const facts = await scanProject(root);
  const configResult = await loadProjectConfig(root, facts.files);
  if (configResult.errors.length) throw new Error(configResult.errors.join('\n'));
  const { index } = await buildNavigation(root, facts, configResult.config);
  const validation = await validateNavigationModel(root, index);
  if (!validation.valid) throw new Error(validation.errors.join('\n'));

  const proposed = new Map(templates.map((item) => [item.target, item.contents]));
  proposed.set(navigationJsonRelative, `${JSON.stringify(index, null, 2)}\n`);
  proposed.set(navigationMarkdownRelative, renderNavigation(index));
  const published = projectTargets().map(({ target }) => ({ target, contents: proposed.get(target) as string }));

  const ignorePath = join(root, '.gitignore');
  const ignoreExisted = await exists(ignorePath);
  const ignoreOriginal = ignoreExisted ? await readFile(ignorePath, 'utf8') : '';
  const indexDirectory = join(root, '.ai-workflow/index');
  const aiWorkflowDirectory = join(root, '.ai-workflow');
  const indexDirectoryExisted = await exists(indexDirectory);
  const aiWorkflowDirectoryExisted = await exists(aiWorkflowDirectory);
  const notesDirectories = notesStructureDirectories();
  const newNotesDirectories: string[] = [];
  for (const directory of notesDirectories) if (!(await exists(join(root, directory)))) newNotesDirectories.push(directory);
  const created: string[] = [];
  // Registered before each write so a failure after rename has committed still reclaims the file.
  const writtenFiles: string[] = [];
  try {
    for (const directory of newNotesDirectories) {
      await mkdir(join(root, directory), { recursive: true });
      created.push(directory);
    }
    for (const item of published) {
      const path = join(root, item.target);
      writtenFiles.push(path);
      await atomicWrite(path, item.contents);
      created.push(item.target);
    }
    const ignoreContents = reconcileIgnoreFile(ignoreOriginal);
    if (ignoreContents !== undefined) { await atomicWrite(ignorePath, ignoreContents); created.push('.gitignore'); }
  } catch (error) {
    for (const path of writtenFiles) await rm(path, { force: true });
    if (ignoreExisted) await writeFile(ignorePath, ignoreOriginal);
    else await rm(ignorePath, { force: true });
    if (!indexDirectoryExisted) await removeEmptyDirectory(indexDirectory);
    for (const directory of [...newNotesDirectories].reverse()) await removeEmptyDirectory(join(root, directory));
    if (!aiWorkflowDirectoryExisted) await removeEmptyDirectory(aiWorkflowDirectory);
    throw error;
  }
  return created;
}

export type ProjectUpgradeReport = SyncReport & {
  conflicts: Array<SyncReport['conflicts'][number] & { line?: number; originalLine?: string }>;
};

// Retired ADR instructions only: the command, its path or numbered references, or an imperative rule that
// still tells agents to create/read/use ADRs. Descriptive history is not scanned because ADR files are never read here.
function retiredAdrInstruction(line: string): boolean {
  if (!/\badrs?\b/i.test(line)) return false;
  // Only affirmative rules conflict. Text that forbids ADRs or merely describes preserved history
  // (negation cues in either language) is a guideline, not a rule that still requires ADRs.
  if (/\b(?:not|never|no longer|without)\b/i.test(line)) return false;
  if (/不得|不要|不再|无需|禁止/.test(line)) return false;
  if (/\bai-workflow\s+adr\b/i.test(line) || /\.ai-workflow\/adr\b/i.test(line) || /\bADR-\d+/i.test(line)) return true;
  return /\b(create|read|write|list|maintain|record|supersede|superseded|accept|accepted|use|require|required|must|should)\b/i.test(line)
    || /创建|读取|写入|记录|维护|新增|使用|必须|应当|需要/.test(line);
}

export async function upgradeProject(project: string): Promise<ProjectUpgradeReport> {
  const root = resolve(project);
  const conflicts: ProjectUpgradeReport['conflicts'] = [];
  for (const path of ['.ai-workflow', 'MEMORY.md', navigationJsonRelative, navigationMarkdownRelative]) {
    try {
      const entry = await stat(join(root, path));
      if (path === '.ai-workflow' ? !entry.isDirectory() : !entry.isFile()) conflicts.push({ path, reason: 'Upgrade prerequisite has an invalid filesystem type' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      conflicts.push({ path, reason: 'Upgrade prerequisite is missing; no files written' });
    }
  }
  const source = { repository: 'hengboy/ai-workflow', branch: 'main', commit: null };
  if (!conflicts.length) {
    // Rule files only: never read or convert `.ai-workflow/adr/` history.
    for (const file of ['MEMORY.md', '.ai-workflow/AGENTS.md']) {
      const path = join(root, file);
      if (!(await exists(path))) continue;
      if (!(await stat(path)).isFile()) continue;
      (await readFile(path, 'utf8')).split(/\r?\n/).forEach((line, index) => {
        if (retiredAdrInstruction(line)) {
          conflicts.push({ path: file, line: index + 1, originalLine: line,
            reason: `Existing rules still require ADRs; merge them explicitly before upgrading: ${file}:${index + 1}: ${line.trim()}` });
        }
      });
    }
  }
  if (conflicts.length) {
    return { project: root, source, status: 'conflict', verified: false, proceed: false, check: false,
      created: [], updated: [], skipped: [], warnings: [], conflicts: conflicts.sort((left, right) => {
        const leftPath = left.path ?? '';
        const rightPath = right.path ?? '';
        return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
      }) };
  }
  const targets = projectTargets();
  const templates = await readTemplateContents(targets);
  const files = Object.fromEntries(targets.map(({ source: path }, index) => {
    const template = templates[index];
    if (template === undefined) throw new Error(`Missing project template: ${path}`);
    return [path.replace(/\\/g, '/'), template.contents];
  }));
  return applyTemplateSnapshot({ projectRoot: root }, { source, files });
}
