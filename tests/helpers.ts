import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderMarkdown } from '../src/utils/frontmatter.js';
import { renderFrozenMarkdown } from '../src/workflow/digest.js';
import { renderNavigation, type NavigationIndex } from '../src/context/navigation.js';
import { blobHash, chineseSwitcher, englishSwitcher, metaPathOf, renderPairMeta, zhPathOf } from '../src/notes/pairing.js';
const exec = promisify(execFile);
export async function temporary(prefix = 'ai-workflow-'): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

export function insertSwitcher(note: string, switcher: string): string {
  const lines = note.split('\n');
  const status = lines.findIndex((line) => line.startsWith('Status:'));
  let cursor = status === -1 ? 1 : status + 1;
  if (lines[cursor]?.startsWith('Archived:')) cursor += 1;
  return [...lines.slice(0, cursor + 1), switcher, '', ...lines.slice(cursor + 1)].join('\n');
}

export function notePair(englishPath: string, englishBody: string): { english: string; chinese: string; meta: string } {
  const english = insertSwitcher(englishBody, englishSwitcher(englishPath));
  const chinese = insertSwitcher(englishBody, chineseSwitcher(englishPath));
  return { english, chinese, meta: renderPairMeta(englishPath, blobHash(english), blobHash(chinese)) };
}

