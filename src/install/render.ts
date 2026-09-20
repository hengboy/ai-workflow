import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { packagePath } from '../utils/schema.js';
import { parseMarkdown } from '../utils/frontmatter.js';
import type { Profile } from '../profile/index.js';
import type { Host } from '../workflow/types.js';

export interface RenderedFile { relativePath: string; contents: string }

// OpenCode V2 actions covering the template tool vocabulary. `search` has no single action;
// it maps to the filename and content discovery tools. `web` maps to both web tools.
const opencodeActions: Record<string, string[]> = {
  read: ['read'],
  search: ['glob', 'grep'],
  edit: ['edit'],
  shell: ['shell'],
  web: ['webfetch', 'websearch']
};

function opencodePermissionRules(tools: string): string {
  const rules = tools.split(',').map((tool) => tool.trim()).filter(Boolean).flatMap((tool) => opencodeActions[tool] ?? [tool])
    .map((action) => `  - action: ${action}\n    resource: "*"\n    effect: allow`);
  // Only the primary orchestrator dispatches, so role agents never launch nested subagents.
  rules.push('  - action: subagent\n    resource: "*"\n    effect: deny');
  return `mode: subagent\npermissions:\n${rules.join('\n')}`;
}

function frontmatterFor(host: Host, source: string): string {
  if (host === 'codex') return source;
  if (host === 'claude') return source.replace(/^tools: \[(.*)]$/m, 'allowed-tools: [$1]');
  return source.replace(/^tools: \[(.*)]$/m, (_match, tools: string) => opencodePermissionRules(tools));
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

function agentFrontmatterFor(host: Host, source: string, settings: { model: string; reasoning_effort: string } | undefined): string {
  if (host === 'codex') return codexAgent(source, settings);
  const rendered = frontmatterFor(host, source);
  const configuration = settings
    ? host === 'claude'
      ? `model: ${quoted(settings.model)}\neffort: ${quoted(settings.reasoning_effort)}\n`
      : `model: ${quoted(settings.model)}\nreasoningEffort: ${quoted(settings.reasoning_effort)}\n`
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

export async function renderHost(host: Host, profile?: Profile): Promise<RenderedFile[]> {
  const agentRoot = packagePath('templates', 'agents');
  const agents: RenderedFile[] = [];
  for (const path of await markdownFiles(agentRoot)) {
    const name = basename(path, '.md'); const extension = host === 'codex' ? '.toml' : '.md';
    const source = await readFile(path, 'utf8');
    const rendered = agentFrontmatterFor(host, source, profile?.agents[name]?.[host]);
    agents.push({ relativePath: `${name}${extension}`, contents: rendered });
  }
  return agents;
}
