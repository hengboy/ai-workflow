import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// 20261019-memory-governance REQ-001..REQ-008: `MEMORY.md` becomes a current-state-only
// standards document. The rule states that the change which supersedes a statement
// rewrites it to the current state or removes it in the same change, that the recorded
// standards stay current as changes land, and that superseded history belongs to Git and
// Agent Notes rather than `MEMORY.md`. These are structural assertions over the shipped
// prompt and documentation surfaces; they prove the rule text and the delivered wording
// exist, not the semantic sufficiency of the prose, which review establishes.

const PLAN = '20261019-memory-governance';

// The governance-consistency plan registered the delivered note triplets and the archived
// migrated-record paths in the index; the navigation test below locks that registration.
const GOVERNANCE_PLAN = '20261019-governance-consistency';

const CONTRACT_PATHS = ['templates/project/AGENTS.md', '.ai-workflow/AGENTS.md'] as const;

// The exact currency statements the frozen plan lands in the contract section.
const CURRENCY_STATEMENTS = [
  "records only the project's current standards and behavior",
  'the change that supersedes a statement rewrites it to the current state or removes it in the same change',
  'the recorded standards stay current as changes land',
  'Superseded history belongs to Git and Agent Notes, never to `MEMORY.md`',
] as const;

/** Whitespace-normalized text so fragments match across source wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The raw slice from `marker` up to the first of `nextPrefixes` (or end of text). */
function sectionRaw(text: string, marker: string, nextPrefixes: readonly string[]): string {
  const start = text.indexOf(marker);
  if (start === -1) return '';
  const body = text.slice(start + marker.length);
  let end = -1;
  for (const prefix of nextPrefixes) {
    const at = body.indexOf(prefix);
    if (at !== -1 && (end === -1 || at < end)) end = at;
  }
  return end === -1 ? body : body.slice(0, end);
}

/** Raw Markdown slice of one level-two section, or '' when the heading is absent. */
function levelTwoRaw(text: string, heading: string): string {
  return sectionRaw(text, `\n## ${heading}\n`, ['\n## ']);
}

/** Raw Markdown slice of one level-three section, or '' when the heading is absent. */
function levelThreeRaw(text: string, heading: string): string {
  return sectionRaw(text, `\n### ${heading}\n`, ['\n## ', '\n### ']);
}

