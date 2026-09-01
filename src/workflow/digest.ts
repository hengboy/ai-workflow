import { parseMarkdown, renderMarkdown } from '../utils/frontmatter.js';
import { objectDigest, sha256 } from '../utils/hash.js';

const frontmatterPattern = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/;
const digestLinePattern = /^digest:[^\r\n]*(\r?\n|$)/m;

/** Remove only the self-referential digest value from a frozen document. */
export function canonicalFrozenDocument(source: string): string {
  const document = parseMarkdown(source);
  if (!Object.hasOwn(document.attributes, 'digest')) throw new Error('Frozen document must declare a digest');
  const match = frontmatterPattern.exec(source);
  if (!match) throw new Error('Frozen document must begin with YAML frontmatter');
  const frontmatter = match[2] ?? '';
  const digestMatch = digestLinePattern.exec(frontmatter);
  if (!digestMatch) throw new Error('Frozen document digest must be a top-level frontmatter line');
  const newline = digestMatch[1] ?? '';
  const start = digestMatch.index;
  const end = start + digestMatch[0].length;
  return `${match[1]}${frontmatter.slice(0, start)}digest: ""${newline}${frontmatter.slice(end)}${match[3]}${match[4] ?? ''}`;
}

export function frozenDocumentDigest(source: string): string {
  return sha256(canonicalFrozenDocument(source));
}

export function frozenPlanDigest(spec: string, plan: string): string {
  return objectDigest({ plan: frozenDocumentDigest(plan), spec: frozenDocumentDigest(spec) });
}

export function renderFrozenMarkdown(attributes: Record<string, unknown>, body: string): string {
  const draft = renderMarkdown({ ...attributes, digest: '' }, body);
  return renderMarkdown({ ...attributes, digest: frozenDocumentDigest(draft) }, body);
}
