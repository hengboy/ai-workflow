import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { atomicWrite, exists } from '../utils/fs.js';
import { parseMarkdown } from '../utils/frontmatter.js';
import {
  blobHash,
  chineseSwitcher,
  englishPathOf,
  englishSwitcher,
  metaPathOf,
  noteStructureSignature,
  parsePairMeta,
  structureDiff,
  zhPathOf,
} from '../notes/pairing.js';

export interface PlanDocumentAnchor { path: string; zhPath: string; metaPath: string }
export type PlanPairState = 'ok' | 'out-of-sync' | 'missing';

const taskNamePattern = /^task-\d{3}-.+\.md$/;
const taskPathPattern = /^tasks\/task-\d{3}-.+\.md$/;

function isSidecar(name: string): boolean { return name.endsWith('.zh.md') || name.endsWith('.i18n.yaml'); }
function isTaskMain(name: string): boolean { return name.endsWith('.md') && !name.endsWith('.zh.md') && taskNamePattern.test(name); }

function anchorOf(planDirectory: string, englishPath: string): PlanDocumentAnchor {
  return { path: englishPath, zhPath: zhPathOf(englishPath), metaPath: metaPathOf(englishPath) };
}

function anchorFor(planDirectory: string, relativePath: string): PlanDocumentAnchor {
  return anchorOf(planDirectory, join(planDirectory, relativePath));
}

function expectedTitle(englishPath: string): string {
  const name = basename(englishPath);
  if (name === 'spec.md') return '# Specification';
  if (name === 'plan.md') return '# Implementation Plan';
  return '# Task';
}

function validateFormat(path: string, content: string, title: string, switcher: string, errors: string[]): void {
  const lines = content.replace(/^\r?\n/, '').split(/\r?\n/);
  if (lines[0] !== title) errors.push(`${path}: title must be exactly "${title}"`);
  if (lines[1] !== '') errors.push(`${path}: the title must be followed by a blank line`);
  if (lines[2] !== switcher) errors.push(`${path}: language switcher must be exactly "${switcher}"`);
  else if (lines[3] !== '') errors.push(`${path}: the language switcher must be followed by a blank line`);
}

/** Render the planning-artifact consistency record: header comments plus exactly two hash lines. */
export function renderPlanPairMeta(planDirectory: string, englishPath: string, englishHash: string, zhHash: string): string {
  const english = basename(englishPath);
  const zh = basename(zhPathOf(englishPath));
  return [
    `# Bilingual-pair consistency record for the planning artifact triplet in ${planDirectory}.`,
    '# The two lines below pin the git blob hash of each side at the last confirmed-consistent state.',
    '# After editing either side, bring the other along and re-record with:',
    `# ai-workflow plan pairing --plan ${planDirectory} --write ${english}`,
    `${english}: ${englishHash}`,
    `${zh}: ${zhHash}`,
    '',
  ].join('\n');
}

export async function enumeratePlanDocuments(planDirectory: string, errors: string[]): Promise<PlanDocumentAnchor[]> {
  const anchors: PlanDocumentAnchor[] = [];
  const names = await readdir(planDirectory).catch((): string[] => []);
  const mainNames = new Set<string>();
  for (const name of ['spec.md', 'plan.md']) {
    if (names.includes(name)) { mainNames.add(name); anchors.push(anchorOf(planDirectory, join(planDirectory, name))); }
    else errors.push(`${join(planDirectory, name)}: missing English plan document`);
  }
  for (const name of names) {
    if (isSidecar(name) && !mainNames.has(englishPathOf(name))) errors.push(`${join(planDirectory, name)}: orphan sidecar has no matching English document`);
  }

  const taskDirectory = join(planDirectory, 'tasks');
  const taskNames = await readdir(taskDirectory).catch((): string[] => []);
  const taskMains = taskNames.filter(isTaskMain).sort();
  for (const name of taskMains) anchors.push(anchorOf(planDirectory, join(taskDirectory, name)));
  const taskMainSet = new Set(taskMains);
  for (const name of taskNames) {
    if (isSidecar(name) && !taskMainSet.has(englishPathOf(name))) errors.push(`${join(taskDirectory, name)}: orphan sidecar has no matching English document`);
  }
  return anchors;
}

export async function planPairState(anchor: PlanDocumentAnchor): Promise<PlanPairState> {
  if (!(await exists(anchor.zhPath)) || !(await exists(anchor.metaPath))) return 'missing';
  const entries = parsePairMeta(await readFile(anchor.metaPath, 'utf8'));
  if (!entries) return 'out-of-sync';
  const english = blobHash(await readFile(anchor.path));
  const chinese = blobHash(await readFile(anchor.zhPath));
  return entries.get(basename(anchor.path)) === english && entries.get(basename(anchor.zhPath)) === chinese ? 'ok' : 'out-of-sync';
}

