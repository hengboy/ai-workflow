import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderMarkdown } from '../src/utils/frontmatter.js';
import { renderFrozenMarkdown } from '../src/workflow/digest.js';
import { renderNavigation, type NavigationIndex } from '../src/context/navigation.js';
const exec = promisify(execFile);
export async function temporary(prefix = 'ai-workflow-'): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }
export async function frozenPlan(root: string, withTasks = true): Promise<string> {
  const directory = join(root, '.ai-workflow/plans/20260831-example'); await mkdir(join(directory, 'tasks'), { recursive: true }); const attributes = { plan_id: '20260831-example', status: 'frozen', created_at: '2026-08-31T00:00:00.000Z', supersedes: null, requirement_count: 1, acceptance_criteria_count: 1, digest: 'sha256:placeholder' };
  await writeFile(join(directory, 'spec.md'), renderFrozenMarkdown(attributes, '# Spec\n\n## REQ-001 Works\n\n## AC-001 Observable')); await writeFile(join(directory, 'plan.md'), renderFrozenMarkdown(attributes, '# Plan\n\nImplement REQ-001 and verify AC-001.'));
  if (withTasks) {
    const navigation: NavigationIndex = { version: 1, module_roots: [{ id: 'input', path: 'src', owner_role: 'backend', responsibility: 'test input', language: 'typescript', entry_kinds: ['exported-symbol'] }], features: [{ id: 'task-input', name: 'task input', aliases: [], module_root: 'input', entries: ['src/input.ts'], symbols: [], related_files: [], tests: [], depends_on: [], relations: [], owner_role: 'backend', responsibility: 'test input', read_scope: ['src/input.ts'], shared_entry: false }] };
    await mkdir(join(root, 'src'), { recursive: true }); await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
    await writeFile(join(root, 'MEMORY.md'), '# Memory\n'); await writeFile(join(root, 'src/input.ts'), 'export const input = true;\n'); await writeFile(join(root, '.ai-workflow/index/navigation.json'), `${JSON.stringify(navigation)}\n`); await writeFile(join(root, '.ai-workflow/index/navigation.md'), renderNavigation(navigation));
    await writeFile(join(directory, 'tasks/task-001-example.md'), renderMarkdown({ id: 'task-001-example', requirements: ['REQ-001'], acceptance_criteria: ['AC-001'], depends_on: [], surface: 'backend', feature: 'task-input', locator_read_order: ['src/input.ts'], read_scope: ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md', 'src/input.ts'], write_scope: ['src/output.ts'], test_commands: ['pnpm test'] }, '# Task'));
  }
  return directory;
}
export async function gitInit(root: string): Promise<void> { await exec('git', ['init', '-b', 'main'], { cwd: root }); await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root }); await exec('git', ['config', 'user.name', 'Test'], { cwd: root }); await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: root }); await writeFile(join(root, 'README.md'), '# Test\n'); await exec('git', ['add', 'README.md'], { cwd: root }); await exec('git', ['commit', '-m', 'initial'], { cwd: root }); }
