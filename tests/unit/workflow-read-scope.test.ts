import { describe, expect, it } from 'vitest';
import { fixedTaskContext, taskReadScope, taskReadScopeDiagnostics } from '../../src/workflow/read-scope.js';
import type { TaskReadAuthorization } from '../../src/workflow/read-scope.js';

const projectContract = '.ai-workflow/AGENTS.md';
const existingFixedContext = ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'];
const expectedFixedContext = [...existingFixedContext, projectContract];

function authorization(overrides: Partial<TaskReadAuthorization> = {}): TaskReadAuthorization {
  return { task_id: 'task-001-example', exact_paths: [], module_directories: [], ...overrides };
}

describe('fixedTaskContext', () => {
  it('adds the project contract alongside the existing fixed context entries', () => {
    expect(fixedTaskContext).toEqual(expect.arrayContaining(expectedFixedContext));
    expect(fixedTaskContext).toHaveLength(expectedFixedContext.length);
  });

  it('does not pull any notes history into the fixed context', () => {
    expect(fixedTaskContext.filter((path) => path.startsWith('.ai-workflow/notes/'))).toEqual([]);
  });
});

describe('taskReadScope', () => {
  it('includes the fixed context, exact paths and module directories of the task', () => {
    const task = authorization({ exact_paths: ['src/workflow/read-scope.ts'], module_directories: ['tests/unit'] });
    const scope = taskReadScope(task);

    expect(scope).toEqual(expect.arrayContaining(expectedFixedContext));
    expect(scope).toContain('src/workflow/read-scope.ts');
    expect(scope).toContain('tests/unit');
  });

  it('keeps notes out of scope when the task does not authorize them', () => {
    const task = authorization({ exact_paths: ['src/workflow/read-scope.ts'] });
    const scope = taskReadScope(task);

    expect(scope.filter((path) => path.startsWith('.ai-workflow/notes'))).toEqual([]);
  });

  it('adds only the explicitly authorized notes paths and directories', () => {
    const governance = '.ai-workflow/notes/README.md';
    const note = '.ai-workflow/notes/implemented/process/2026-09-16-project-contract-and-agent-notes.md';
    const categoryDirectory = '.ai-workflow/notes/implemented/process';
    const task = authorization({ exact_paths: [governance, note], module_directories: [categoryDirectory] });
    const scope = taskReadScope(task);

    expect(scope).toEqual(expect.arrayContaining(expectedFixedContext));
    expect(scope).toEqual(expect.arrayContaining([governance, note, categoryDirectory]));

    const notesPaths = scope.filter((path) => path.startsWith('.ai-workflow/notes'));
    expect([...notesPaths].sort()).toEqual([governance, note, categoryDirectory].sort());
  });
});

describe('taskReadScopeDiagnostics', () => {
  const governance = '.ai-workflow/notes/AGENTS.md';
  const note = '.ai-workflow/notes/implemented/process/2026-09-16-project-contract-and-agent-notes.md';
  const task = authorization({ exact_paths: [governance, note] });

  it('reports no diagnostics for the scope derived from the same authorization', () => {
    expect(taskReadScopeDiagnostics(taskReadScope(task), task)).toEqual([]);
  });

  it('reports a notes path that the task did not authorize', () => {
    const forged = [...taskReadScope(task), '.ai-workflow/notes/archived/manifest.json'];
    expect(taskReadScopeDiagnostics(forged, task)).toContain('unauthorized read_scope path: .ai-workflow/notes/archived/manifest.json');
  });

  it('reports an authorized notes path missing from the scope', () => {
    const trimmed = taskReadScope(task).filter((path) => path !== note);
    expect(taskReadScopeDiagnostics(trimmed, task)).toContain(`missing authorized read_scope path: ${note}`);
  });
});
