import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { atomicWrite, exists, readJson, writeJson } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { renderHost, renderSkills, type RenderedFile } from './render.js';
import { loadProfile, type Profile } from '../profile/index.js';
import type { Host } from '../workflow/types.js';

interface ManifestFile { path: string; digest: string; kind: 'file' | 'directory' }
interface InstallManifest { version: string; workflow_version?: '2.0.0'; installed_at: string; skills?: ManifestFile[]; hosts: Partial<Record<Host, ManifestFile[]>> }
interface ProjectManifest { version: 1; workflow_version?: '2.0.0'; worktree_root?: '.ai-workflow/runs/<runId>/worktrees'; files: Record<string, string> }
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
const marketplaceRelative = '.agents/plugins/marketplace.json';
const skillsRelative = '.agents/skills';
const projectTemplates = ['AGENTS.md', 'MEMORY.md', 'navigation.json', 'navigation.md', 'config.yaml'] as const;
function projectTargets(): Array<{ source: string; target: string }> {
  return projectTemplates.map((name) => ({ source: join('templates/project', name), target: name === 'navigation.json' || name === 'navigation.md' ? `.ai-workflow/index/${name}` : name === 'config.yaml' ? '.ai-workflow/config.yaml' : name }));
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

async function writeRendered(root: string, files: RenderedFile[]): Promise<void> {
  for (const file of files) await atomicWrite(join(root, file.relativePath), file.contents);
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
    await rm(path, { recursive: file.kind === 'directory', force: true });
  }
}

export async function install(hosts: Host[], options: { home?: string; version?: string; profile?: Profile } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const version = options.version ?? '0.1.0'; const manifest = await readManifest(home);
  const activeName = options.profile ? undefined : await getActiveProfile(home); const profile = options.profile ?? (activeName ? await loadProfile(home, activeName) : undefined);
  // Shared skills are host-neutral and installed once, independent of the requested host list.
  const skills = await renderSkills();
  const ownedSkills: ManifestFile[] = [];
  for (const file of skills) { const path = join(skillsRoot(home), file.relativePath); await atomicWrite(path, file.contents); ownedSkills.push({ path: relative(home, path), digest: sha256(file.contents), kind: 'file' }); }
  await removeStaleOwnedFiles(home, manifest.skills ?? [], ownedSkills);
  manifest.skills = ownedSkills;
  const renderedHosts = new Map<Host, RenderedFile[]>(); for (const host of hosts) renderedHosts.set(host, await renderHost(host, profile));
  for (const host of hosts) {
    const rendered = renderedHosts.get(host); if (!rendered) throw new Error(`Missing rendered host: ${host}`);
    const target = agentsRoot(home, host);
    await writeRendered(target, rendered);
    const owned = rendered.map((file) => ({ path: relative(home, join(target, file.relativePath)), digest: sha256(file.contents), kind: 'file' as const }));
    if (host === 'codex') await removeMarketplaceEntry(home);
    await removeStaleOwnedFiles(home, manifest.hosts[host] ?? [], owned);
    manifest.hosts[host] = owned;
  }
  manifest.version = version; manifest.workflow_version = '2.0.0'; manifest.installed_at = new Date().toISOString(); await writeJson(join(home, manifestRelative), manifest); return manifest;
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
  const installed = hosts.length ? await install(hosts, { home, version: options.version ?? manifest.version, profile }) : manifest;
  await atomicWrite(join(home, activeProfileRelative), `${name}\n`);
  return { active_profile: name, hosts, installations: profileInstallations(home, hosts, installed, profile) };
}

export async function uninstall(hosts: Host[], options: { home?: string } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const manifest = await readManifest(home);
  for (const host of hosts) {
    for (const file of manifest.hosts[host] ?? []) {
      const path = resolve(home, file.path); if (!path.startsWith(`${home}/`)) throw new Error(`Unsafe manifest path: ${file.path}`);
      if (file.path === marketplaceRelative) continue;
      await rm(path, { recursive: file.kind === 'directory', force: true });
    }
    if (host === 'codex') await removeMarketplaceEntry(home);
    manifest.hosts = Object.fromEntries(Object.entries(manifest.hosts).filter(([key]) => key !== host)) as InstallManifest['hosts'];
  }
  if (Object.keys(manifest.hosts).length === 0) {
    for (const file of manifest.skills ?? []) {
      const path = resolve(home, file.path); if (!path.startsWith(`${home}/`)) throw new Error(`Unsafe manifest path: ${file.path}`);
      await rm(path, { recursive: file.kind === 'directory', force: true });
    }
    delete manifest.skills;
  }
  await writeJson(join(home, manifestRelative), manifest); return manifest;
}

export async function initializeProject(project: string): Promise<string[]> {
  const root = resolve(project); const created: string[] = [];
  const templates = await projectTemplateContents();
  const conflicts: Array<{ target: string; contents: string }> = []; for (const item of templates) if (await exists(join(root, item.target))) conflicts.push(item);
  if (conflicts.length) throw new Error(`Initialization conflicts; no files written. Merge these templates manually:\n${conflicts.map((item) => `${item.target}\n--- proposed ---\n${item.contents}`).join('\n')}`);
  for (const item of templates) { await atomicWrite(join(root, item.target), item.contents); created.push(item.target); }
  const ignorePath = join(root, '.gitignore'); const ignore = await exists(ignorePath) ? await readFile(ignorePath, 'utf8') : ''; const additions = ['.ai-workflow/runs/', '.ai-workflow/runs/*/worktrees/', '*.log'].filter((line) => !ignore.split(/\r?\n/).includes(line)); if (additions.length) { await atomicWrite(ignorePath, `${ignore.trimEnd()}${ignore ? '\n' : ''}${additions.join('\n')}\n`); created.push('.gitignore'); }
  await writeJson(join(root, projectManifestRelative), { version: 1, workflow_version: '2.0.0', worktree_root: '.ai-workflow/runs/<runId>/worktrees', files: Object.fromEntries(templates.map((item) => [item.target, sha256(item.contents)])) } satisfies ProjectManifest);
  created.push(projectManifestRelative);
  return created;
}

export async function updateProject(project: string): Promise<{ updated: string[]; skipped: string[]; unchanged: string[] }> {
  const root = resolve(project); const manifestPath = join(root, projectManifestRelative);
  if (!(await exists(manifestPath))) throw new Error(`Project update requires ${projectManifestRelative}; initialize a new project or merge the current templates manually.`);
  const manifest = await readJson<ProjectManifest>(manifestPath);
  if (manifest.version !== 1) throw new Error(`Unsupported project manifest version: ${String(manifest.version)}`);
  const updated: string[] = []; const skipped: string[] = []; const unchanged: string[] = [];
  for (const template of await projectTemplateContents()) {
    const path = join(root, template.target); const expected = manifest.files[template.target];
    if (!expected || !(await exists(path)) || sha256(await readFile(path)) !== expected) { skipped.push(template.target); continue; }
    const digest = sha256(template.contents);
    if (expected === digest) { unchanged.push(template.target); continue; }
    await atomicWrite(path, template.contents); manifest.files[template.target] = digest; updated.push(template.target);
  }
  await writeJson(manifestPath, manifest);
  return { updated, skipped, unchanged };
}