/** Flat text of one numbered procedure step, stopping at the next numbered step. */
function procedureStep(text: string, step: number): string {
  const procedure = levelTwoRaw(text, 'Procedure');
  const lines = procedure.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${step}. `));
  if (start === -1) return '';
  const collected: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (index > start && /^\d+\. /.test(line)) break;
    collected.push(line);
  }
  return flatten(collected.join('\n'));
}

describe('MEMORY currency rule in the shipped contract (REQ-001/AC-001)', () => {
  it('states the currency rule in the Shared context and maintenance section of both contract files', async () => {
    for (const path of CONTRACT_PATHS) {
      const raw = await readFile(packagePath(path), 'utf8');
      const section = levelTwoRaw(raw, 'Shared context and maintenance');
      const flat = flatten(section);

      expect(flat, `${PLAN} REQ-001/AC-001: ${path} carries the Shared context and maintenance section`).not.toBe('');
      for (const statement of CURRENCY_STATEMENTS) {
        expect(
          flat,
          `${PLAN} REQ-001/AC-001: ${path} flattened section contains "${statement}"`,
        ).toContain(statement);
      }

      // Raw wording checks: the same statements exist in the unflattened bytes.
      expect(
        section,
        `${PLAN} REQ-001/AC-001: ${path} raw section states the current-state-only rule`,
      ).toContain("records only the project's current standards and behavior");
      expect(
        section,
        `${PLAN} REQ-001/AC-001: ${path} raw section states the rewrite-or-remove-in-the-same-change rule`,
      ).toContain('rewrites it to the current state or removes it in the same change');
      expect(
        section,
        `${PLAN} REQ-001/AC-001: ${path} raw section states the stay-current-as-changes-land rule`,
      ).toContain('stay current as changes land');
      expect(
        section,
        `${PLAN} REQ-001/AC-001: ${path} raw section states history belongs to Git and Agent Notes`,
      ).toContain('Superseded history belongs to Git and Agent Notes');
    }
  });

  it('keeps the tracked mirror byte-identical to the shipped template', async () => {
    const templateBytes = await readFile(packagePath('templates/project/AGENTS.md'));
    const mirrorBytes = await readFile(packagePath('.ai-workflow/AGENTS.md'));

    expect(
      mirrorBytes.equals(templateBytes),
      `${PLAN} REQ-001/AC-001: .ai-workflow/AGENTS.md equals templates/project/AGENTS.md byte-for-byte`,
    ).toBe(true);
  });
});

describe('Documentation Maintainer carries the cleanup obligation (REQ-002/AC-002)', () => {
  it('extends procedure step 5 to rewrite or remove a superseded MEMORY statement in the same change', async () => {
    const raw = await readFile(packagePath('templates/agents/documentation-maintainer.md'), 'utf8');
    const step = procedureStep(raw, 5);

    expect(step, `${PLAN} REQ-002/AC-002: procedure step 5 exists`).not.toBe('');
    expect(step, `${PLAN} REQ-002/AC-002: step 5 names MEMORY.md`).toMatch(/MEMORY\.md/);
    expect(
      step,
      `${PLAN} REQ-002/AC-002: step 5 rewrites or removes a superseded statement in the same change that lands its replacement`,
    ).toMatch(
      /a superseded statement is rewritten to the current state or removed in the same change that lands its replacement/i,
    );
    expect(
      step,
      `${PLAN} REQ-002/AC-002: step 5 keeps the recorded standards current as changes land`,
    ).toMatch(/the recorded standards stay current as changes land/i);
    expect(
      step,
      `${PLAN} REQ-002/AC-002: step 5 keeps no superseded history`,
    ).toMatch(/keep no superseded history, which belongs to Git and Agent Notes/i);
  });
});

describe('Init bootstrap states the rule (REQ-003/AC-003)', () => {
  it('extends the Standards section of templates/project/MEMORY.md with the currency rule', async () => {
    const raw = await readFile(packagePath('templates/project/MEMORY.md'), 'utf8');
    const standards = flatten(levelTwoRaw(raw, 'Standards'));

    expect(standards, `${PLAN} REQ-003/AC-003: the Standards section exists`).not.toBe('');
    expect(
      standards,
      `${PLAN} REQ-003/AC-003: the Standards section rewrites or removes a superseded statement in the same change`,
    ).toMatch(
      /the change that supersedes a statement rewrites it to the current state or removes it in the same change/i,
    );
    expect(
      standards,
      `${PLAN} REQ-003/AC-003: the Standards section keeps the recorded standards current as changes land`,
    ).toMatch(/the recorded standards stay current as changes land/i);
    expect(
      standards,
      `${PLAN} REQ-003/AC-003: the Standards section keeps no superseded history`,
    ).toMatch(/superseded history belongs to Git and `\.ai-workflow\/notes\/`, never to `MEMORY\.md`/i);
  });
});

describe('README documents the rule and the four homes (REQ-004/AC-004)', () => {
  it('adds a ### MEMORY maintenance section stating the rule and its homes', async () => {
    const raw = await readFile(packagePath('README.md'), 'utf8');
    const section = flatten(levelThreeRaw(raw, 'MEMORY maintenance'));

    expect(section, `${PLAN} REQ-004/AC-004: README has a ### MEMORY maintenance section`).not.toBe('');
    expect(
      section,
      `${PLAN} REQ-004/AC-004: the section states the current-state-only rule`,
    ).toMatch(/records only the project's current standards and behavior/i);
    expect(
      section,
      `${PLAN} REQ-004/AC-004: the section states the rewrite-or-remove-in-the-same-change rule`,
    ).toMatch(/rewrites it to the current state or removes it in the same change/i);
    expect(
      section,
      `${PLAN} REQ-004/AC-004: the section states superseded history stays in Git and Agent Notes`,
    ).toMatch(/superseded history stays in Git and Agent Notes/i);

    // The four homes: contract section, role template, init bootstrap, MEMORY.md.
    expect(section, `${PLAN} REQ-004/AC-004: names the contract template`).toMatch(/templates\/project\/AGENTS\.md/);
    expect(section, `${PLAN} REQ-004/AC-004: names the contract section`).toMatch(/## Shared context and maintenance/);
    expect(section, `${PLAN} REQ-004/AC-004: names the role`).toMatch(/documentation-maintainer/);
    expect(section, `${PLAN} REQ-004/AC-004: names the init bootstrap file`).toMatch(/templates\/project\/MEMORY\.md/);
    expect(section, `${PLAN} REQ-004/AC-004: names the init bootstrap`).toMatch(/init bootstrap/i);
    expect(section, `${PLAN} REQ-004/AC-004: names MEMORY.md`).toMatch(/MEMORY\.md/);
  });
});

