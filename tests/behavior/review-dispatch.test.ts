import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { packagePath } from '../../src/utils/schema.js';

const reference = 'templates/skills/coding/references/review.md';
const spec = 'templates/agents/spec-review.md';
const standards = 'templates/agents/standards-review.md';
const coding = 'templates/skills/coding/SKILL.md';

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

function packet(text: string, heading: string): string {
  const section = text.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';
  const body = /```text\n([\s\S]*?)\n```/.exec(section)?.[1];
  if (!body) throw new Error(`Missing review packet: ${heading}`);
  return body;
}

// Public prompt artifacts are the product boundary. These checks verify the dispatched
// examples and obligations; they do not claim a live model follows every instruction.
describe('role-specific review dispatch', () => {
  it('ships distinct initial and recheck packets with absolute raw-evidence references', async () => {
    const text = await read(reference);
    for (const role of ['Spec', 'Standards']) {
      for (const mode of ['initial', 'recheck']) {
        const body = packet(text, `${role} ${mode}`);
        expect(body).toContain(`mode: ${mode}`);
        expect(body).toMatch(/^repository: <absolute /m);
        expect(body).toMatch(/^contract: <absolute /m);
        expect(body).toMatch(/^base_commit: /m);
        expect(body).toMatch(/^head_commit: /m);
        expect(body).toMatch(/^raw_diff: <absolute /m);
        expect(body).toMatch(/^source_blobs: <absolute /m);
        expect(body).not.toMatch(/^(?:task_ref|plan|allowed_commands|write_scope):/m);
        if (mode === 'recheck') {
          expect(body).toMatch(/^previous_head: /m);
          expect(body).toMatch(/^repair_diff: <absolute /m);
          expect(body).toMatch(/^repair_scope: /m);
        } else {
          expect(body).not.toMatch(/^(?:previous_head|repair_diff|original_findings):/m);
        }
      }
    }
  });

  it('keeps Spec blind to prior verdicts and runtime reports while Standards receives closure evidence', async () => {
    const text = await read(reference);
    for (const mode of ['initial', 'recheck']) {
      const body = packet(text, `Spec ${mode}`);
      expect(body).toMatch(/^requirements: <absolute /m);
      expect(body).toMatch(/^requirement_scope: /m);
      expect(body).not.toMatch(/^(?:memory|note_standards|test_reports|original_findings|accepted_results):/m);
      const standardsBody = packet(text, `Standards ${mode}`);
      expect(standardsBody).toMatch(/^memory: <absolute /m);
      expect(standardsBody).toMatch(/^test_reports: <absolute /m);
    }
    expect(packet(text, 'Standards recheck')).toMatch(/^original_findings: /m);
    expect(await read(coding)).toContain('references/review.md');
  });

  it('requires complete first-pass coverage and preserves findings over report length', async () => {
    for (const path of [spec, standards]) {
      const text = await read(path);
      expect(text).toMatch(/continue[^.]*after[^.]*blocker/i);
      expect(text).toMatch(/unreviewed[^.]*missing/i);
      expect(text).toMatch(/complete findings take precedence over the length target/i);
    }
  });

  it('compares the prior reviewed tree with the repair instead of guessing finding provenance', async () => {
    for (const path of [spec, standards, reference]) {
      const text = await read(path);
      expect(text).toContain('previous_head');
      expect(text).toContain('present-at-previous-head');
      expect(text).toContain('repair-introduced');
      expect(text).toContain('unknown');
    }
    for (const path of [
      'templates/project/AGENTS.md', coding,
      'templates/skills/coding/references/workspace.md', 'templates/agents/git-operator.md',
    ]) expect(await read(path), path).toContain('previous_head');
  });

  it('requires reachable behavior and a cited expectation without suppressing rare defects', async () => {
    const text = await read(standards);
    expect(text).toMatch(/supported[^.]*reachab/i);
    expect(text).toMatch(/expected behavior[^.]*public contract|public contract[^.]*expected behavior/i);
    expect(text).toMatch(/rare[^.]*report/i);
    expect(text).toMatch(/speculative or unreachable[^.]*not[^.]*finding/i);
  });

  it('bounds repair cycles, selects axes by repair impact, and blocks unsupported acceptance', async () => {
    for (const path of ['templates/project/AGENTS.md', coding]) {
      const text = (await read(path)).replace(/\s+/g, ' ');
      expect(text).toContain('at most two repair/recheck cycles');
      expect(text).toMatch(/affected axes[^.]*repair impact/i);
      expect(text).toMatch(/budget[^.]*exhausted[^.]*block|block[^.]*budget[^.]*exhausted/i);
      expect(text).toMatch(/no progress[^.]*stop|stop[^.]*no progress/i);
      expect(text).not.toMatch(/no second repair or review loop/i);
    }
    const text = await read(reference);
    expect(text).toMatch(/missed[^.]*initial review|initial-review omission/i);
    expect(text).toMatch(/missing[^.]*material[^.]*budget|budget[^.]*missing[^.]*material/i);
  });
});
