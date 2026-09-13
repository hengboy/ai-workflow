import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { atomicWrite, exists, readJson, writeJson } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { renderHost, renderSkills, type RenderedFile } from './render.js';
import { loadProfile, type Profile } from '../profile/index.js';
import { loadOutputLanguage } from '../settings/index.js';
import { renderNavigation } from '../context/navigation.js';
import { scanProject } from '../context/discovery/scanner.js';
import { loadProjectConfig } from '../context/discovery/project-config.js';
import { buildNavigation } from '../context/discovery/builder.js';
import { validateNavigationModel } from '../context/validate.js';
import type { Host } from '../workflow/types.js';

interface ManifestFile { path: string; digest: string; kind: 'file' | 'directory' }
interface InstallManifest { version: string; installed_at: string; skills?: ManifestFile[]; hosts: Partial<Record<Host, ManifestFile[]>>; skipped?: string[] }
interface ProjectManifest { version: 1; files: Record<string, string> }
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
const activeProfileRelative = '.config/ai-workflow/active-profile';
const projectManifestRelative = '.ai-workflow/project-manifest.json';
const navigationJsonRelative = '.ai-workflow/index/navigation.json';
const navigationMarkdownRelative = '.ai-workflow/index/navigation.md';
const marketplaceRelative = '.agents/plugins/marketplace.json';
const skillsRelative = '.agents/skills';
const projectTemplates = ['AGENTS.md', 'CLAUDE.md', 'MEMORY.md', 'navigation.json', 'navigation.md'] as const;
function projectTargets(): Array<{ source: string; target: string }> {
  return projectTemplates.map((name) => ({ source: join('templates/project', name), target: name === 'navigation.json' || name === 'navigation.md' ? `.ai-workflow/index/${name}` : name }));
}
async function projectTemplateContents(): Promise<Array<{ target: string; contents: string }>> {
  return Promise.all(projectTargets().map(async ({ source, target }) => ({ target, contents: await readFile(new URL(`../../${source}`, import.meta.url), 'utf8') })));
}

function agentsRoot(home: string, host: Host): string {
  if (host === 'codex') return join(home, '.codex/agents');
  if (host === 'claude') return join(home, '.claude/agents');
  return join(home, '.config/opencode/agents');
}
function skillsRoot(home: string): string { return join(home, skillsRelative); }

async function writeOwnedFile(home: string, file: RenderedFile, previous: ManifestFile[] | undefined, root: string): Promise<boolean> {
  const path = join(root, file.relativePath);
  const owned = previous?.find((item) => item.path === relative(home, path));
  if (owned && (await exists(path)) && sha256(await readFile(path)) !== owned.digest) return false;
  await atomicWrite(path, file.contents);
  return true;
}

