import YAML from 'yaml';

export interface MarkdownDocument { attributes: Record<string, unknown>; body: string }

export function parseMarkdown(source: string): MarkdownDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error('Markdown document must begin with YAML frontmatter');
  const parsed = YAML.parse(match[1] ?? '') as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Frontmatter must be an object');
  return { attributes: parsed as Record<string, unknown>, body: match[2] ?? '' };
}

export function renderMarkdown(attributes: Record<string, unknown>, body: string): string {
  return `---\n${YAML.stringify(attributes).trimEnd()}\n---\n\n${body.trim()}\n`;
}
