import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { packagePath } from '../utils/schema.js';
import { parseMarkdown } from '../utils/frontmatter.js';
import type { Profile } from '../profile/index.js';
import type { Host } from '../workflow/types.js';
import type { OpencodeVersion } from './opencode-version.js';

export interface RenderedFile { relativePath: string; contents: string }
export interface RenderHostOptions { opencodeVersion?: OpencodeVersion }

// OpenCode V2 actions covering the template tool vocabulary. `search` has no single action;
// it maps to the filename and content discovery tools. `web` maps to both web tools.
const opencodeActions: Record<string, string[]> = {
  read: ['read'],
  search: ['glob', 'grep'],
  edit: ['edit'],
  shell: ['shell'],
  web: ['webfetch', 'websearch']
};

// OpenCode V1 permission keys. V1 uses `bash` instead of `shell` and `task`
// instead of `subagent`. See https://opencode.ai/v2/docs/migrate-v1.
const opencodeV1Actions: Record<string, string[]> = {
  read: ['read'],
  search: ['glob', 'grep'],
  edit: ['edit'],
  shell: ['bash'],
  web: ['webfetch', 'websearch']
};

const opencodeV1KeyOrder = ['read', 'edit', 'glob', 'grep', 'bash', 'webfetch', 'websearch'];

// Antigravity native tools covering the template tool vocabulary. `shell` and `search` share the
// command and task tools, and no dispatch tool appears because only the primary orchestrator dispatches.
const antigravityActions: Record<string, string[]> = {
  read: ['read_file'],
  edit: ['edit_file', 'write_file'],
  shell: ['run_command', 'manage_task'],
  web: ['search_web'],
  search: ['run_command', 'manage_task']
};

function antigravityTools(tools: unknown[]): string[] {
  return [...new Set(tools.map((tool) => String(tool)).flatMap((tool) => antigravityActions[tool] ?? []))];
}

function opencodePermissionRules(tools: string): string {
  const rules = tools.split(',').map((tool) => tool.trim()).filter(Boolean).flatMap((tool) => opencodeActions[tool] ?? [tool])
    .map((action) => `  - action: ${action}\n    resource: "*"\n    effect: allow`);
  // Only the primary orchestrator dispatches, so role agents never launch nested subagents.
  rules.push('  - action: subagent\n    resource: "*"\n    effect: deny');
  return `mode: subagent\npermissions:\n${rules.join('\n')}`;
}

function opencodeV1PermissionRules(tools: string): string {
  const allowed = new Set(tools.split(',').map((tool) => tool.trim()).filter(Boolean).flatMap((tool) => opencodeV1Actions[tool] ?? [tool]));
  const lines = opencodeV1KeyOrder.filter((key) => allowed.has(key)).map((key) => `  ${key}: allow`);
  // Only the primary orchestrator dispatches, so role agents never launch nested subagents.
  lines.push('  task: deny');
  return `mode: subagent\npermission:\n${lines.join('\n')}`;
}

function frontmatterFor(host: Host, source: string, opencodeVersion: OpencodeVersion): string {
  if (host === 'codex') return source;
  if (host === 'claude') return source.replace(/^tools: \[(.*)]$/m, 'allowed-tools: [$1]');
  // OpenCode derives the agent id from the file name and no longer accepts the V1 `name` field.
  return source.replace(/^name: .*\n/m, '').replace(/^tools: \[(.*)]$/m, (_match, tools: string) => opencodeVersion === 'v1' ? opencodeV1PermissionRules(tools) : opencodePermissionRules(tools));
}

function quoted(value: string): string { return JSON.stringify(value); }
function textAttribute(value: unknown): string { return typeof value === 'string' ? value : ''; }

function codexAgent(source: string, settings: { model: string; reasoning_effort: string } | undefined): string {
  const document = parseMarkdown(source); const name = textAttribute(document.attributes.name); const description = textAttribute(document.attributes.description);
  return [
    `name = ${quoted(name)}`,
    `description = ${quoted(description)}`,
    ...(settings ? [`model = ${quoted(settings.model)}`, `model_reasoning_effort = ${quoted(settings.reasoning_effort)}`] : []),
    `developer_instructions = ${quoted(document.body.trim())}`,
    ''
  ].join('\n');
}

// Antigravity derives the agent id from the file name, so frontmatter declares only dispatch
// flags, mapped tools and an optional model tier; a tier-inherit profile omits the model key.
// Shell-capable roles use `auto` so routine project commands run without redundant approval
// while Antigravity still gates irreversible actions.
function antigravityAgent(source: string, model: string | undefined): string {
  const document = parseMarkdown(source);
  const name = textAttribute(document.attributes.name); const description = textAttribute(document.attributes.description);
  const tools = Array.isArray(document.attributes.tools) ? antigravityTools(document.attributes.tools) : [];
  const head = [
    `name: ${name}`,
    `description: ${description}`,
    `tools: [${tools.join(', ')}]`,
    ...(model === undefined || model === 'inherit' ? [] : [`model: ${quoted(model)}`]),
    'subagent: true',
    'mainAgent: false',
    ...(tools.includes('run_command') || tools.includes('manage_task') ? ['commandExecutionPolicy: auto'] : [])
  ];
  return `---\n${head.join('\n')}\n---\n${document.body}`;
}

function agentFrontmatterFor(host: Host, source: string, settings: { model: string; reasoning_effort: string } | undefined, opencodeVersion: OpencodeVersion): string {
  if (host === 'codex') return codexAgent(source, settings);
  const rendered = frontmatterFor(host, source, opencodeVersion);
  const configuration = settings
    ? host === 'claude'
      ? `model: ${quoted(settings.model)}\neffort: ${quoted(settings.reasoning_effort)}\n`
      : `model: ${quoted(settings.model)}\nvariant: ${quoted(settings.reasoning_effort)}\n`
    : '';
  return rendered.replace(/^---\n/, `---\n${configuration}`);
}

async function filesRecursively(root: string): Promise<string[]> {
  const names = await readdir(root, { withFileTypes: true }); const result: string[] = [];
  for (const name of names) { const path = join(root, name.name); if (name.isDirectory()) result.push(...await filesRecursively(path)); else result.push(path); }
  return result;
}

async function markdownFiles(root: string): Promise<string[]> {
  return (await filesRecursively(root)).filter((path) => path.endsWith('.md'));
}

export async function renderSkills(): Promise<RenderedFile[]> {
  const skillRoot = packagePath('templates', 'skills');
  const files: RenderedFile[] = [];
  for (const path of await filesRecursively(skillRoot)) {
    const relativePath = relative(skillRoot, path);
    const contents = await readFile(path, 'utf8');
    files.push({ relativePath, contents });
  }
  return files;
}

export async function renderHost(host: Host, profile?: Profile, options?: RenderHostOptions): Promise<RenderedFile[]> {
  const agentRoot = packagePath('templates', 'agents');
  const agents: RenderedFile[] = [];
  const opencodeVersion = options?.opencodeVersion ?? 'v2';
  for (const path of await markdownFiles(agentRoot)) {
    const name = basename(path, '.md'); const extension = host === 'codex' ? '.toml' : '.md';
    const source = await readFile(path, 'utf8');
    const entry = profile?.agents[name];
    const rendered = host === 'antigravity'
      ? antigravityAgent(source, entry?.antigravity?.model)
      : agentFrontmatterFor(host, source, entry?.[host], opencodeVersion);
    agents.push({ relativePath: `${name}${extension}`, contents: rendered });
  }
  return agents;
}