describe('README states the published synchronization reality (REQ-005/AC-005)', () => {
  it('replaces the expired publication statement with the current verified-remote behavior', async () => {
    const readme = flatten(await readFile(packagePath('README.md'), 'utf8'));

    expect(
      readme,
      `${PLAN} REQ-005/AC-005: README no longer contains "Until markerless templates are published"`,
    ).not.toContain('Until markerless templates are published');

    expect(
      readme,
      `${PLAN} REQ-005/AC-005: README states a real remote attempt fetches the five-file markerless snapshot`,
    ).toMatch(/fetches the five-file markerless snapshot/i);
    expect(
      readme,
      `${PLAN} REQ-005/AC-005: README states one immutable commit is pinned`,
    ).toMatch(/pins one immutable commit/i);
    expect(
      readme,
      `${PLAN} REQ-005/AC-005: README reports synchronized for the published upstream`,
    ).toMatch(/reports `?synchronized`?/i);
    expect(
      readme,
      `${PLAN} REQ-005/AC-005: README names the unavailable, incomplete or still-marked source condition`,
    ).toMatch(/an unavailable, incomplete or still-marked source/i);
    expect(
      readme,
      `${PLAN} REQ-005/AC-005: README reports unverified for that condition`,
    ).toMatch(/`?unverified`?/i);
    expect(
      readme,
      `${PLAN} REQ-005/AC-005: README states zero created/updated`,
    ).toMatch(/zero `?created`?\/`?updated`?/i);
    expect(
      readme,
      `${PLAN} REQ-005/AC-005: README makes no managed-freshness claim`,
    ).toMatch(/no managed-freshness claim/i);
  });
});

