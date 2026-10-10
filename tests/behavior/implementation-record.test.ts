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

/** Sentences split on terminal punctuation, whitespace-normalized. */
function sentences(text: string): string[] {
  return flatten(text)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 0);
}

/**
 * Substantive exemption check: some block that names the record path must scope it as a
 * single permitted exception about the run record, not left as a blanket permission. A
 * document may carry other `implementation.yaml` blocks (for example the workspace root
 * delivery rule), so every naming block is inspected rather than only the first.
 */
function assertScopedExemption(text: string, label: string): void {
  const naming = text
    .split(/\n\s*\n/)
    .map(flatten)
    .filter((paragraph) => paragraph.includes('implementation.yaml'));
  expect(naming.length, `${label}: a block must name the record path`).toBeGreaterThan(0);
  const scoped = naming.filter((paragraph) => /\b(?:only|sole|single|exclusive|except(?:ion)?|other than)\b/i.test(paragraph));
  const exemptions = scoped.filter((paragraph) => /\b(?:run record|implementation record|runtime artifact|workflow artifact)\b/i.test(paragraph));
  expect(
    exemptions.length,
    `${label}: a block naming the record must scope it as the only permitted run record`,
  ).toBeGreaterThan(0);
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

    it('leaves an interrupted run at in-progress with no failure reason', async () => {
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

    it('keeps the generated run-record contract out of the project-owned MEMORY scaffolding', async () => {
      const memory = await projectMemoryTemplate();

      // The MEMORY template is project-content scaffolding only; generic workflow obligations
      // such as the run record belong to the generated project contract.
      expect(memory, 'the MEMORY scaffolding must not embed the generated run record').not.toContain(RECORD_PATH);
      expect(memory, 'the MEMORY scaffolding must not embed the generated run record').not.toContain('implementation.yaml');
      expect(memory, 'the MEMORY scaffolding must not embed the generated timestamp rule').not.toMatch(/UTC\+08:00/);
    });

    it('states the UTC+08:00 timestamp rule in the generated project contract', async () => {
      expect(flatten(await projectContractTemplate())).toMatch(/UTC\+08:00/);
    });
  });

  describe('workspace root delivery record', () => {
    it('keeps the same root record in-progress and pins root_tasks_commit when root tasks are delivered', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toContain('root_tasks_commit');
      expect(coding).toMatch(/\bin-progress\b/);
      expect(coding).toMatch(/root[- ]owned|root task/i);
    });

    it('represents root task delivery as one record with no new status', async () => {
      const coding = flatten(await codingSkill());

      expect(coding).toMatch(/one record|same record|single record/i);
      expect(coding).toMatch(/no new status|without a new status/i);
    });
  });
});

/**
 * REQ-006: the workspace execution record reuses the single `implementation.yaml` per
 * repository and adds a purpose-scoped execution anchor, typed task checkpoints and a
 * purpose-scoped reviewed commit. The contract text may live in the coding skill or its
 * detailed workspace reference, so both are combined.
 */
describe('workspace execution record contract', () => {
  async function workspaceRecordText(): Promise<string> {
    const coding = await codingSkill();
    let reference = '';
    try {
      reference = await readFile(packagePath('templates', 'skills', 'coding', 'references', 'workspace.md'), 'utf8');
    } catch {
      reference = '';
    }
    return flatten(`${coding}\n${reference}`);
  }

  it('keeps the single implementation.yaml as the only workspace run record', async () => {
    const text = await workspaceRecordText();

    expect(text).toContain(RECORD_PATH);
    expect(text).toMatch(/single|one|only/i);
    expect(text).toMatch(/no (?:extra|other|additional)[^.]{0,40}(?:run record|ledger|manifest)/i);
  });

  it('documents the execution anchor with purpose, repository, worktree, branches and base commit', async () => {
    const text = await workspaceRecordText();

    for (const field of ['execution', 'purpose', 'source_root', 'repository', 'worktree', 'branch', 'target_branch', 'base_commit']) {
      expect(text, `the workspace execution record documents "${field}"`).toContain(field);
    }
    expect(text, 'the anchor purpose distinguishes tasks from finalization').toMatch(/tasks[^.]{0,40}finalization|finalization[^.]{0,40}tasks/i);
  });

  it('documents typed task checkpoints for committed changes and verified no-change outcomes', async () => {
    const text = await workspaceRecordText();

    expect(text).toContain('task_checkpoints');
    expect(text).toMatch(/kind: commit/i);
    expect(text).toMatch(/kind: no-change/i);
    expect(text, 'a writing task records its commit SHA').toMatch(/commit[^.]{0,60}(?:SHA|hash|full)/i);
    expect(text, 'an unchanged task records its exact HEAD').toMatch(/head[^.]{0,60}(?:SHA|hash|exact)/i);
  });

  it('documents a purpose-scoped reviewed_commit that cannot be reused for other material', async () => {
    const text = await workspaceRecordText();

    expect(text).toContain('reviewed_commit');
    expect(text, 'the review marker is scoped to the current purpose').toMatch(/purpose[- ]scoped|current purpose/i);
    expect(text, 'a different purpose or HEAD cannot reuse the review').toMatch(/cannot[^.]{0,80}(?:reuse|authorize)|not[^.]{0,80}(?:reuse|authorize)/i);
  });

  it('writes checkpoints only through the workspace checkpoint CLI after Git evidence', async () => {
    const text = await workspaceRecordText();

    expect(text).toContain('ai-workflow workspace checkpoint --plan <directory> --repo <name>');
    expect(text, 'checkpointing follows Git evidence').toMatch(/after[^.]{0,60}Git evidence/i);
    expect(text, 'the checkpoint command is filesystem-only').toMatch(/filesystem-only|filesystem only/i);
  });

  it('keeps only in-progress and completed statuses for the workspace execution record', async () => {
    const text = await workspaceRecordText();

    expect(text).toMatch(/\bin-progress\b/);
    expect(text).toMatch(/\bcompleted\b/);
    expect(text, 'the record must not define a failure-like status value').not.toMatch(
      /\bstatus\s*[:=]?\s*(?:failed|failure|abandoned|blocked|cancelled|canceled)\b/i,
    );
  });
});