export async function validatePlanPair(anchor: PlanDocumentAnchor, errors: string[]): Promise<void> {
  if (!(await exists(anchor.path))) { errors.push(`${anchor.path}: missing English document`); return; }
  const englishSource = await readFile(anchor.path, 'utf8');
  const englishBody = parseMarkdown(englishSource).body;
  const title = expectedTitle(anchor.path);
  validateFormat(anchor.path, englishBody, title, englishSwitcher(anchor.path), errors);

  if (!(await exists(anchor.zhPath))) {
    errors.push(`${anchor.zhPath}: missing Chinese counterpart (.zh.md) for the document`);
  } else {
    const chinese = await readFile(anchor.zhPath, 'utf8');
    validateFormat(anchor.zhPath, chinese, title, chineseSwitcher(anchor.path), errors);
    for (const difference of structureDiff(
      noteStructureSignature(englishBody, basename(anchor.zhPath)),
      noteStructureSignature(chinese, basename(anchor.path)),
    )) {
      errors.push(`${anchor.path}: ${difference}`);
    }
  }

  if (!(await exists(anchor.metaPath))) {
    errors.push(`${anchor.metaPath}: missing consistency record (.i18n.yaml) for the document`);
    return;
  }
  const entries = parsePairMeta(await readFile(anchor.metaPath, 'utf8'));
  if (!entries) {
    errors.push(`${anchor.metaPath}: consistency record must contain only <document>.md: <40-hex git blob hash> lines`);
    return;
  }
  const englishKey = basename(anchor.path);
  const zhKey = basename(anchor.zhPath);
  if (entries.size !== 2 || !entries.has(englishKey) || !entries.has(zhKey)) {
    errors.push(`${anchor.metaPath}: consistency record must record exactly ${englishKey} and ${zhKey}`);
  }
  if (entries.get(englishKey) !== blobHash(englishSource)) {
    errors.push(`${anchor.metaPath}: recorded hash for ${englishKey} does not match the current English bytes; re-record with ai-workflow plan pairing --write`);
  }
  if (await exists(anchor.zhPath)) {
    const chinese = await readFile(anchor.zhPath, 'utf8');
    if (entries.get(zhKey) !== blobHash(chinese)) {
      errors.push(`${anchor.metaPath}: recorded hash for ${zhKey} does not match the current Chinese bytes; re-record with ai-workflow plan pairing --write`);
    }
  }
}

function planRelativeAnchor(argument: string): string {
  const normalized = argument.split('\\').join('/').replace(/^\.\//, '');
  const base = normalized.endsWith('.zh.md') ? `${normalized.slice(0, -'.zh.md'.length)}.md`
    : normalized.endsWith('.i18n.yaml') ? `${normalized.slice(0, -'.i18n.yaml'.length)}.md`
      : normalized.endsWith('.md') ? normalized
        : /^task-\d{3}-.+$/.test(normalized) ? `tasks/${normalized}.md`
          : `${normalized}.md`;
  if (base === 'spec.md' || base === 'plan.md' || taskPathPattern.test(base)) return base;
  throw new Error(`${argument}: expected <doc>.md, <doc>.zh.md, <doc>.i18n.yaml or a bare spec, plan or task-NNN-slug`);
}

export async function listPlanPairs(planDirectory: string): Promise<{ entries: { path: string; state: PlanPairState }[] }> {
  const entries: { path: string; state: PlanPairState }[] = [];
  for (const anchor of await enumeratePlanDocuments(planDirectory, [])) {
    entries.push({ path: relative(planDirectory, anchor.path), state: await planPairState(anchor) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries };
}

export async function verifyPlanPairs(planDirectory: string, selections: string[] = []): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  if (selections.length) {
    for (const selection of selections) {
      const anchor = anchorFor(planDirectory, planRelativeAnchor(selection));
      if (!(await exists(anchor.path))) { errors.push(`${anchor.path}: missing English document`); continue; }
      await validatePlanPair(anchor, errors);
    }
  } else {
    for (const anchor of await enumeratePlanDocuments(planDirectory, errors)) await validatePlanPair(anchor, errors);
  }
  return { valid: errors.length === 0, errors };
}

export async function recordPlanPairs(planDirectory: string, selections: string[], all: boolean): Promise<{ written: string[] }> {
  const anchors = all
    ? await enumeratePlanDocuments(planDirectory, [])
    : selections.map((selection) => anchorFor(planDirectory, planRelativeAnchor(selection)));
  if (!all) {
    for (const anchor of anchors) {
      if (!(await exists(anchor.path))) throw new Error(`${anchor.path}: English document is missing`);
      if (!(await exists(anchor.zhPath))) throw new Error(`${anchor.zhPath}: Chinese counterpart is missing; write both language documents before recording the pair`);
    }
  }
  const written: string[] = [];
  for (const anchor of anchors) {
    if (!(await exists(anchor.path)) || !(await exists(anchor.zhPath))) continue;
    const english = await readFile(anchor.path);
    const chinese = await readFile(anchor.zhPath);
    await atomicWrite(anchor.metaPath, renderPlanPairMeta(planDirectory, anchor.path, blobHash(english), blobHash(chinese)));
    written.push(relative(planDirectory, anchor.path));
  }
  return { written };
}