describe('Root MEMORY is current-state only and records the latest standards (REQ-006/AC-006)', () => {
  it('records the MEMORY currency standard with its homes', async () => {
    const memory = flatten(await readFile(packagePath('MEMORY.md'), 'utf8'));

    expect(
      memory,
      `${PLAN} REQ-006/AC-006: MEMORY records the currency rule`,
    ).toContain("records only the project's current standards and behavior");
    expect(
      memory,
      `${PLAN} REQ-006/AC-006: MEMORY states the rewrite-or-remove-in-the-same-change rule`,
    ).toContain('rewrites it to the current state or removes it in the same change');
    expect(
      memory,
      `${PLAN} REQ-006/AC-006: MEMORY states the stay-current-as-changes-land rule`,
    ).toContain('stay current as changes land');
    expect(
      memory,
      `${PLAN} REQ-006/AC-006: MEMORY states superseded history belongs to Git and Agent Notes`,
    ).toContain('superseded history belongs to Git and Agent Notes, never to `MEMORY.md`');

    // The currency standard names its homes.
    expect(
      memory,
      `${PLAN} REQ-006/AC-006: the currency standard names the contract`,
    ).toContain('.ai-workflow/AGENTS.md');
    expect(
      memory,
      `${PLAN} REQ-006/AC-006: the currency standard names the role template`,
    ).toContain('documentation-maintainer');
    expect(
      memory,
      `${PLAN} REQ-006/AC-006: the currency standard names the init bootstrap`,
    ).toContain('templates/project/MEMORY.md');
    expect(
      memory,
      `${PLAN} REQ-006/AC-006: the currency standard names README.md`,
    ).toContain('README.md');
  });

  it('records the mandatory-tone authoring standard with its shipped homes', async () => {
    const memory = flatten(await readFile(packagePath('MEMORY.md'), 'utf8'));

    expect(
      memory,
      `${PLAN} REQ-006/AC-006: MEMORY records the mandatory-tone standard`,
    ).toContain('Shipped workflow prompt templates use a mandatory tone');
    for (const token of ['`must`', '`required`', '`never`', '`only`']) {
      expect(
        memory,
        `${PLAN} REQ-006/AC-006: the tone standard names normative token ${token}`,
      ).toContain(token);
    }
    for (const hedge of ['`should`', '`consider`', '`try to`', '`when it improves`', '`if possible`']) {
      expect(
        memory,
        `${PLAN} REQ-006/AC-006: the tone standard names the absent soft hedge ${hedge}`,
      ).toContain(hedge);
    }
    expect(
      memory,
      `${PLAN} REQ-006/AC-006: may appears only in genuine permission or optional-field contexts`,
    ).toContain('`may` appears only in genuine permission or optional-field contexts');
    expect(
      memory,
      `${PLAN} REQ-006/AC-006: the tone standard names the shipped prompt templates and the deduplication note`,
    ).toContain(
      'This standard lives in the shipped prompt templates and `.ai-workflow/notes/implemented/process/2026-10-18-skill-prompt-deduplication.md`',
    );
  });

  it('matches none of the banned history phrases', async () => {
    const memory = flatten(await readFile(packagePath('MEMORY.md'), 'utf8'));
    const banned = /was removed|were removed|are removed|no longer|previously|retired/i;
    const match = memory.match(banned);

    expect(
      match,
      `${PLAN} REQ-006/AC-006: root MEMORY.md must not match the banned oracle ${banned}`,
    ).toBeNull();
  });
});

// The delivered note triplets and the two migrated records the governance-consistency plan
// registered in the index. The archived directory is the migrated records' sealed home.
const MEMORY_SINGLE_SOURCE_TRIPLET = [
  '.ai-workflow/notes/implemented/process/2026-10-19-memory-single-source.md',
  '.ai-workflow/notes/implemented/process/2026-10-19-memory-single-source.zh.md',
  '.ai-workflow/notes/implemented/process/2026-10-19-memory-single-source.i18n.yaml',
] as const;

const ARCHIVE_RETENTION_TRIPLET = [
  '.ai-workflow/notes/implemented/process/2026-10-19-archive-retention.md',
  '.ai-workflow/notes/implemented/process/2026-10-19-archive-retention.zh.md',
  '.ai-workflow/notes/implemented/process/2026-10-19-archive-retention.i18n.yaml',
] as const;

const MIGRATED_RECORDS = [
  '2026-09-17-migrate-retired-adr-records-to-notes',
  '2026-09-14-localize-adr-prose-at-install-time',
] as const;

/** Every string reachable from a parsed JSON value, in object traversal order. */
function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}

