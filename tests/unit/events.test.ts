import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLog, readEventLog, type EventDraft } from '../../src/runtime/events.js';

const runId = 'run-events';
const draft: EventDraft = { type: 'run/start', payload: { state: 'preflight' } };

async function temporaryLog(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'ai-workflow-events-')), 'events.jsonl');
}

describe('durable event log', () => {
  it('assigns ordered run metadata and rebuilds state from events', async () => {
    const path = await temporaryLog();
    const log = new EventLog({ path, runId, fencingEpoch: 3 });

    const started = await log.append(draft);
    const ended = await log.append({ type: 'run/end', payload: { stop_reason: 'completed' } });
    const projection = await log.rebuildState();

    expect(started).toMatchObject({ event_version: '2.0.0', seq: 1, run_id: runId, fencing_epoch: 3, type: 'run/start' });
    expect(ended.seq).toBe(2);
    expect(projection).toMatchObject({ run_id: runId, fencing_epoch: 3, last_seq: 2, run_state: 'complete' });
  });

  it('serializes concurrent submissions for one run', async () => {
    const path = await temporaryLog();
    const log = new EventLog({ path, runId, fencingEpoch: 1 });

    const events = await Promise.all([
      log.append(draft),
      log.append({ type: 'workflow/phase', payload: { title: 'phase' } }),
      log.append({ type: 'workflow/log', payload: { message: 'message' } }),
    ]);

    expect(events.map((event) => event.seq).sort((left, right) => left - right)).toEqual([1, 2, 3]);
    await expect(log.read()).resolves.toMatchObject({ next_seq: 4, tail_interrupted: false });
  });

  it('rejects an unknown event tag before it reaches the authority log', async () => {
    const path = await temporaryLog();
    const log = new EventLog({ path, runId, fencingEpoch: 1 });

    await expect(log.append({ type: 'run/unknown' as EventDraft['type'], payload: {} })).rejects.toThrow(/unknown event type/i);
    await expect(readEventLog(path, { runId, fencingEpoch: 1 })).resolves.toMatchObject({ events: [], tail_interrupted: false });
  });

  it('rejects duplicate and out-of-order authority events', async () => {
    const path = await temporaryLog();
    const log = new EventLog({ path, runId, fencingEpoch: 1 });
    const first = await log.append(draft);
    const second = { ...first, seq: 1, type: 'run/end' as const, payload: { stop_reason: 'completed' as const } };
    await writeFile(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

    await expect(readEventLog(path, { runId, fencingEpoch: 1 })).rejects.toThrow(/sequence/i);
  });

  it('reports an interrupted final JSONL record without accepting it as a fact', async () => {
    const path = await temporaryLog();
    const log = new EventLog({ path, runId, fencingEpoch: 1 });
    const first = await log.append(draft);
    await writeFile(path, `${JSON.stringify(first)}\n{"event_version":"2.0.0","seq":2`);

    const result = await readEventLog(path, { runId, fencingEpoch: 1 });
    expect(result).toMatchObject({ tail_interrupted: true, next_seq: 2, events: [first] });
    await expect(log.append({ type: 'workflow/log', payload: { message: 'must wait' } })).rejects.toMatchObject({ code: 'EVENT_TAIL_INTERRUPTED' });
  });

  it('rejects an event whose fencing epoch or run identity is not owned by the log', async () => {
    const path = await temporaryLog();
    const log = new EventLog({ path, runId, fencingEpoch: 2 });
    const event = await log.append(draft);
    await writeFile(path, `${JSON.stringify({ ...event, run_id: 'other-run' })}\n`);

    await expect(readEventLog(path, { runId, fencingEpoch: 2 })).rejects.toThrow(/run_id/i);
  });

  it('reports an append failure without creating a partial event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-events-'));
    const blocker = join(directory, 'file');
    await writeFile(blocker, 'not a directory');
    const log = new EventLog({ path: join(blocker, 'events.jsonl'), runId, fencingEpoch: 1 });

    await expect(log.append(draft)).rejects.toThrow();
  });
});