export async function writeNoteTriplet(root: string, englishPath: string, englishBody: string): Promise<{ english: string; chinese: string; meta: string }> {
  const files = notePair(englishPath, englishBody);
  await mkdir(join(root, englishPath).replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(join(root, englishPath), files.english);
  await writeFile(join(root, zhPathOf(englishPath)), files.chinese);
  await writeFile(join(root, metaPathOf(englishPath)), files.meta);
  return files;
}

export type EnglishDocumentRenderer = (body: string) => string;

export interface PlanTripletFiles { english: string; chinese: string; meta: string }

/** Insert the exact language switcher after the document title, keeping it on line index 2. */
function insertTitleSwitcher(body: string, switcher: string): string {
  const lines = body.split('\n');
  const title = lines[0] ?? '';
  let cursor = 1;
  while (lines[cursor] === '') cursor += 1;
  return [title, '', switcher, '', ...lines.slice(cursor)].join('\n');
}

/** Render the planning-artifact consistency record: header comments plus exactly two hash lines. */
export function renderPlanPairMeta(planDirectory: string, englishBasename: string, englishHash: string, zhHash: string): string {
  const zhBasename = basename(zhPathOf(englishBasename));
  return [
    `# Bilingual-pair consistency record for the planning artifact triplet in ${planDirectory}.`,
    '# The two lines below pin the git blob hash of each side at the last confirmed-consistent state.',
    '# After editing either side, bring the other along and re-record with:',
    `# ai-workflow plan pairing --plan ${planDirectory} --write ${englishBasename}`,
    `${englishBasename}: ${englishHash}`,
    `${zhBasename}: ${zhHash}`,
    '',
  ].join('\n');
}

/** Render the frozen `tasks/execution-order.yaml` schedule a split-plan fixture must carry. */
export function renderExecutionOrderYaml(planId: string, phases: string[][]): string {
  const lines = [`plan_id: ${planId}`, 'phases:'];
  for (const phase of phases) {
    lines.push('  - parallel:');
    for (const id of phase) lines.push(`      - ${id}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Build the English and Chinese sides plus the consistency record for one planning document. */
export function planDocumentPair(
  planDirectory: string,
  englishBasename: string,
  englishBody: string,
  chineseBody: string,
  renderEnglish: EnglishDocumentRenderer = (body) => body,
): PlanTripletFiles {
  const english = renderEnglish(insertTitleSwitcher(englishBody, englishSwitcher(englishBasename)));
  const chinese = insertTitleSwitcher(chineseBody, chineseSwitcher(englishBasename));
  return { english, chinese, meta: renderPlanPairMeta(planDirectory, englishBasename, blobHash(english), blobHash(chinese)) };
}

/** Write a complete `<doc>.md` / `<doc>.zh.md` / `<doc>.i18n.yaml` triplet for a plan document. */
export async function writePlanTriplet(
  planDirectory: string,
  englishBasename: string,
  englishBody: string,
  chineseBody: string,
  renderEnglish: EnglishDocumentRenderer = (body) => body,
): Promise<PlanTripletFiles> {
  const files = planDocumentPair(planDirectory, englishBasename, englishBody, chineseBody, renderEnglish);
  await mkdir(planDirectory, { recursive: true });
  await writeFile(join(planDirectory, englishBasename), files.english);
  await writeFile(join(planDirectory, zhPathOf(englishBasename)), files.chinese);
  await writeFile(join(planDirectory, metaPathOf(englishBasename)), files.meta);
  return files;
}

/** Re-record the current bytes of an existing plan document pair. */
export async function recordPlanPair(planDirectory: string, englishBasename: string): Promise<void> {
  const english = await readFile(join(planDirectory, englishBasename));
  const chinese = await readFile(join(planDirectory, zhPathOf(englishBasename)));
  await writeFile(join(planDirectory, metaPathOf(englishBasename)), renderPlanPairMeta(planDirectory, englishBasename, blobHash(english), blobHash(chinese)));
}

export async function frozenPlan(root: string, withTasks = true): Promise<string> {
  const directory = join(root, '.ai-workflow/plans/20260831-example');
  await mkdir(join(directory, 'tasks'), { recursive: true });
  const attributes = { plan_id: '20260831-example', status: 'frozen', created_at: '2026-08-31T00:00:00.000Z', supersedes: null, requirement_count: 1, acceptance_criteria_count: 1, digest: 'sha256:placeholder' };
  const frozen: EnglishDocumentRenderer = (body) => renderFrozenMarkdown(attributes, body);
  await writePlanTriplet(directory, 'spec.md', '# Specification\n\n## REQ-001 Works\n\n## AC-001 Observable', '# Specification\n\n## REQ-001 Works\n\n## AC-001 Observable', frozen);
  await writePlanTriplet(directory, 'plan.md', '# Implementation Plan\n\nImplement REQ-001 and verify AC-001.', '# Implementation Plan\n\nImplement REQ-001 and verify AC-001.', frozen);
  if (withTasks) {
    const navigation: NavigationIndex = { version: 1, module_roots: [{ id: 'input', path: 'src', owner_role: 'backend', responsibility: 'test input', language: 'typescript', entry_kinds: ['exported-symbol'] }], features: [{ id: 'task-input', name: 'task input', aliases: [], module_root: 'input', entries: ['src/input.ts'], symbols: [], related_files: [], tests: [], depends_on: [], relations: [], owner_role: 'backend', responsibility: 'test input', read_scope: ['src/input.ts'], shared_entry: false }] };
    await mkdir(join(root, 'src'), { recursive: true }); await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
    await writeFile(join(root, 'MEMORY.md'), '# Memory\n'); await writeFile(join(root, 'src/input.ts'), 'export const input = true;\n'); await writeFile(join(root, '.ai-workflow/index/navigation.json'), `${JSON.stringify(navigation)}\n`); await writeFile(join(root, '.ai-workflow/index/navigation.md'), renderNavigation(navigation));
    const task = { id: 'task-001-example', requirements: ['REQ-001'], acceptance_criteria: ['AC-001'], depends_on: [], surface: 'backend', read_scope: ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md', 'src/input.ts'], write_scope: ['src/output.ts'], test_commands: ['pnpm test'] };
    await writePlanTriplet(join(directory, 'tasks'), 'task-001-example.md', '# Task', '# Task', (body) => renderMarkdown(task, body));
    await writeFile(join(directory, 'tasks', 'execution-order.yaml'), renderExecutionOrderYaml('20260831-example', [['task-001-example']]));
  }
  return directory;
}
export async function gitInit(root: string): Promise<void> { await exec('git', ['init', '-b', 'main'], { cwd: root }); await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root }); await exec('git', ['config', 'user.name', 'Test'], { cwd: root }); await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: root }); await writeFile(join(root, 'README.md'), '# Test\n'); await exec('git', ['add', 'README.md'], { cwd: root }); await exec('git', ['commit', '-m', 'initial'], { cwd: root }); }
