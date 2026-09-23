import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Behavior boundary: the shipped text of the coding skill and the installed project
// contract/memory templates. Assertions read the same files as coding-v2-content.test.ts.

const RECORD_PATH = '.ai-workflow/plans/<planId>/implementation.yaml';
const LEADING_BAN = 'Do not generate workflow manifests or run records';

async function codingSkill(): Promise<string> {
  return readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
}

async function projectContractTemplate(): Promise<string> {
  return readFile(packagePath('templates', 'project', 'AGENTS.md'), 'utf8');
}

async function projectMemoryTemplate(): Promise<string> {
  return readFile(packagePath('templates', 'project', 'MEMORY.md'), 'utf8');
}

/** Whitespace-normalized text so assertions are insensitive to wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The blank-line separated block that names the record path, whitespace-normalized. */
function recordParagraph(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map(flatten)
    .find((paragraph) => paragraph.includes('implementation.yaml')) ?? '';
}

/** Sentences split on terminal punctuation, whitespace-normalized. */
function sentences(text: string): string[] {
  return flatten(text)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 0);
}

/**
 * Substantive exemption check: the named record must be scoped to a single permitted
 * exception in the same block that names its path, not left as a blanket permission.
 */
function assertScopedExemption(text: string, label: string): void {
  const paragraph = recordParagraph(text);
  expect(paragraph, `${label}: the block must name the record path`).toContain('implementation.yaml');
  expect(
    paragraph,
    `${label}: the record must be scoped as the only permitted exception`,
  ).toMatch(/\b(?:only|sole|single|exclusive|except(?:ion)?|other than)\b/i);
  expect(
    paragraph,
    `${label}: the exemption must be about the run record it permits`,
  ).toMatch(/\b(?:run record|implementation record|runtime artifact|workflow artifact)\b/i);
  // The record itself must never be forbidden, only the extra manifests/run records.
  expect(
    text,
    `${label}: nothing may forbid creating the implementation record`,
  ).not.toMatch(
    /(?:must not|never|do not|does not|no)\s+(?:create|generate|write|produce)\s+(?:the\s+)?(?:implementation record|`?implementation\.yaml`?)/i,
  );
}