describe('Navigation registers the feature (REQ-007/AC-007)', () => {
  it('exposes a shared memory-governance feature whose entries and tests include the delivered surfaces', async () => {
    const navigation = JSON.parse(
      await readFile(packagePath('.ai-workflow/index/navigation.json'), 'utf8'),
    ) as {
      features?: Array<{ id?: string; owner_role?: string; entries?: string[]; tests?: string[] }>;
    };

    const feature = navigation.features?.find((candidate) => candidate.id === 'memory-governance');
    expect(
      feature,
      `${PLAN} REQ-007/AC-007: navigation.json has a memory-governance feature`,
    ).toBeDefined();
    expect(
      feature?.owner_role,
      `${PLAN} REQ-007/AC-007: the memory-governance feature is owned by shared`,
    ).toBe('shared');

    for (const entry of [
      'templates/project/AGENTS.md',
      'templates/agents/documentation-maintainer.md',
      'templates/project/MEMORY.md',
    ]) {
      expect(
        feature?.entries ?? [],
        `${PLAN} REQ-007/AC-007: the feature entries include ${entry}`,
      ).toContain(entry);
    }
    expect(
      feature?.tests ?? [],
      `${PLAN} REQ-007/AC-007: the feature tests include tests/behavior/memory-governance-content.test.ts`,
    ).toContain('tests/behavior/memory-governance-content.test.ts');
  });

  it('locks the delivered note triplets and the archived migrated-record references', async () => {
    const navigation = JSON.parse(
      await readFile(packagePath('.ai-workflow/index/navigation.json'), 'utf8'),
    ) as {
      features?: Array<{
        id?: string;
        entries?: string[];
        related_files?: string[];
        read_scope?: string[];
        tests?: string[];
      }>;
    };

    /** The union of a feature's registered path arrays; fails when the feature is absent. */
    const featureArrays = (featureId: string): string[] => {
      const target = navigation.features?.find((candidate) => candidate.id === featureId);
      expect(
        target,
        `${GOVERNANCE_PLAN} REQ-007/AC-007: navigation.json has a ${featureId} feature`,
      ).toBeDefined();
      return [
        ...(target?.entries ?? []),
        ...(target?.related_files ?? []),
        ...(target?.read_scope ?? []),
        ...(target?.tests ?? []),
      ];
    };

    for (const path of MEMORY_SINGLE_SOURCE_TRIPLET) {
      expect(
        featureArrays('memory-governance'),
        `${GOVERNANCE_PLAN} REQ-007/AC-007: the memory-governance feature arrays include ${path}`,
      ).toContain(path);
    }

    for (const path of ARCHIVE_RETENTION_TRIPLET) {
      expect(
        featureArrays('notes-governance'),
        `${GOVERNANCE_PLAN} REQ-007/AC-007: the notes-governance feature arrays include ${path}`,
      ).toContain(path);
    }

    const durableArtifacts = navigation.features?.find((candidate) => candidate.id === 'durable-artifacts');
    expect(
      durableArtifacts,
      `${GOVERNANCE_PLAN} REQ-007/AC-007: navigation.json has a durable-artifacts feature`,
    ).toBeDefined();

    const migratedReferences = collectStrings(durableArtifacts).filter((value) =>
      MIGRATED_RECORDS.some((record) => value.includes(record)),
    );
    expect(
      migratedReferences.length,
      `${GOVERNANCE_PLAN} REQ-007/AC-007: the durable-artifacts feature references the migrated records`,
    ).toBeGreaterThan(0);
    for (const reference of migratedReferences) {
      expect(
        reference.startsWith('.ai-workflow/notes/archived/process/'),
        `${GOVERNANCE_PLAN} REQ-007/AC-007: the durable-artifacts reference ${reference} resolves under .ai-workflow/notes/archived/process/`,
      ).toBe(true);
    }

    const implementedReferences = collectStrings(navigation).filter(
      (value) =>
        value.includes('.ai-workflow/notes/implemented/') &&
        MIGRATED_RECORDS.some((record) => value.includes(record)),
    );
    expect(
      implementedReferences,
      `${GOVERNANCE_PLAN} REQ-007/AC-007: no implemented-path reference to the migrated records remains anywhere in the index`,
    ).toEqual([]);
  });
});

// 20261019-governance-consistency REQ-004/AC-004: root MEMORY.md single-sources the workflow
// contract. It carries one workflow-authority pointer, only the enumerated product, repository
// and meta standards, and no restatement of the workflow topics the contract now owns. These are
// structural assertions over the shipped project memory; review establishes their sufficiency.

/**
 * Markdown blocks of `text`: blank lines and top-level list-item and heading starts split one
 * paragraph or list item from its siblings, so a defect in one block cannot hide in another.
 */
function memoryBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current.join('\n').replace(/\s+/g, ' ').trim());
      current = [];
    }
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (/^(?:#{1,6}\s|[-*]\s|\d+\.\s)/.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

describe('MEMORY single-sources the workflow contract (REQ-004/AC-004)', () => {
  it('carries exactly one workflow-authority pointer naming the contract and the notes governance README', async () => {
    const raw = await readFile(packagePath('MEMORY.md'), 'utf8');
    const pointerBlocks = memoryBlocks(raw).filter(
      (block) =>
        block.includes('.ai-workflow/AGENTS.md') &&
        block.includes('.ai-workflow/notes/README.md') &&
        /workflow authorit/i.test(block),
    );

    expect(
      pointerBlocks.length,
      `${GOVERNANCE_PLAN} REQ-004/AC-004: MEMORY.md carries exactly one workflow-authority pointer standard`,
    ).toBe(1);
    expect(
      flatten(pointerBlocks[0] ?? ''),
      `${GOVERNANCE_PLAN} REQ-004/AC-004: the pointer names both workflow authorities`,
    ).toMatch(/workflow authorit/i);
  });

  it('retains only the enumerated product, repository and meta standards', async () => {
    const memory = flatten(await readFile(packagePath('MEMORY.md'), 'utf8'));

    const retained: ReadonlyArray<readonly [string, RegExp]> = [
      ['contract-location and loading-entry facts', /<!--\s*ai-workflow:begin\s*-->/],
      ['the contract upgrade entry', /ai-workflow init <project-root> --upgrade/],
      ['the repository tracking and gitignore layout', /This repository tracks[\s\S]{0,120}?MEMORY\.md/i],
      ['the gitignored worktree container', /\.worktrees\//],
      ['the five-file sync allowlist', /generatedArtifacts/],
      ['the sync status semantics', /ai-workflow sync \[project\]/],
      ['the host entry and gate semantics', /sync-hook --host/],
      ['the host gate driver', /runProjectGate/],
      ['the gate output shapes', /PreToolUse/],
      ['the native prompt gate', /UserPromptSubmit/],
      ['the raw decision vocabulary', /allow[^.]{0,40}deny[^.]{0,40}skip/i],
      ['the English structural-elements documentation standard', /English structural elements/i],
      ['the configuration fields', /active_profile/],
      ['the configuration rejection', /output_language/],
      ['the navigation grammar', /\$caseId/],
      ['the barrel verification', /barrel/i],
      ['the host frontmatter mapping for Codex', /model_reasoning_effort/],
      ['the host frontmatter mapping for Claude', /allowed-tools/],
      ["the MEMORY currency meta standard", /records only the project's current standards and behavior/i],
      ['the mandatory-tone meta standard', /Shipped workflow prompt templates use a mandatory tone/i],
    ];

    for (const [group, pattern] of retained) {
      expect(
        memory,
        `${GOVERNANCE_PLAN} REQ-004/AC-004: MEMORY.md retains ${group}`,
      ).toMatch(pattern);
    }
  });

  it('restates none of the removed workflow topics', async () => {
    const memory = flatten(await readFile(packagePath('MEMORY.md'), 'utf8'));

    const removed: ReadonlyArray<readonly [string, RegExp]> = [
      ['change-routing', /Requests are routed before work starts/i],
      ['review-closure', /Review activation and closure follow the change class/i],
      ['automatic-commit', /automatically delegates the scoped local commit/i],
      ['fresh-session', /its session is finished/i],
      ['context-boundary', /Orchestrator context growth in delegated coding is bounded/i],
      ['worktree', /project-local temporary worktree/i],
      ['execution-order', /execution order is frozen at split time/i],
      ['workspace', /workspace root delivers one cross-repository plan/i],
      ['parent-orchestration', /Parent workspace coding orchestration is activated/i],
      ['note-governance', /only active proposal and decision mechanism/i],
      ['durable-artifact', /Durable artifacts stay self-contained/i],
      ['planning-artifact', /Planning artifacts are complete bilingual triplets/i],
      ['navigation-authority', /Navigation JSON is authoritative and Markdown is generated from it/i],
      ['implementation-record', /single implementation record at/i],
      ['documentation-role', /Documentation Maintainer owns explicitly scoped documentation only/i],
    ];

    for (const [topic, pattern] of removed) {
      expect(
        memory,
        `${GOVERNANCE_PLAN} REQ-004/AC-004: MEMORY.md must not restate the ${topic} workflow topic`,
      ).not.toMatch(pattern);
    }
  });
});
