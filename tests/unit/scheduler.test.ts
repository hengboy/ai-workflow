import { describe, expect, it } from 'vitest';
import { ScopeScheduler } from '../../src/runtime/scheduler.js';

describe('scope scheduler', () => {
  it('admits non-conflicting actions within the configured concurrency bound', async () => {
    const scheduler = new ScopeScheduler({ maxConcurrent: 2 });
    const first = await scheduler.submit({
      admission_id: 'call-1',
      call_ordinal: 1,
      action_id: 'read-app',
      task_id: 'task-1',
      read_scope: ['src/app'],
      write_scope: [],
    });
    const second = await scheduler.submit({
      admission_id: 'call-2',
      call_ordinal: 2,
      action_id: 'read-application',
      task_id: 'task-2',
      read_scope: ['src/application'],
      write_scope: [],
    });

    expect(first.admission_ordinal).toBe(1);
    expect(second.admission_ordinal).toBe(2);
    expect(scheduler.activeCount).toBe(2);
    first.release('completed');
    scheduler.finalizeTask('task-1', 'finalized');
    second.release('completed');
    scheduler.finalizeTask('task-2', 'finalized');
    expect(scheduler.activeCount).toBe(0);
  });

  it('rejects a conflicting action before admission when it shares a concurrency group', async () => {
    const scheduler = new ScopeScheduler({ maxConcurrent: 2 });
    const first = await scheduler.submit({
      admission_id: 'call-1',
      call_ordinal: 1,
      action_id: 'write-app-a',
      task_id: 'task-1',
      read_scope: ['src'],
      write_scope: ['src/app'],
      concurrency_group_id: 'parallel-1',
    });

    await expect(scheduler.submit({
      admission_id: 'call-2',
      call_ordinal: 2,
      action_id: 'write-app-b',
      task_id: 'task-1',
      read_scope: ['src'],
      write_scope: ['src/app/components'],
      concurrency_group_id: 'parallel-1',
    })).rejects.toMatchObject({ code: 'PARALLEL_SCOPE_CONFLICT' });
    expect(scheduler.activeCount).toBe(1);
    first.release('completed');
  });

  it('admits outside-group conflicts in submission FIFO order', async () => {
    const scheduler = new ScopeScheduler({ maxConcurrent: 1 });
    const first = await scheduler.submit({ admission_id: 'call-1', call_ordinal: 1, action_id: 'write-a', task_id: 'task-1', read_scope: [], write_scope: ['src/app'], concurrency_group_id: 'group-1' });
    const secondPromise = scheduler.submit({ admission_id: 'call-2', call_ordinal: 2, action_id: 'write-b', task_id: 'task-2', read_scope: [], write_scope: ['src/app'], concurrency_group_id: 'group-2' });
    const thirdPromise = scheduler.submit({ admission_id: 'call-3', call_ordinal: 3, action_id: 'write-c', task_id: 'task-3', read_scope: [], write_scope: ['src/app'], concurrency_group_id: 'group-3' });

    first.release('completed');
    scheduler.finalizeTask('task-1', 'finalized');
    const second = await secondPromise;
    expect(second.admission_ordinal).toBe(2);
    let thirdAdmitted = false;
    void thirdPromise.then(() => { thirdAdmitted = true; });
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    second.release('completed');
    scheduler.finalizeTask('task-2', 'finalized');
    const third = await thirdPromise;
    expect(third.admission_ordinal).toBe(3);
    third.release('completed');
    scheduler.finalizeTask('task-3', 'finalized');
  });

  it('cancels a queued admission without changing release ordering', async () => {
    const scheduler = new ScopeScheduler({ maxConcurrent: 1 });
    const first = await scheduler.submit({ admission_id: 'call-1', call_ordinal: 1, action_id: 'write-a', task_id: 'task-1', read_scope: [], write_scope: ['src/app'] });
    const queued = scheduler.submit({ admission_id: 'call-2', call_ordinal: 2, action_id: 'write-b', task_id: 'task-2', read_scope: [], write_scope: ['src/app'] });
    expect(scheduler.cancel('call-2')).toBe(true);
    await expect(queued).rejects.toMatchObject({ code: 'ACTION_CANCELLED' });
    expect(scheduler.trace).toContain('cancel:call-2');
    first.release('completed');
    expect(scheduler.activeCount).toBe(0);
  });

  it('keeps a task write lease until the task reaches a terminal state', async () => {
    const scheduler = new ScopeScheduler({ maxConcurrent: 2 });
    const first = await scheduler.submit({ admission_id: 'call-1', call_ordinal: 1, action_id: 'write-a', task_id: 'task-1', read_scope: [], write_scope: ['src/app'] });
    first.release('completed');
    const blocked = scheduler.submit({ admission_id: 'call-2', call_ordinal: 2, action_id: 'write-b', task_id: 'task-2', read_scope: [], write_scope: ['src/app/components'] });
    let admitted = false;
    void blocked.then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    scheduler.finalizeTask('task-1', 'finalized');
    const second = await blocked;
    expect(second.admission_ordinal).toBe(2);
    second.release('completed');
  });

  it('uses component prefixes for read/write conflicts', async () => {
    const scheduler = new ScopeScheduler({ maxConcurrent: 2 });
    const first = await scheduler.submit({ admission_id: 'call-1', call_ordinal: 1, action_id: 'write-a', task_id: 'task-1', read_scope: [], write_scope: ['src/app'] });
    const unrelated = await scheduler.submit({ admission_id: 'call-2', call_ordinal: 2, action_id: 'read-application', task_id: 'task-2', read_scope: ['src/application'], write_scope: [] });
    expect(scheduler.activeCount).toBe(2);
    first.release('completed');
    unrelated.release('completed');
  });

  it('rejects same-group conflicts even when the first action is queued', async () => {
    const scheduler = new ScopeScheduler({ maxConcurrent: 1 });
    const holder = await scheduler.submit({ admission_id: 'call-holder', call_ordinal: 1, action_id: 'write-holder', task_id: 'task-holder', read_scope: [], write_scope: ['docs'] });
    const firstQueued = scheduler.submit({ admission_id: 'call-1', call_ordinal: 2, action_id: 'write-a', task_id: 'task-1', read_scope: [], write_scope: ['src/app'], concurrency_group_id: 'parallel-1' });

    await expect(scheduler.submit({ admission_id: 'call-2', call_ordinal: 3, action_id: 'write-b', task_id: 'task-2', read_scope: [], write_scope: ['src/app/components'], concurrency_group_id: 'parallel-1' })).rejects.toMatchObject({ code: 'PARALLEL_SCOPE_CONFLICT' });
    scheduler.cancel('call-1');
    await expect(firstQueued).rejects.toMatchObject({ code: 'ACTION_CANCELLED' });
    holder.release('completed');
  });
});