describe('implementation record guidance', () => {
  describe('coding skill', () => {
    it('names the project-root record path and the start timing before the first step', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toContain('<project>');
      expect(coding).toContain(RECORD_PATH);
      expect(coding).toMatch(
        /(?:before|prior to)[^.]{0,80}\bfirst\b[^.]{0,40}\b(?:implementation )?step/i,
      );
    });

    it('writes plan_id, status in-progress and an ISO 8601 started_at with no completion field', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toContain('plan_id');
      expect(coding).toMatch(/\bin-progress\b/);
      expect(coding).toContain('started_at');
      expect(coding).toMatch(/ISO[ -]?8601/i);
      expect(coding, 'the start record must carry no completed_at').toMatch(
        /(?:no|without|not?|omit\w*)\b[^.]{0,60}completed_at/i,
      );
    });

    it('pins every record timestamp to the UTC+08:00 timezone', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toMatch(/UTC\+08:00/);
      expect(coding).toMatch(/`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00`/);
    });

    it('updates the same file to completed after the final merge and the owned cleanup', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toMatch(
        /(?:after|once|when)[^.]{0,140}\bmerge\b[^.]{0,140}\bclean(?:up|ing)?\b/i,
      );
      expect(coding).toMatch(/status[^.]{0,40}\bcompleted\b|\bcompleted\b[^.]{0,40}status/i);
      expect(coding).toContain('completed_at');
      expect(coding).toMatch(/\b(?:final\s+)?commit\s+(?:SHA|hash)\b/i);
    });

    it('preserves plan_id and started_at, is idempotent, and recovers a missing start', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toMatch(/\b(?:preserv\w+|keep\w*|retain\w*)\b[^.]{0,80}\bplan_id\b/i);
      expect(coding).toMatch(/\b(?:preserv\w+|keep\w*|retain\w*)\b[^.]{0,80}\bstarted_at\b/i);
      expect(coding).toMatch(/\bidempotent\b/i);
      expect(coding).toMatch(
        /(?:missing|absent|not found)[^.]{0,120}\bstarted_at\b|\bstarted_at\b[^.]{0,120}(?:missing|absent|omitted)/i,
      );
      expect(coding).toMatch(/\bomits?\b[^.]{0,60}started_at|\bwithout\b[^.]{0,40}started_at/i);
    });

    it('leaves an interrupted run at in-progress with only the start fields and no failure reason', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toMatch(
        /(?:interrupt\w*|abort\w*)[^.]{0,160}\bin-progress\b|\bin-progress\b[^.]{0,160}(?:interrupt\w*|abort\w*)/i,
      );
      expect(coding, 'an interrupted record must not carry a failure reason').toMatch(
        /(?:no|never|without|not)\b[^.]{0,60}\b(?:failure|abandon\w*)\b/i,
      );
    });

    it('rewrites an interrupted record as completed when the plan is later implemented successfully', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toMatch(
        /(?:later|subsequent\w*)[^.]{0,120}\bcompleted\b|\bcompleted\b[^.]{0,120}(?:later|subsequent\w*)/i,
      );
    });

    it('declares exactly the two status values and no terminal failure status', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toMatch(/\bin-progress\b/);
      expect(coding).toMatch(/\bcompleted\b/);
      expect(coding).toMatch(
        /(?:only|two)\b[^.]{0,60}\bstatus(?:es)?\b|\bstatus(?:es)?\b[^.]{0,60}\b(?:only|two)\b/i,
      );
      expect(coding, 'the record must not define a failure-like status value').not.toMatch(
        /\bstatus\s*[:=]?\s*(?:failed|failure|abandoned|blocked|cancelled|canceled)\b/i,
      );
    });

    it('creates the record only for a frozen plan and never for an unfrozen small fix', async () => {
      const coding = flatten(await codingSkill());
      const clauses = sentences(coding);

      expect(
        clauses.some(
          (clause) =>
            /\bfrozen\b/i.test(clause) &&
            /\b(?:only|sole|single|exclusive)\b/i.test(clause) &&
            /\brecord\b/i.test(clause),
        ),
        'the skill must scope the record to a frozen plan only',
      ).toBe(true);
      expect(
        clauses.some(
          (clause) =>
            /\bfrozen\b/i.test(clause) &&
            /\brecord\b/i.test(clause) &&
            /\b(?:no|not|never|without|unless)\b/i.test(clause),
        ),
        'the skill must deny the record without a frozen plan',
      ).toBe(true);
    });

    it('scopes the record as the only permitted run record while keeping the leading ban', async () => {
      const coding = await codingSkill();

      expect(
        flatten(coding),
        'the existing coding-v2-content contract sentence must stay intact',
      ).toContain(LEADING_BAN);
      assertScopedExemption(coding, 'coding skill');
    });
  });

  describe('installed project contract and memory templates', () => {
    it('states the same record path and scoped exemption in templates/project/AGENTS.md', async () => {
      const contract = await projectContractTemplate();

      expect(contract).toContain(RECORD_PATH);
      assertScopedExemption(contract, 'templates/project/AGENTS.md');
    });

    it('states the same record path and scoped exemption in templates/project/MEMORY.md', async () => {
      const memory = await projectMemoryTemplate();

      expect(memory).toContain(RECORD_PATH);
      assertScopedExemption(memory, 'templates/project/MEMORY.md');
    });

    it('states the same UTC+08:00 timestamp rule in both project templates', async () => {
      expect(flatten(await projectContractTemplate())).toMatch(/UTC\+08:00/);
      expect(flatten(await projectMemoryTemplate())).toMatch(/UTC\+08:00/);
    });
  });
});
