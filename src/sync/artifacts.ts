/**
 * Fixed file-level ownership shared by initialization, shipped-template upgrade,
 * remote source acquisition and the publication core. Exactly five generated Markdown
 * documents are replaceable as complete files; root MEMORY is an init-only local
 * bootstrap, navigation is derived-init data and the archive manifest is a data bootstrap.
 */
export interface GeneratedArtifact {
  source: string;
  target: string;
}

export const generatedArtifacts: readonly GeneratedArtifact[] = [
  { source: 'templates/project/AGENTS.md', target: '.ai-workflow/AGENTS.md' },
  { source: 'templates/project/notes/AGENTS.md', target: '.ai-workflow/notes/AGENTS.md' },
  { source: 'templates/project/notes/README.md', target: '.ai-workflow/notes/README.md' },
  { source: 'templates/project/notes/implemented/AGENTS.md', target: '.ai-workflow/notes/implemented/AGENTS.md' },
  { source: 'templates/project/notes/archived/AGENTS.md', target: '.ai-workflow/notes/archived/AGENTS.md' },
];

/** Root MEMORY: init-only local bootstrap, never synchronized or compared to a template. */
export const memorySource = 'templates/project/MEMORY.md';
export const memoryTarget = 'MEMORY.md';

/** Navigation is derived-init data; it is created from discovery, never from a template. */
export const navigationJsonTarget = '.ai-workflow/index/navigation.json';
export const navigationMarkdownTarget = '.ai-workflow/index/navigation.md';

/** The empty archive manifest data bootstrap, used only when the target is absent. */
export const archiveManifestTarget = '.ai-workflow/notes/archived/manifest.json';
export const emptyArchiveManifest = `${JSON.stringify({ version: 1, files: {} }, null, 2)}\n`;

/**
 * The only legacy-marker logic kept: a bounded predicate that rejects the old
 * section-management format. It never parses, extracts or adopts sections.
 */
const legacySectionMarker = /<!--\s*ai-workflow:section\b/;

export function hasLegacySectionMarker(contents: string): boolean {
  return legacySectionMarker.test(contents);
}

/** Validate one generated document: nonempty Markdown with a level-one title and no legacy markers. */
export function generatedDocumentError(contents: string): string | undefined {
  if (contents.trim() === '') return 'the generated document is empty';
  if (!/^#\s+\S/m.test(contents)) return 'the generated document has no level-one title';
  if (hasLegacySectionMarker(contents)) return 'the generated document still uses legacy section markers';
  return undefined;
}

/** Validate the complete five-member markerless snapshot; returns the first error with its source path. */
export function validateGeneratedSnapshot(files: Record<string, string>): { path: string; reason: string } | undefined {
  for (const artifact of generatedArtifacts) {
    const contents = files[artifact.source];
    if (contents === undefined) return { path: artifact.source, reason: 'the required generated source member is missing' };
    const error = generatedDocumentError(contents);
    if (error !== undefined) return { path: artifact.source, reason: error };
  }
  return undefined;
}
