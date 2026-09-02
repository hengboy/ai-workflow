import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { packagePath } from '../utils/schema.js';
import { parseMarkdown } from '../utils/frontmatter.js';
import type { Profile } from '../profile/index.js';
import type { Host } from '../workflow/types.js';

export interface RenderedFile { relativePath: string; contents: string }

function frontmatterFor(host: Host, source: string): string {
  if (host === 'codex') return source;
  if (host === 'claude') return source.replace(/^tools: \[(.*)]$/m, 'allowed-tools: [$1]');
  return source.replace(/^tools: \[(.*)]$/m, (_match, tools: string) => {
    const permissions = tools.split(',').map((tool) => tool.trim()).filter(Boolean).flatMap((tool) => {
      const key = tool === 'shell' ? 'bash' : tool;
      // OpenCode models search as a combination of filename and content queries.
      if (key === 'search') return [['glob', 'allow'], ['grep', 'allow'], ['list', 'allow']];
      return [[key, 'allow']];
    });
    return `permission:\n${permissions.map(([key, action]) => `  ${key}: ${action}`).join('\n')}`;
  });
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
  const configuration = settings ? host === 'claude'
    ? `model: ${quoted(settings.model)}\neffort: ${quoted(settings.reasoning_effort)}\n`
    : `model: ${quoted(settings.model)}\nreasoningEffort: ${quoted(settings.reasoning_effort)}\n`
    : '';
  return host === 'opencode' ? rendered.replace(/^---\n/, `---\nhidden: true\n${configuration}`) : rendered.replace(/^---\n/, `---\n${configuration}`);
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
    files.push({ relativePath: relative(skillRoot, path), contents: await readFile(path, 'utf8') });
  }
  return files;
}

export async function renderHost(host: Host, profile?: Profile): Promise<RenderedFile[]> {
  const agentRoot = packagePath('templates', 'agents');
  const agents: RenderedFile[] = [];
  for (const path of await markdownFiles(agentRoot)) {
    const name = basename(path, '.md'); const extension = host === 'codex' ? '.toml' : '.md';
    agents.push({ relativePath: `${name}${extension}`, contents: agentFrontmatterFor(host, await readFile(path, 'utf8'), profile?.agents[name]?.[host]) });
  }
  return agents;
}
