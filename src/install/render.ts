import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { packagePath } from '../utils/schema.js';
import { parseMarkdown } from '../utils/frontmatter.js';
import type { Profile } from '../profile/index.js';
import type { OutputLanguage } from '../settings/index.js';
import type { Host } from '../workflow/types.js';

export interface RenderedFile { relativePath: string; contents: string }

const languageSkillPaths = new Set(['planning/SKILL.md', 'plan-to-tasks/SKILL.md', 'coding/SKILL.md']);

function languageSection(language: OutputLanguage): string {
  const name = language === 'en' ? 'English' : 'Simplified Chinese (zh-CN)';
  return [
    '## Output language',
    '',
    `Output language: ${name}`,
    '',
    `Write the agent's interactive and session natural-language prose in ${name}, including clarification questions, confirmation previews, progress narration and final summary.`,
    '',
    'Agent notes are the current decision records and are always maintained as a complete bilingual triplet, independent of this preference: the English `<note>.md`, the Chinese `<note>.zh.md`, and the `<note>.i18n.yaml` consistency record that stores each side\'s git blob hash. Both languages carry equal authority. After both sides say the same thing, record the pair with `ai-workflow notes pairing --project <project-root> --write <note>`.',
    '',
    `Structural elements remain English in generated planning artifacts and notes alike: the \`# Agent Note:\` title, section headings, table headers, YAML frontmatter keys and their order, \`Status\` and its values, field names, \`REQ-###\`/\`AC-###\` identifiers, file paths, code, dates and enumerated values such as \`surface\`. Only natural-language prose is translated.`,
    ''
  ].join('\n');
}

function appendLanguageSection(source: string, language: OutputLanguage): string {
  return `${source.endsWith('\n') ? source : `${source}\n`}\n${languageSection(language)}`;
}

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

export async function renderSkills(language: OutputLanguage): Promise<RenderedFile[]> {
  const skillRoot = packagePath('templates', 'skills');
  const files: RenderedFile[] = [];
  for (const path of await filesRecursively(skillRoot)) {
    const relativePath = relative(skillRoot, path);
    const contents = await readFile(path, 'utf8');
    files.push({ relativePath, contents: languageSkillPaths.has(relativePath) ? appendLanguageSection(contents, language) : contents });
  }
  return files;
}

export async function renderHost(host: Host, profile?: Profile, language?: OutputLanguage): Promise<RenderedFile[]> {
  const agentRoot = packagePath('templates', 'agents');
  const agents: RenderedFile[] = [];
  for (const path of await markdownFiles(agentRoot)) {
    const name = basename(path, '.md'); const extension = host === 'codex' ? '.toml' : '.md';
    const source = await readFile(path, 'utf8');
    const rendered = agentFrontmatterFor(host, source, profile?.agents[name]?.[host]);
    agents.push({ relativePath: `${name}${extension}`, contents: language && name === 'documentation-maintainer' ? `${rendered}\n${languageSection(language)}` : rendered });
  }
  return agents;
}
