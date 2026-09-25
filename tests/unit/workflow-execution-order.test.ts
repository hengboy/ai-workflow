import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readExecutionOrder } from '../../src/workflow/order.js';
import type { TaskDocument } from '../../src/workflow/types.js';
import { renderExecutionOrderYaml, temporary } from '../helpers.js';

const PLAN_ID = '20260831-example';

interface TaskOverrides {
  dependsOn?: string[];
  writeScope?: string[];
}

/** Build a task document directly for the loader's `tasks` argument. */
function taskDocument(id: string, overrides: TaskOverrides = {}): TaskDocument {
  return {
    id,
    requirements: ['REQ-001'],
    acceptanceCriteria: ['AC-001'],
    dependsOn: overrides.dependsOn ?? [],
    surface: 'backend',
    readScope: [],
    writeScope: overrides.writeScope ?? [],
    testCommands: [],
    path: `tasks/${id}.md`,
  };
}

/** Create a temporary plan directory carrying the given raw schedule (`null` = no file). */
async function planDirectory(order: string | null): Promise<string> {
  const directory = await temporary('ai-workflow-order-');
  await mkdir(join(directory, 'tasks'), { recursive: true });
  if (order !== null) await writeFile(join(directory, 'tasks', 'execution-order.yaml'), order);
  return directory;
}

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('readExecutionOrder', () => {
  it('returns the file phases unchanged for a valid multi-phase schedule', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha'], ['task-002-beta']]));
    const tasks = [taskDocument('task-001-alpha'), taskDocument('task-002-beta', { dependsOn: ['task-001-alpha'] })];

    await expect(readExecutionOrder(directory, PLAN_ID, tasks)).resolves.toEqual({
      planId: PLAN_ID,
      phases: [{ parallel: ['task-001-alpha'] }, { parallel: ['task-002-beta'] }],
    });
  });

  it('allows the same normalized write-scope path across different phases', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha'], ['task-002-beta']]));
    const tasks = [
      taskDocument('task-001-alpha', { writeScope: ['src/shared.ts'] }),
      taskDocument('task-002-beta', { writeScope: ['src/shared.ts'] }),
    ];

    const schedule = await readExecutionOrder(directory, PLAN_ID, tasks);

    expect(schedule.planId).toBe(PLAN_ID);
    expect(schedule.phases).toEqual([{ parallel: ['task-001-alpha'] }, { parallel: ['task-002-beta'] }]);
  });

  it('fails when the schedule file is missing and names the path', async () => {
    const directory = await planDirectory(null);
    const message = await errorMessage(readExecutionOrder(directory, PLAN_ID, [taskDocument('task-001-alpha')]));

    expect(message).toMatch(/Missing execution order/i);
    expect(message).toContain('execution-order.yaml');
  });

  it('rejects a declared plan_id that differs from the task set plan', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml('20260999-other', [['task-001-alpha']]));

    await expect(readExecutionOrder(directory, PLAN_ID, [taskDocument('task-001-alpha')])).rejects.toThrow(/Execution order plan_id mismatch/i);
  });

  it('rejects malformed YAML', async () => {
    const directory = await planDirectory('plan_id: [unclosed\n');

    await expect(readExecutionOrder(directory, PLAN_ID, [taskDocument('task-001-alpha')])).rejects.toThrow(/Malformed execution order YAML/i);
  });

  const invalidShapes: [string, string][] = [
    ['missing phases', `plan_id: ${PLAN_ID}\n`],
    ['empty phases', `plan_id: ${PLAN_ID}\nphases: []\n`],
    ['non-array phases', `plan_id: ${PLAN_ID}\nphases: nope\n`],
    ['phase without parallel', `plan_id: ${PLAN_ID}\nphases:\n  - {}\n`],
    ['empty parallel', `plan_id: ${PLAN_ID}\nphases:\n  - parallel: []\n`],
    ['non-array parallel', `plan_id: ${PLAN_ID}\nphases:\n  - parallel: nope\n`],
    ['parallel with a non-string entry', `plan_id: ${PLAN_ID}\nphases:\n  - parallel:\n      - 123\n`],
  ];

  it.each(invalidShapes)('rejects an invalid schedule shape: %s', async (_label, order) => {
    const directory = await planDirectory(order);

    await expect(readExecutionOrder(directory, PLAN_ID, [taskDocument('task-001-alpha')])).rejects.toThrow(/Invalid execution order shape/i);
  });

  it('rejects a scheduled task id that is not in the task set', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha'], ['task-002-beta', 'task-999-ghost']]));
    const tasks = [taskDocument('task-001-alpha'), taskDocument('task-002-beta', { dependsOn: ['task-001-alpha'] })];

    await expect(readExecutionOrder(directory, PLAN_ID, tasks)).rejects.toThrow(/Unknown task in execution order/i);
  });

  it.each([
    ['in one phase', [['task-001-alpha', 'task-001-alpha']]],
    ['across phases', [['task-001-alpha'], ['task-001-alpha']]],
  ])('rejects a task id listed twice %s', async (_label, phases) => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, phases));

    await expect(readExecutionOrder(directory, PLAN_ID, [taskDocument('task-001-alpha')])).rejects.toThrow(/Duplicate task in execution order/i);
  });

  it('rejects a task set entry omitted from the schedule', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha']]));

    await expect(readExecutionOrder(directory, PLAN_ID, [taskDocument('task-001-alpha'), taskDocument('task-002-beta')])).rejects.toThrow(/Task missing from execution order/i);
  });

  it('rejects a dependency whose target is in the same phase', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha', 'task-002-beta']]));
    const tasks = [taskDocument('task-001-alpha'), taskDocument('task-002-beta', { dependsOn: ['task-001-alpha'] })];

    await expect(readExecutionOrder(directory, PLAN_ID, tasks)).rejects.toThrow(/Dependency in the same phase/i);
  });

  it('rejects a dependency whose target is in a later phase', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, [['task-002-beta'], ['task-001-alpha']]));
    const tasks = [taskDocument('task-001-alpha'), taskDocument('task-002-beta', { dependsOn: ['task-001-alpha'] })];

    await expect(readExecutionOrder(directory, PLAN_ID, tasks)).rejects.toThrow(/Dependency in a later phase/i);
  });

  it('rejects overlapping write scopes inside one phase and reports the phase and path', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha', 'task-002-beta']]));
    const tasks = [
      taskDocument('task-001-alpha', { writeScope: ['src/shared.ts'] }),
      taskDocument('task-002-beta', { writeScope: ['src/shared.ts'] }),
    ];

    const message = await errorMessage(readExecutionOrder(directory, PLAN_ID, tasks));

    expect(message).toMatch(/Overlapping write scope in phase 1\b/i);
    expect(message).toContain('src/shared.ts');
  });

  it('rejects a write scope contained in another write scope inside one phase and names the overlapping path', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha', 'task-002-beta']]));
    const tasks = [
      taskDocument('task-001-alpha', { writeScope: ['src/workflow'] }),
      taskDocument('task-002-beta', { writeScope: ['src/workflow/order.ts'] }),
    ];

    const message = await errorMessage(readExecutionOrder(directory, PLAN_ID, tasks));

    expect(message).toMatch(/Overlapping write scope in phase 1\b/i);
    expect(message).toContain('src/workflow/order.ts');
  });

  it('rejects a write scope that duplicates another after normalization inside one phase', async () => {
    const directory = await planDirectory(renderExecutionOrderYaml(PLAN_ID, [['task-001-alpha', 'task-002-beta']]));
    const tasks = [
      taskDocument('task-001-alpha', { writeScope: ['./src/shared.ts'] }),
      taskDocument('task-002-beta', { writeScope: ['src/shared.ts'] }),
    ];

    const message = await errorMessage(readExecutionOrder(directory, PLAN_ID, tasks));

    expect(message).toMatch(/Overlapping write scope in phase 1\b/i);
    expect(message).toContain('src/shared.ts');
  });
});