async function readManifest(home: string): Promise<InstallManifest> {
  const path = join(home, manifestRelative); return await exists(path) ? readJson<InstallManifest>(path) : { version: '1', installed_at: new Date(0).toISOString(), hosts: {} };
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

async function installUnsafe(hosts: Host[], options: { home?: string; version?: string; profile?: Profile } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const version = options.version ?? '0.1.0'; const manifest = await readManifest(home);
  // Resolve the output language before any render or write so an invalid configuration aborts pre-write.
  const language = await loadOutputLanguage(home);
  const activeName = options.profile ? undefined : await getActiveProfile(home); const profile = options.profile ?? (activeName ? await loadProfile(home, activeName) : undefined);
  // Shared skills are host-neutral and installed once, independent of the requested host list.
  const skills = await renderSkills(language);
  const ownedSkills: ManifestFile[] = []; const skipped: string[] = [];
  for (const file of skills) { const path = join(skillsRoot(home), file.relativePath); if (await writeOwnedFile(home, file, manifest.skills, skillsRoot(home))) ownedSkills.push({ path: relative(home, path), digest: sha256(file.contents), kind: 'file' }); else { const prior = manifest.skills?.find((item) => item.path === relative(home, path)); if (prior) { ownedSkills.push(prior); skipped.push(prior.path); } } }
  await removeStaleOwnedFiles(home, manifest.skills ?? [], ownedSkills);
  manifest.skills = ownedSkills;
  const renderedHosts = new Map<Host, RenderedFile[]>(); for (const host of hosts) renderedHosts.set(host, await renderHost(host, profile));
  for (const host of hosts) {
    const rendered = renderedHosts.get(host); if (!rendered) throw new Error(`Missing rendered host: ${host}`);
    const target = agentsRoot(home, host);
    const owned: ManifestFile[] = [];
    for (const file of rendered) { const path = join(target, file.relativePath); if (await writeOwnedFile(home, file, manifest.hosts[host], target)) owned.push({ path: relative(home, path), digest: sha256(file.contents), kind: 'file' }); else { const prior = manifest.hosts[host]?.find((item) => item.path === relative(home, path)); if (prior) { owned.push(prior); skipped.push(prior.path); } } }
    if (host === 'codex') await removeMarketplaceEntry(home);
    await removeStaleOwnedFiles(home, manifest.hosts[host] ?? [], owned);
    manifest.hosts[host] = owned;
  }
  manifest.version = version; manifest.installed_at = new Date().toISOString(); if (skipped.length) manifest.skipped = skipped; else delete manifest.skipped; await writeJson(join(home, manifestRelative), manifest); return manifest;
}

export async function install(hosts: Host[], options: { home?: string; version?: string; profile?: Profile } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const manifestPath = join(home, manifestRelative); const hadManifest = await exists(manifestPath); const previous = hadManifest ? await readFile(manifestPath) : undefined;
  try { return await installUnsafe(hosts, options); } catch (error) {
    if (previous) await atomicWrite(manifestPath, previous); else await rm(manifestPath, { force: true });
    if (!hadManifest) { await rm(skillsRoot(home), { recursive: true, force: true }); for (const host of hosts) await rm(agentsRoot(home, host), { recursive: true, force: true }); await removeEmptyDirectory(join(home, '.agents')); await removeEmptyDirectory(join(home, '.codex')); await removeEmptyDirectory(join(home, '.config')); }
    throw error;
  }
}

export async function getActiveProfile(home: string): Promise<string | undefined> {
  const path = join(resolve(home), activeProfileRelative); if (!(await exists(path))) return undefined;
  const name = (await readFile(path, 'utf8')).trim(); return name || undefined;
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

export async function activateProfile(name: string, options: { home?: string; version?: string } = {}): Promise<ProfileActivationReport> {
  const home = resolve(options.home ?? homedir()); const profile = await loadProfile(home, name); const manifest = await readManifest(home);
  const hosts = (Object.keys(manifest.hosts) as Host[]).filter((host) => ['codex', 'claude', 'opencode'].includes(host));
  for (const host of hosts) for (const file of manifest.hosts[host] ?? []) {
    const path = resolve(home, file.path);
    if (file.kind === 'file' && await exists(path) && sha256(await readFile(path)) !== file.digest) throw new Error(`Cannot activate profile because managed file was modified: ${file.path}`);
  }
  const snapshots = await Promise.all(hosts.flatMap((host) => (manifest.hosts[host] ?? []).filter((file) => file.kind === 'file').map(async (file) => ({ path: resolve(home, file.path), contents: await readFile(resolve(home, file.path)) }))));
  const marker = join(home, activeProfileRelative); const oldMarker = await exists(marker) ? await readFile(marker) : undefined;
  try {
    const installed = hosts.length ? await install(hosts, { home, version: options.version ?? manifest.version, profile }) : manifest;
    await atomicWrite(marker, `${name}\n`);
    return { active_profile: name, hosts, installations: profileInstallations(home, hosts, installed, profile) };
  } catch (error) {
    for (const snapshot of snapshots) await atomicWrite(snapshot.path, snapshot.contents);
    if (oldMarker) await atomicWrite(marker, oldMarker); else await rm(marker, { force: true });
    throw error;
  }
}

export async function uninstall(hosts: Host[], options: { home?: string } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const manifest = await readManifest(home);
  const skipped: string[] = [];
  for (const host of hosts) {
    for (const file of manifest.hosts[host] ?? []) {
      const path = resolve(home, file.path); if (!path.startsWith(`${home}/`)) throw new Error(`Unsafe manifest path: ${file.path}`);
      if (file.path === marketplaceRelative) continue;
      if (file.kind === 'file' && (await exists(path)) && sha256(await readFile(path)) !== file.digest) { skipped.push(file.path); continue; }
      await rm(path, { recursive: file.kind === 'directory', force: true });
    }
    if (host === 'codex') await removeMarketplaceEntry(home);
    const retained = (manifest.hosts[host] ?? []).filter((file) => skipped.includes(file.path));
    manifest.hosts = Object.fromEntries(Object.entries(manifest.hosts).filter(([key]) => key !== host)) as InstallManifest['hosts'];
    if (retained.length) manifest.hosts[host] = retained;
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
  const manifestPath = join(root, projectManifestRelative);
  const created: string[] = [];
  const writtenFiles: string[] = [];
  try {
    for (const item of published) {
      await atomicWrite(join(root, item.target), item.contents);
      writtenFiles.push(join(root, item.target));
      created.push(item.target);
    }
    const lines = ignoreOriginal.split(/\r?\n/).map((line) => line.trim());
    const additions: string[] = [];
    if (!lines.some((line) => line === '.ai-workflow' || line === '.ai-workflow/')) additions.push('.ai-workflow/');
    if (!lines.includes('*.log')) additions.push('*.log');
    if (additions.length) { await atomicWrite(ignorePath, `${ignoreOriginal.trimEnd()}${ignoreOriginal ? '\n' : ''}${additions.join('\n')}\n`); created.push('.gitignore'); }
    const files: Record<string, string> = {};
    for (const item of published) files[item.target] = sha256(item.contents);
    await writeJson(manifestPath, { version: 1, files } satisfies ProjectManifest);
    created.push(projectManifestRelative);
  } catch (error) {
    for (const path of writtenFiles) await rm(path, { force: true });
    await rm(manifestPath, { force: true });
    if (ignoreExisted) await writeFile(ignorePath, ignoreOriginal);
    else await rm(ignorePath, { force: true });
    if (!indexDirectoryExisted) await removeEmptyDirectory(indexDirectory);
    if (!aiWorkflowDirectoryExisted) await removeEmptyDirectory(aiWorkflowDirectory);
    throw error;
  }
  return created;
}

export async function updateProject(project: string): Promise<{ updated: string[]; skipped: string[]; unchanged: string[] }> {
  const root = resolve(project); const manifestPath = join(root, projectManifestRelative);
  if (!(await exists(manifestPath))) throw new Error(`Project update requires ${projectManifestRelative}; initialize a new project or merge the current templates manually.`);
  const manifest = await readJson<ProjectManifest>(manifestPath);
  if (manifest.version !== 1) throw new Error(`Unsupported project manifest version: ${String(manifest.version)}`);
  const updated: string[] = []; const skipped: string[] = [navigationJsonRelative, navigationMarkdownRelative]; const unchanged: string[] = [];
  for (const template of await projectTemplateContents()) {
    if (template.target === navigationJsonRelative || template.target === navigationMarkdownRelative) continue;
    const path = join(root, template.target); const expected = manifest.files[template.target];
    if (!expected || !(await exists(path)) || sha256(await readFile(path)) !== expected) { skipped.push(template.target); continue; }
    const digest = sha256(template.contents);
    if (expected === digest) { unchanged.push(template.target); continue; }
    await atomicWrite(path, template.contents); manifest.files[template.target] = digest; updated.push(template.target);
  }
  await writeJson(manifestPath, manifest);
  return { updated, skipped, unchanged };
}
