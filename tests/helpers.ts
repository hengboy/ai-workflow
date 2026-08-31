import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderMarkdown } from '../src/utils/frontmatter.js';
const exec = promisify(execFile);
export async function temporary(prefix = 'ai-workflow-'): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }
export async function frozenPlan(root: string, withTasks = true): Promise<string> {
  const directory = join(root, '.ai-workflow/plans/20260831-example'); await mkdir(join(directory, 'tasks'), { recursive: true }); const attributes = { plan_id: '20260831-example', status: 'frozen', created_at: '2026-08-31T00:00:00.000Z', supersedes: null, requirement_count: 1, acceptance_criteria_count: 1, digest: 'sha256:placeholder' };
  await writeFile(join(directory, 'spec.md'), renderMarkdown(attributes, '# Spec\n\n## REQ-001 Works\n\n## AC-001 Observable')); await writeFile(join(directory, 'plan.md'), renderMarkdown(attributes, '# Plan\n\nImplement REQ-001 and verify AC-001.'));
  if (withTasks) await writeFile(join(directory, 'tasks/task-001-example.md'), renderMarkdown({ id: 'task-001-example', requirements: ['REQ-001'], acceptance_criteria: ['AC-001'], depends_on: [], surface: 'backend', read_scope: ['src/input.ts'], write_scope: ['src/output.ts'], test_commands: ['pnpm test'] }, '# Task'));
  return directory;
}
export async function gitInit(root: string): Promise<void> { await exec('git', ['init', '-b', 'main'], { cwd: root }); await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root }); await exec('git', ['config', 'user.name', 'Test'], { cwd: root }); await writeFile(join(root, 'README.md'), '# Test\n'); await exec('git', ['add', 'README.md'], { cwd: root }); await exec('git', ['commit', '-m', 'initial'], { cwd: root }); }
