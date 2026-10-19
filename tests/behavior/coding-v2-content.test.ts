import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

describe('v2 coding guidance', () => {
  it('describes the current coding contract and delegated execution boundary', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    for (const term of [
      'test-driven',
      'An unsplit plan is executed serially',
      'delegate that test work to the',
      'temporary worktree',
      'Do not generate workflow manifests or run records',
      'Git operations are allowed only through Git Operator',
    ]) {
      expect(coding).toContain(term);
    }
  });

  it('requires delegated serial execution and test-agent-authored tests', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    const testAgent = await readFile(packagePath('templates', 'agents', 'test.md'), 'utf8');
    expect(coding).toContain('An unsplit plan is executed serially');
    expect(coding).toContain('A small bug fix or small request is delegated as one complete unit');
    expect(coding).toContain('delegate that test work to the');
    expect(coding).toContain('relevant validation');
    expect(coding).toContain('delegate Spec Review and Standards Review simultaneously in one parallel batch');
    expect(coding).toContain('review-side exception to serial dispatch');
    expect(testAgent).toMatch(/write or update scoped behavior tests/i);
    expect(testAgent).toContain('public interface plus observable boundary');
  });

  it('schedules a split plan by phases from the frozen execution order', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(coding).toContain('tasks/execution-order.yaml');
    expect(coding).toContain('only schedule');
    expect(coding).toContain('an ordered list of non-empty parallel phases');
    expect(coding).toContain('process phases in file order');
    expect(coding).toContain('dispatch every task of the current phase concurrently');
    expect(coding).toContain('test work before implementation');
    expect(coding).toContain('wait for the whole phase');
    expect(coding).toContain("commit each task's write scope through Git Operator one commit at a time");
    expect(coding).toContain('inside the single worktree');
    expect(coding).toContain("serialize that phase's dispatch");
    expect(coding).toContain('without changing the frozen order');
    expect(coding).toContain('missing or invalid order stops the run before execution');
    expect(coding).toContain('never recompute phases from');
    expect(coding).toContain('depends_on');
    expect(coding).toContain('never fall back to serial execution');
  });

  it('routes an unsplit plan by each step\'s Responsible role when no task files exist', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(coding).toMatch(/unsplit plan.{0,180}(?:Responsible role|responsible role).{0,180}(?:delegate|route|dispatch)/i);
    expect(coding).toMatch(/when no task files exist.{0,220}(?:Responsible role|responsible role)/i);
    expect(coding).not.toMatch(/unsplit plan.{0,180}surface/i);
  });

  it('requires a mandatory project-local temporary worktree before implementation', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(coding).toMatch(/create one project-local temporary worktree/i);
    expect(coding).toContain('.worktrees');
    expect(coding).not.toMatch(/consider a temporary worktree/i);
  });

  it('requires the primary orchestrator to directly dispatch Git Operator and never Task Worker', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    // AC-003 / REQ-002: the primary orchestrator directly dispatches Git Operator, not through a coordinator.
    expect(coding).toMatch(/directly\s+dispatch(?:es|ing)?\s+Git\s+Operator|primary orchestrator\s+directly\s+dispatches\s+Git\s+Operator/i);
    // REQ-002: coding guidance must never instruct delegation to Task Worker.
    expect(coding).not.toMatch(/delegate\s+(?:to\s+)?(?:the\s+)?`?task[- ]worker`?|dispatch\s+(?:to\s+)?(?:the\s+)?`?task[- ]worker`?/i);
    // REQ-003: Git remains Git Operator-only.
    expect(coding).toMatch(/Git operations? (?:are allowed )?only through Git Operator|Git Operator is the only role allowed to run Git/i);
  });

  it('loads the project contract and notes governance for landing changes', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    expect(coding).toContain('.ai-workflow/AGENTS.md');
    expect(coding).toContain('.ai-workflow/notes/README.md');
    expect(coding).toMatch(/notes validate/i);
    expect(coding).toMatch(/\bimplemented\b/i);
  });

  it('retires ADR as a current mechanism from the coding contract', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    expect(coding).not.toMatch(/\bADRs?\b/);
    expect(coding).not.toMatch(/ai-workflow\s+adr\b|\.ai-workflow\/adr\b/i);
  });

  // the project contract carries the durable comment rule, including
  // class- and type-level documentation comments, and its tracked mirror stays
  // byte-identical to the shipped template.
  it('requires durable code comments in the project contract and its tracked mirror', async () => {
    const contractBytes = await readFile(packagePath('templates/project/AGENTS.md'));
    const mirrorBytes = await readFile(packagePath('.ai-workflow/AGENTS.md'));
    expect(
      mirrorBytes.equals(contractBytes),
      'the tracked .ai-workflow/AGENTS.md mirror equals templates/project/AGENTS.md byte-for-byte',
    ).toBe(true);

    for (const path of ['templates/project/AGENTS.md', '.ai-workflow/AGENTS.md']) {
      const text = await readFile(packagePath(path), 'utf8');
      const section = normalizedSection(text, 'Shared context and maintenance');
      expect(section, `${path} carries the shared-context maintenance section`).not.toBe('');
      expect(section, `${path} names code comments`).toMatch(/\bcomments?\b/i);
      expect(section, `${path} covers class- and type-level documentation comments`).toMatch(
        /class- and type-level documentation comments|documentation comments[^.]{0,60}class/i,
      );
      expect(section, `${path} forbids transient plan-internal identifiers`).toMatch(
        /transient plan-internal identifiers?/i,
      );
      expect(section, `${path} names the identifier set`).toMatch(
        /task IDs?[^.]{0,140}step numbers?[^.]{0,140}phase numbers?[^.]{0,220}(?:REQ|AC)[^.]{0,140}plan director/i,
      );
      expect(section, `${path} requires comments to describe durable behavior or rationale`).toMatch(
        /durable (?:behavior|rationale|project terms|terms)|(?:behavior|rationale)[^.]{0,120}durable/i,
      );
    }
  });

  // the coding skill carries the same comment rule, explicitly covering
  // class- and type-level documentation comments and the no-rewrite boundary.
  it('requires durable code comments in the coding skill', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    expect(coding, 'the coding skill names code comments').toMatch(/\bcomments?\b/i);
    expect(coding, 'the coding skill covers class- and type-level documentation comments').toMatch(
      /class- and type-level documentation comments|documentation comments[^.]{0,60}class/i,
    );
    expect(coding, 'the coding skill forbids transient plan-internal identifiers').toMatch(
      /transient plan-internal identifiers?/i,
    );
    expect(coding, 'the coding skill names the identifier set').toMatch(
      /task IDs?[^.]{0,140}step numbers?[^.]{0,140}phase numbers?[^.]{0,220}(?:REQ|AC)[^.]{0,140}plan director/i,
    );
    expect(coding, 'the coding skill requires durable behavior or rationale').toMatch(
      /durable (?:behavior|rationale|project terms|terms)|(?:behavior|rationale)[^.]{0,120}durable/i,
    );
    expect(coding, 'unrelated existing comments are not rewritten').toMatch(
      /(?:unrelated )?existing comments?[^.]{0,120}not rewritten|not rewritten[^.]{0,120}comments?/i,
    );
  });

  // Standards Review checks delivered notes and code comments for
  // transient plan-internal identifiers, governed by the notes README.
  it('requires the Standards Review to check delivered notes and comments for transient identifiers', async () => {
    const standards = await readFile(packagePath('templates/agents/standards-review.md'), 'utf8');
    const checklist = normalizedSection(standards, 'Review checklist');
    expect(checklist, 'the review checklist section exists').not.toBe('');

    expect(checklist, 'delivered notes and code comments are checked').toMatch(
      /notes?[\s\S]{0,160}comments?|comments?[\s\S]{0,160}notes?/i,
    );
    expect(checklist, 'transient plan-internal identifiers are the checked class').toMatch(
      /transient plan-internal identifiers?/i,
    );
    expect(checklist, 'the notes README governs note content').toMatch(/README/i);
  });
});

/**
 * REQ-003 / AC-003: the shipped durable-artifacts rule carries one bounded
 * exemption for test requirement-traceability metadata. Test names, assertion
 * labels, test-local constants and traceability comments may carry requirement
 * and acceptance identifiers and plan labels that link a test to what it
 * verifies, while note bodies, commit messages, product code comments and
 * shipped documentation keep the full prohibition. These read the delivered
 * contract, its tracked mirror, the coding skill, the Standards Review checklist
 * and `README.md` as public prompt artifacts; they assert the semantics and do
 * not pin one exact sentence.
 */
describe('durable-artifact test requirement-traceability exemption (REQ-003, AC-003)', () => {
  it('states the bounded exemption on the contract and its byte-equal mirror', async () => {
    const contractBytes = await readFile(packagePath('templates/project/AGENTS.md'));
    const mirrorBytes = await readFile(packagePath('.ai-workflow/AGENTS.md'));
    expect(
      mirrorBytes.equals(contractBytes),
      'the tracked .ai-workflow/AGENTS.md mirror equals templates/project/AGENTS.md byte-for-byte',
    ).toBe(true);

    for (const path of ['templates/project/AGENTS.md', '.ai-workflow/AGENTS.md']) {
      const text = await readFile(packagePath(path), 'utf8');
      const section = normalizedSection(text, 'Shared context and maintenance');
      expect(section, `${path} carries the shared-context maintenance section`).not.toBe('');
      expectBoundedTestMetadataExemption(section, path);
      // The existing durable-artifact prohibition wording stays asserted unmodified.
      expect(section, `${path} still forbids transient plan-internal identifiers`).toMatch(
        /transient plan-internal identifiers?/i,
      );
      expect(section, `${path} still names the identifier set`).toMatch(
        /task IDs?[^.]{0,140}step numbers?[^.]{0,140}phase numbers?[^.]{0,220}(?:REQ|AC)[^.]{0,140}plan director/i,
      );
    }
  });

  it('states the bounded exemption in the coding skill comment rule', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    const region = durableArtifactWindow(coding, ['Code comments', 'durable behavior or rationale']);
    expect(region, 'the coding skill carries the durable comment rule').not.toBe('');
    expectBoundedTestMetadataExemption(region, 'the coding skill comment rule');
    // The existing prohibition wording stays asserted unmodified.
    expect(coding, 'the coding skill still forbids transient plan-internal identifiers').toMatch(
      /transient plan-internal identifiers?/i,
    );
  });

  it('states the bounded exemption in the Standards Review durable-artifacts checklist', async () => {
    const standards = await readFile(packagePath('templates/agents/standards-review.md'), 'utf8');
    const checklist = normalizedSection(standards, 'Review checklist');
    expect(checklist, 'the Standards Review checklist section exists').not.toBe('');
    expectBoundedTestMetadataExemption(checklist, 'the Standards Review checklist');
    // The existing prohibition wording stays asserted unmodified.
    expect(checklist, 'the checklist still forbids transient plan-internal identifiers').toMatch(
      /transient plan-internal identifiers?/i,
    );
  });

  it('states the bounded exemption in README', async () => {
    const readme = await readFile(packagePath('README.md'), 'utf8');
    const normalized = readme.replace(/\s+/g, ' ');
    // Grounded in the "Notes stay self-contained ..." durable-artifact sentence.
    expect(normalized, 'README carries the self-contained durable-artifact sentence').toMatch(
      /notes? stay self-contained|self-contained[^.]{0,200}(?:plan is gone|after (?:its|the) plan)/i,
    );
    const region = durableArtifactWindow(readme, ['Notes stay self-contained', 'self-contained after its plan']);
    expect(region, 'README carries the self-contained durable-artifact sentence region').not.toBe('');
    expectBoundedTestMetadataExemption(region, 'README.md');
  });
});

/**
 * One bounded exemption from the durable-artifact prohibition: test
 * requirement-traceability metadata may carry requirement and acceptance
 * identifiers and plan labels that link a test to what it verifies, while the
 * full prohibition still covers note bodies, commit messages, product code
 * comments and shipped documentation. Patterns require the semantics, not one
 * exact sentence, so the shipped wording may vary.
 */
function expectBoundedTestMetadataExemption(region: string, label: string): void {
  const normalized = region.replace(/\s+/g, ' ');
  expect(normalized, `${label} carries a durable-artifact region to inspect`).not.toBe('');

  // The exemption is stated for test requirement-traceability metadata: a
  // permission/exemption word co-occurs with the test-metadata carriers, so an
  // unrelated permission elsewhere in the file cannot satisfy it.
  const permission = 'exempt\\w*|exception|carve-?out|may carry|can carry|allowed to carry|permitted to carry';
  const carriers = 'test names?|test titles?|assertion labels?|test labels?|test-local constants?|traceability comments?|test comments?';
  expect(
    normalized,
    `${label} states a bounded exemption for test requirement-traceability metadata`,
  ).toMatch(new RegExp(`(?:${permission})[\\s\\S]{0,320}?(?:${carriers})|(?:${carriers})[\\s\\S]{0,320}?(?:${permission})`, 'i'));

  // The exemption allows requirement/acceptance identifiers and plan labels.
  expect(normalized, `${label} allows requirement, acceptance or plan identifiers in that metadata`).toMatch(
    /(?:requirement|acceptance|\bREQ\b|\bAC\b)[^.]{0,100}(?:identifiers?|IDs?|labels?)|plan labels?/i,
  );
  // The exemption is bounded: those labels link a test to what it verifies.
  expect(normalized, `${label} bounds the exemption to labels that link a test to what it verifies`).toMatch(
    /link\w*[^.]{0,180}(?:tests?|verif)|(?:tests?|verif\w*)[^.]{0,180}link\w*|traceab\w*|what (?:a|the) tests? (?:verif\w*|cover)/i,
  );

  // The boundary keeps the full prohibition for the non-test durable artifacts.
  const retainedArtifacts: ReadonlyArray<readonly [string, RegExp]> = [
    ['note bodies', /note bodies?/i],
    ['commit messages', /commit messages?/i],
    ['code comments', /code comments?/i],
    ['shipped documentation', /shipped (?:documentation|docs|prose)|shipped doc\b/i],
  ];
  for (const [artifact, pattern] of retainedArtifacts) {
    expect(normalized, `${label} keeps the prohibition for ${artifact}`).toMatch(pattern);
  }
  expect(
    normalized,
    `${label} applies the prohibition to note bodies, commit messages, product code comments and shipped documentation`,
  ).toMatch(
    /(?:note bodies?|commit messages?|code comments?|shipped (?:documentation|docs|prose))[\s\S]{0,240}?(?:prohibition|prohibit\w*|forbid\w*|never carry|still carry|not permitted|remains?)\b/i,
  );
}

/**
 * A bounded text window around a surface's durable-artifact sentence, so the
 * exemption semantics must appear with the rule it modifies rather than anywhere
 * in the file.
 */
function durableArtifactWindow(text: string, anchors: readonly string[], span = 1500): string {
  const normalized = text.replace(/\s+/g, ' ');
  for (const anchor of anchors) {
    const at = normalized.indexOf(anchor);
    if (at !== -1) return normalized.slice(Math.max(0, at - 140), at + span);
  }
  return '';
}

/** Whitespace-normalized coding skill text so fragments match across source wrapping. */
async function codingSkillFlattened(): Promise<string> {
  return (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
}

async function workspaceSection(heading: string): Promise<string> {
  const coding = await codingSkillFlattened();
  expect(coding, 'workspace detail is loaded before preparation or implementation state').toMatch(
    /Explicitly read `references\/workspace\.md` before approved preparation or any implementation state/i,
  );
  const reference = await readFile(packagePath('templates', 'skills', 'coding', 'references', 'workspace.md'), 'utf8');
  const text = reference.split(`${heading}\n`)[1]?.split('\n## ')[0] ?? '';
  expect(text, `the workspace reference owns ${heading}`).not.toBe('');
  return text.replace(/\s+/g, ' ');
}

/**
 * REQ-003..REQ-008: the shipped parent workspace execution route. Activation requires a
 * frozen plan declaring at least one participating non-root repository matched to the
 * current root's `.gitmodules`; ordinary and root-only routes stay as they are.
 */
describe('parent workspace execution route', () => {
  it('activates only for a child-participating frozen plan matched to .gitmodules and distributes before implementation state', async () => {
    const coding = await codingSkillFlattened();

    expect(coding).toContain('.gitmodules');
    expect(coding).toMatch(/at least one participating non-root repository|at least one non-root participating repository/i);
    expect(coding).toMatch(/frozen plan/i);
    const preparation = await workspaceSection('## Approved preparation');
    expect(preparation).toContain('ai-workflow workspace distribute --plan <directory>');
    expect(preparation).toMatch(/before any implementation state/i);
  });

  it('keeps the primary parent session as the only dispatcher with no nested coordinator, child host process or sibling session', async () => {
    const coding = await workspaceSection('## Phase dispatch and delivery barriers');

    expect(coding).toMatch(/primary parent session/i);
    expect(coding).toMatch(/directly dispatches native leaf agents/i);
    expect(coding).toMatch(/no nested coordinator/i);
    expect(coding).toMatch(/no child host process/i);
    expect(coding).toMatch(/no sibling session/i);
  });

  it('creates one run-owned worktree per active repository and never treats the parent worktree as a child container', async () => {
    const coding = await workspaceSection('## Repository worktrees and commits');

    expect(coding).toContain('<source-root>/.worktrees/<planId>');
    expect(coding).toContain('ai-workflow/<planId>');
    expect(coding).toMatch(/one run-owned worktree per active repository/i);
    expect(coding).toMatch(/parent worktree is not a container for child implementation/i);
  });

  it('keeps the parent execution order as the only global schedule with a whole-phase barrier before serial task commits', async () => {
    const coding = await workspaceSection('## Phase dispatch and delivery barriers');

    expect(coding).toContain('tasks/execution-order.yaml');
    expect(coding).toMatch(/only global (?:task )?schedule/i);
    expect(coding).toMatch(/whole phase/i);
    expect(coding).toMatch(/awaited and verified/i);
    expect(coding).toMatch(/then serial (?:scoped )?task commits through Git Operator in listed order/i);
  });

  it('delivers a repository at its last task phase before dependent repositories advance', async () => {
    const coding = await workspaceSection('## Phase dispatch and delivery barriers');

    expect(coding).toMatch(/last task phase/i);
    expect(coding).toMatch(/review\/delivery gate|review and delivery gate|delivery gate/i);
    expect(coding).toMatch(/before dependent repositories advance|dependent repositories? (?:advance|are dispatched)/i);
  });

  it('requires absolute packet paths, scopes, commands, output paths and upstream delivery evidence', async () => {
    const coding = await workspaceSection('## Packet contract');

    for (const fragment of [
      'absolute parent plan',
      'source repository',
      'local slice plan',
      'coding worktree',
      'phase/task',
      'REQ/AC',
      'permitted commands',
      'output paths',
      'upstream delivery evidence',
      'explicit workdir',
      'native permission denial is a blocker',
    ]) {
      expect(coding, `the parent packet contract must state "${fragment}"`).toContain(fragment);
    }
    expect(coding).toMatch(/relative and resolved[^.]{0,24}read\/write scope/i);
  });

  it('separates per-repository delivery review from a distinct finalization review and checkpoints only after Git evidence', async () => {
    const delivery = await workspaceSection('## Phase dispatch and delivery barriers');
    const coding = await workspaceSection('## Review and checkpoint record');

    expect(delivery).toMatch(/per-repository delivery review|repository delivery review/i);
    expect(coding).toMatch(/separate finalization review|finalization review/i);
    expect(coding).toContain('ai-workflow workspace checkpoint --plan <directory> --repo <name>');
    expect(coding).toMatch(/only after[^.]{0,40}Git evidence|after Git evidence/i);
  });

  it('resumes only at clean checkpointed phase or verified delivery boundaries and stops on partial-phase residue', async () => {
    const coding = await workspaceSection('## Recovery');
    const lowered = coding.toLowerCase();

    expect(coding).toMatch(/clean, fully checkpointed phase boundar/i);
    expect(coding).toMatch(/verified repository delivery boundar/i);
    for (const fragment of ['dirty partial-phase', 'commit-without-checkpoint', 'unknown future-phase progress', 'uncertain review results', 'bounded support']) {
      expect(lowered, `the recovery rule must name "${fragment}"`).toContain(fragment);
    }
    expect(coding).toMatch(/instead of redispatch|rather than redispatch|not redispatch/i);
  });

  it('links the detailed parent workspace reference file', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    expect(coding).toContain('references/workspace.md');
    expect(coding.replace(/\s+/g, ' ')).toMatch(
      /For a child-participating parent\/root plan, a repository slice or workspace finalization, explicitly read `references\/workspace\.md` before any workspace preparation, worktree, implementation record, task dispatch or finalization/i,
    );
  });
});

/**
 * The whitespace-normalized text of one level-two section, so a required rule must
 * appear inside its own normative section instead of an unrelated whole-file mention.
 */
function normalizedSection(text: string, heading: string): string {
  const marker = `\n## ${heading}\n`;
  const start = text.indexOf(marker);
  if (start === -1) return '';
  const body = text.slice(start + marker.length);
  const next = body.indexOf('\n## ');
  const section = next === -1 ? body : body.slice(0, next);
  return section.replace(/\s+/g, ' ').trim();
}

function anyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * REQ-001 / REQ-002 / REQ-003: the shipped completed-session boundary. A role session
 * that returned execution Status `done` is finished, so the first and every later
 * same-role delegation starts a new native session with bounded current context. This
 * reads the delivered contract template, its tracked mirror and Coding's delegation
 * guidance as public prompt artifacts; it is static delivered-content evidence, not
 * host runtime enforcement.
 */
describe('fresh sub-agent sessions for completed roles (REQ-001, REQ-002, REQ-003)', () => {
  it('requires a fresh native session with bounded current context for later same-role work after Status done', async () => {
    const contractRaw = await readFile(packagePath('templates', 'project', 'AGENTS.md'), 'utf8');
    const mirrorRaw = await readFile(packagePath('.ai-workflow', 'AGENTS.md'), 'utf8');
    const codingRaw = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');

    // AC-004: the tracked project contract stays equal to its template source.
    expect(
      mirrorRaw.replace(/\s+/g, ' ').trim(),
      'the tracked .ai-workflow/AGENTS.md mirror equals templates/project/AGENTS.md',
    ).toBe(contractRaw.replace(/\s+/g, ' ').trim());

    const orchestration = normalizedSection(contractRaw, 'Orchestration');
    const delegation = normalizedSection(codingRaw, 'Delegation and Scheduling');
    const normative = `${orchestration} ${delegation}`;

    // The completed-session rule must be present in each normative section, not just
    // anywhere in the file.
    for (const [name, section] of [
      ['contract ## Orchestration', orchestration],
      ['Coding ## Delegation and Scheduling', delegation],
    ] as const) {
      expect(section, `${name} states the completed-session rule`).not.toBe('');
      expect(
        anyPattern(section, [
          /status\s*`?done`?[^.]{0,140}?session[^.]{0,90}?(?:finished|over|ends?|complete)/i,
          /`?done`?[^.]{0,140}?(?:ends?|finishes?)[^.]{0,90}?session/i,
        ]),
        `${name} ends the session once Status done is returned`,
      ).toBe(true);
      expect(
        anyPattern(section, [
          /(?:later|subsequent|any later|next)[^.]{0,160}?(?:same (?:named )?role)[^.]{0,180}?new native (?:sub-agent )?session/i,
          /(?:same (?:named )?role)[^.]{0,180}?(?:start|use|dispatch|delegat\w+)[^.]{0,90}?new native (?:sub-agent )?session/i,
        ]),
        `${name} starts a new native session for later same-role work`,
      ).toBe(true);
      expect(
        anyPattern(section, [
          /never[^.]{0,140}?(?:reuse|resume)[^.]{0,140}?completed session/i,
          /(?:do not|don't|not)[^.]{0,140}?(?:reuse|resume)[^.]{0,140}?completed session/i,
          /completed session[^.]{0,140}?(?:is )?(?:never|not)[^.]{0,90}?(?:reused|resumed|reopened)/i,
        ]),
        `${name} forbids reusing or resuming the completed session`,
      ).toBe(true);
      expect(
        anyPattern(section, [/continuation field/i, /reuse or resume/i]),
        `${name} prohibits passing the completed session to a continuation mechanism`,
      ).toBe(true);
    }

    // AC-002: the same boundary covers later authorized implementation, repair,
    // verification or recheck, documentation and Git delegations.
    expect(
      normative,
      'the rule states a shared boundary across later work',
    ).toMatch(/same boundary|this boundary|same rule|same requirement|fresh session/i);
    for (const term of ['task', 'repair', 'verification', 'recheck', 'documentation', 'Git']) {
      expect(normative, `the boundary covers later ${term} work`).toMatch(new RegExp(`\\b${term}`, 'i'));
    }

    // AC-003: a fresh session receives the bounded current context, not the whole
    // previous conversation.
    expect(
      anyPattern(normative, [/current (?:required )?(?:project )?context/i, /current project contract/i]),
      'the fresh session receives the current required project context',
    ).toBe(true);
    expect(normative, 'the handoff names the project contract').toMatch(/\bcontract\b/i);
    expect(normative, 'the handoff names MEMORY').toMatch(/\bMEMORY\b/);
    expect(
      normative,
      'the handoff names both navigation files',
    ).toMatch(/navigation\.json|navigation\.md|both navigation/i);
    expect(
      anyPattern(normative, [/current (?:task )?(?:goal|objective|packet)/i, /task (?:goal|objective)/i]),
      'the handoff names the current task goal',
    ).toBe(true);
    expect(normative, 'the handoff names the exact read/write scopes').toMatch(/read\/write scope|exact scopes/i);
    expect(normative, 'the handoff names the permitted commands').toMatch(/permitted commands/i);
    expect(
      anyPattern(normative, [
        /(?:relevant|current)[^.]{0,160}?(?:handoff |accepted )?evidence/i,
        /actionable findings?/i,
        /accepted (?:results?|evidence)/i,
      ]),
      'the handoff carries relevant accepted evidence or actionable findings',
    ).toBe(true);
    expect(
      normative,
      'the whole previous conversation is excluded from the handoff',
    ).toMatch(
      /(?:instead of|not|rather than)[^.]{0,160}?entire (?:previous |prior )?conversation|(?:instead of|not|rather than)[^.]{0,160}?(?:whole|entire) previous conversation/i,
    );

    // AC-003: the rationale is completed-task context accumulation degrading
    // effectiveness, with no measured performance claim.
    expect(normative, 'the rationale names completed-task context accumulation').toMatch(
      /(?:completed[- ]task|accumulated|previous)[^.]{0,100}?context[^.]{0,140}?accumulat/i,
    );
    expect(normative, 'the rationale names degrading effectiveness').toMatch(
      /(?:degrad\w+|impair\w+|reduc\w+)[^.]{0,100}?effectiveness|effectiveness[^.]{0,100}?(?:degrad|impair|reduc)/i,
    );
    expect(normative, 'no measured performance gain is claimed').not.toMatch(
      /(?:we measured|measured a|benchmark shows?|proven to improve|empirically (?:better|improves?))/i,
    );
  });
});

/**
 * The shipped orchestrator-context bounds. Delegated returns keep the contractual
 * Markdown shape but cap evidence entries to a path plus a one-sentence conclusion,
 * prohibit embedded bodies, stream large outputs to a gitignored reports log digested
 * by a fresh read-only session, and keep the primary at decision level; fixed context
 * and frozen plan files travel as absolute paths plus version anchors only, read once
 * by the primary and self-read by each leaf. This reads the delivered SKILL.md and
 * workspace.md sections as public prompt artifacts; it is static delivered-content
 * evidence, not host runtime enforcement.
 */
describe('orchestrator context bounds: delegated evidence caps and path-based frozen-input transport', () => {
  // The delivered result-envelope text.
  it('bounds delegated evidence entries to one-sentence path conclusions', async () => {
    const envelope = await codedEnvelopeText();

    expect(envelope, 'the envelope names the `### Evidence` entry').toMatch(/### Evidence/);
    expect(
      envelope,
      'an evidence entry carries the absolute path of the produced artifact or an explicit report reference',
    ).toMatch(
      /absolute (?:file )?path[^.]{0,80}(?:or an? explicit report reference|or a report reference)|(?:artifact|report) (?:absolute )?path/i,
    );
    expect(envelope, 'the conclusion is capped at one sentence').toMatch(
      /at most one sentence|one[- ]sentence cap|single sentence/i,
    );
  });

  // The prohibition on embedded bodies.
  it('prohibits embedded diffs, logs, JSON bodies and code blocks in evidence entries', async () => {
    const envelope = await codedEnvelopeText();

    for (const body of ['diff', 'log', 'JSON', 'code block']) {
      expect(envelope, `the evidence bound names ${body} bodies`).toMatch(new RegExp(`\\b${body}s?\\b`, 'i'));
    }
    expect(envelope, 'embedded bodies are prohibited in evidence entries').toMatch(
      /(?:no |not |never |prohibit|forbid|must not )[^.]{0,160}embedded[^.]{0,160}(?:diff|log|JSON|code)/i,
    );
  });

  // The gitignored report-log location for large outputs.
  it('writes large outputs to the gitignored reports log and never commits them', async () => {
    const envelope = await codedEnvelopeText();

    expect(envelope, 'large outputs are written under the plan directory reports log').toMatch(
      /<plan-directory>\/reports\/<taskId>\.log/i,
    );
    expect(envelope, 'the reports path is gitignored and never committed').toMatch(
      /(?:gitignore[d]?|git-ignored)[^.]{0,140}(?:never committed|not committed|never commit|not commit)|(?:never|not) committ?ed[^.]{0,140}(?:gitignore|reports)/i,
    );
  });

  // The fresh read-only digest session.
  it('digests large outputs through a fresh read-only session that returns one bounded conclusion', async () => {
    const envelope = await codedEnvelopeText();

    expect(envelope, 'a fresh read-only sub-agent session is dispatched').toMatch(
      /fresh[^.]{0,100}read-only[^.]{0,80}(?:sub-agent )?session|read-only[^.]{0,100}fresh[^.]{0,80}(?:sub-agent )?session/i,
    );
    expect(envelope, 'a file-explorer session is bound to the report path').toMatch(
      /file-explorer[^.]{0,140}report/i,
    );
    expect(envelope, 'a test session serves a required command verdict').toMatch(/`?test`?[^.]{0,100}verdict/i);
    expect(envelope, 'the digest returns one bounded conclusion').toMatch(/one bounded conclusion/i);
    expect(envelope, 'the raw content never enters the primary context').toMatch(
      /raw (?:content|output)[^.]{0,140}never enters the primary|never enters the primary[^.]{0,140}context/i,
    );
  });

  // The decision-level primary output and its exemptions.
  it('keeps the primary output at decision level with handoff, support and final-report exemptions', async () => {
    const envelope = await codedEnvelopeText();

    expect(envelope, 'the primary output stays at decision level').toMatch(/decision level/i);
    for (const term of ['dispatched', 'verdict', 'checkpoint']) {
      expect(envelope, `the decision-level set names ${term}`).toMatch(new RegExp(`\\b${term}\\b`, 'i'));
    }
    expect(envelope, 'the handoff copyable prompt is exempt').toMatch(/copyable prompt/i);
    expect(envelope, 'bounded support or recovery requests are exempt').toMatch(/bounded (?:support|recovery)/i);
    expect(envelope, 'the final report is exempt').toMatch(/final report/i);
  });

  // Path-plus-anchor packet transport.
  it('transports fixed context and frozen plan files as absolute paths plus version anchors only', async () => {
    const injection = await codedInjectionText();

    expect(injection, 'fixed context and plan files travel as absolute paths plus version anchors').toMatch(
      /absolute paths?[^.]{0,80}(?:plus|and|with)[^.]{0,60}anchors?|anchors? only/i,
    );
    expect(injection, 'fixed context uses the worktree baseline commit or blob anchor').toMatch(
      /worktree baseline commit|baseline commit|blob anchor|blob hash/i,
    );
    expect(injection, 'frozen plan files use the frozen digest').toMatch(/frozen digest/i);
    expect(injection, 'their content is never inlined').toMatch(
      /(?:never|not) inlined?|content (?:is )?never inlined/i,
    );
  });

  // The preserved packet fields.
  it('preserves the existing packet fields under path-plus-anchor transport', async () => {
    const injection = await codedInjectionText();

    for (const field of [
      'REQ/AC',
      'task goal',
      'exact scopes',
      'permitted commands',
      'upstream delivery evidence',
      'output paths',
    ]) {
      expect(injection, `the packet keeps the ${field} field`).toContain(field);
    }
  });

  // The read-once reusable primary prefix.
  it('reads the fixed context once at session start as a reusable prefix', async () => {
    const injection = await codedInjectionText();

    expect(injection, 'fixed context is read once at session start').toMatch(
      /(?:read|reads|reading)[^.]{0,100}once[^.]{0,80}session start|once at (?:the )?session start/i,
    );
    expect(injection, 'the fixed context is a reusable prefix').toMatch(/reusable prefix/i);
    expect(injection, 'content is not re-injected per task').toMatch(
      /(?:not|never|does not|doesn't) (?:re-inject|re-injects|reinject)[^.]{0,140}(?:per task|for each task|each task)/i,
    );
  });

  // The leaf self-read of fixed context and frozen plan files.
  it('requires each leaf to read its own repository fixed context and the frozen plan files', async () => {
    const injection = await codedInjectionText();

    expect(injection, 'each leaf reads its own repository fixed context').toMatch(
      /(?:each )?leaf[^.]{0,160}(?:its own|own)[^.]{0,80}(?:fixed context|AGENTS\.md)/i,
    );
    expect(injection, 'each leaf reads the frozen plan files per the packet contract').toMatch(
      /leaf[^.]{0,160}frozen plan files|frozen plan files[^.]{0,160}leaf/i,
    );
  });

  // The plan-referenced indexed-feature locator route.
  it('routes plan-referenced indexed features through context locate and read_order', async () => {
    const injection = await codedInjectionText();

    expect(injection, 'the leaf uses context locate with --verify').toMatch(
      /ai-workflow context locate --project <root> --feature <id> --verify/,
    );
    expect(injection, 'the leaf reads the exact read_order paths').toMatch(/read_order/);
  });

  // No full re-injection alternative mode.
  it('provides no full re-injection alternative mode', async () => {
    const injection = await codedInjectionText();

    expect(injection, 'a full re-injection alternative mode is not provided').toMatch(
      /(?:no|not|never)[^.]{0,100}(?:full )?re-injection[^.]{0,160}(?:alternative|mode|provided)|(?:full )?re-injection[^.]{0,160}(?:is not provided|not provided|no alternative)/i,
    );
  });
});

/** Whitespace-normalized SKILL.md level-two section, or '' when the heading is absent. */
async function codingSkillSection(heading: string): Promise<string> {
  const text = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
  return normalizedSection(text, heading);
}

/** Envelope text: Coding's delegation rules plus the workspace packet contract. */
async function codedEnvelopeText(): Promise<string> {
  return [await codingSkillSection('Delegation and Scheduling'), await workspaceSection('## Packet contract')].join(' ');
}

/** Injection text: Coding's preconditions and delegation rules plus the workspace packet contract. */
async function codedInjectionText(): Promise<string> {
  return [
    await codingSkillSection('Preconditions'),
    await codingSkillSection('Delegation and Scheduling'),
    await workspaceSection('## Packet contract'),
  ].join(' ');
}

/**
 * The checkpoint-boundary active-rebuild protocol for checkpointed workspace
 * execution. The primary may rebuild context only at a clean, fully checkpointed phase
 * boundary or a verified
 * repository delivery boundary, re-deriving state from the frozen files instead of
 * conversation history and verifying recorded checkpoint SHAs, status drift and
 * checkpoint coverage before continuing. This reads the delivered `## Recovery`
 * section of `references/workspace.md` and the parent workspace guidance in `SKILL.md`
 * as public prompt artifacts; it is static delivered-content evidence, not host
 * runtime enforcement.
 */
describe('checkpoint-boundary active rebuild protocol', () => {
  // The active rebuild and its boundary conditions.
  it('allows an active rebuild only at a clean checkpointed phase or verified delivery boundary', async () => {
    const recovery = await workspaceSection('## Recovery');

    expect(recovery, 'the primary may actively rebuild context').toMatch(
      /active rebuild|actively rebuild (?:its |the )?context/i,
    );
    expect(recovery, 'the rebuild happens at a clean, fully checkpointed phase boundary').toMatch(
      /clean,? fully checkpointed phase boundar|clean[^.]{0,60}checkpointed[^.]{0,60}phase boundar/i,
    );
    expect(recovery, 'the rebuild happens at a verified repository delivery boundary').toMatch(
      /verified repository delivery boundar/i,
    );
  });

  // State is re-derived from the frozen files, never from conversation history.
  it('re-derives state from the frozen files and never from conversation history', async () => {
    const recovery = await workspaceSection('## Recovery');

    expect(recovery, 'state is re-derived from the frozen files').toMatch(
      /re-?deriv\w+[^.]{0,140}frozen files|frozen files[^.]{0,140}re-?deriv/i,
    );
    for (const source of ['tasks/execution-order.yaml', 'task files', 'implementation.yaml', 'workspace status']) {
      expect(recovery, `the derived state names "${source}"`).toContain(source);
    }
    expect(recovery, 'state is never taken from conversation history').toMatch(
      /(?:never|not|instead of|rather than)[^.]{0,120}conversation history|conversation history[^.]{0,120}(?:never|not)/i,
    );
  });

  // Verification before continuing.
  it('verifies recorded checkpoint SHAs, status drift and checkpoint coverage before continuing', async () => {
    const recovery = await workspaceSection('## Recovery');

    expect(recovery, 'recorded checkpoint SHAs are matched against Git objects').toMatch(
      /SHAs?[^.]{0,140}(?:match|verified|exist)[^.]{0,140}Git objects?|Git objects?[^.]{0,140}SHAs?/i,
    );
    expect(recovery, 'the checks are read-only').toMatch(/read-only/i);
    expect(recovery, 'workspace status shows no drift').toMatch(/workspace status[^.]{0,140}no drift|no drift/i);
    expect(recovery, 'no commit lacks a checkpoint').toMatch(
      /no commit[^.]{0,100}(?:lacks|without|missing)|commit lacks a checkpoint|commit-without-checkpoint/i,
    );
    expect(recovery, 'only then does the rebuild continue').toMatch(/only then/i);
  });

  // The clean-boundary restriction prohibiting discarded context.
  it('prohibits discarding context at a dirty, partial or uncheckpointed boundary', async () => {
    const recovery = await workspaceSection('## Recovery');

    expect(recovery, 'discarding context is prohibited').toMatch(
      /(?:prohibit|forbid|never|not)[^.]{0,140}discard\w*|discard\w*[^.]{0,140}(?:prohibit|forbid|never|not)/i,
    );
    expect(recovery, 'the restricted cases include a dirty or partial phase').toMatch(
      /dirty (?:or partial|partial[- ]phase)|partial phase/i,
    );
    expect(recovery, 'the restricted cases include a commit-without-checkpoint gap').toMatch(
      /commit-without-checkpoint|commit without a checkpoint/i,
    );
    expect(recovery, 'the restricted cases include unknown progress').toMatch(/unknown[^.]{0,60}progress/i);
  });

  // Finish in-flight tasks, then restart; otherwise report blocked.
  it('completes in-flight tasks to the nearest verified boundary and restarts, or reports blocked', async () => {
    const recovery = await workspaceSection('## Recovery');

    expect(recovery, 'context pressure can appear mid-phase').toMatch(/context pressure/i);
    expect(recovery, 'the primary first completes in-flight tasks').toMatch(/in-flight tasks/i);
    expect(recovery, 'the nearest verified boundary lists validation, commit and checkpoint').toMatch(
      /validation[^.]{0,60}commit[^.]{0,60}checkpoint/i,
    );
    expect(recovery, 'the session restarts at that boundary').toMatch(/restart/i);
    expect(recovery, 'an unreachable clean boundary reports blocked with bounded support').toMatch(
      /blocked[^.]{0,140}bounded support|bounded support[^.]{0,140}blocked/i,
    );
  });

  // The resumed session follows the frozen schedule with no DAG recompute.
  it('follows the frozen schedule and never recomputes the DAG or skips tasks', async () => {
    const recovery = await workspaceSection('## Recovery');

    expect(recovery, 'a resumed session follows the frozen schedule').toMatch(
      /frozen schedule|frozen execution order/i,
    );
    expect(recovery, 'the DAG is never recomputed').toMatch(
      /(?:never|not)[^.]{0,100}recomput\w*[^.]{0,60}DAG|never recompute the DAG/i,
    );
    expect(recovery, 'tasks are never skipped').toMatch(
      /(?:never|not)[^.]{0,80}skip\w*[^.]{0,60}tasks?|tasks?[^.]{0,80}skipped/i,
    );
  });

  // The ordinary-plan exclusion.
  it('keeps ordinary split or unsplit plans on the existing fresh-session recovery without an active-rebuild rule', async () => {
    const recovery = await workspaceSection('## Recovery');

    expect(recovery, 'ordinary split or unsplit plans keep the existing fresh-session recovery').toMatch(
      /ordinary[^.]{0,160}(?:split|unsplit)[^.]{0,200}(?:fresh-session recovery|existing recovery|existing fresh-session)/i,
    );
    expect(recovery, 'ordinary plans carry no active-rebuild rule').toMatch(
      /(?:no|without|never)[^.]{0,140}active-?rebuild|active-?rebuild[^.]{0,160}(?:applies only|only for|does not apply|never applies)|ordinary[^.]{0,240}active-?rebuild/i,
    );
  });

  // The parent workspace guidance cross-references the reference protocol.
  it('cross-references the checkpoint-boundary active rebuild from the parent workspace guidance', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');

    expect(
      coding,
      'the parent workspace guidance links references/workspace.md with the checkpoint-boundary active rebuild',
    ).toMatch(
      /(?:references\/workspace\.md[^.]{0,200}(?:active rebuild|checkpoint[- ]boundary)|(?:active rebuild|checkpoint[- ]boundary)[^.]{0,200}references\/workspace\.md)/i,
    );
  });
});

/**
 * This run's feature-branch directive is run-scoped and carried by the frozen plan and
 * the handoff only, so the synchronization-managed templates and the project contract
 * must not carry a general mandatory "create a feature branch from main" rule. The
 * assertion passes on compliant text; its RED is demonstrated by mutating a copy of a
 * managed file outside the repository. This reads the delivered prompt artifacts as
 * public content; it is static delivered-content evidence, not host runtime
 * enforcement.
 */
describe('no synchronization-managed feature-branch rule', () => {
  it('keeps a general mandatory feature-branch rule out of the synchronization-managed templates and contract', async () => {
    // Tolerant patterns for a mandatory general rule; both require an explicit
    // `feature branch` phrase, so legitimate unrelated wording cannot match.
    const forbidden = [
      /(?:create|creates|creating|use|uses|start|starts|work on)[^.]{0,80}\bfeature[- ]branch\b[^.]{0,80}(?:from|off|based on)\s+main/i,
      /\bfeature[- ]branch\b[^.]{0,80}\b(?:mandatory|required|must|always)\b/i,
    ];
    for (const path of [
      'templates/project/AGENTS.md',
      '.ai-workflow/AGENTS.md',
      'templates/skills/coding/SKILL.md',
      'templates/skills/coding/references/workspace.md',
      'templates/project/notes/AGENTS.md',
      'templates/project/notes/README.md',
      'templates/project/notes/implemented/AGENTS.md',
      'templates/project/notes/archived/AGENTS.md',
    ]) {
      const text = (await readFile(packagePath(path), 'utf8')).replace(/\s+/g, ' ');
      for (const pattern of forbidden) {
        expect(
          text,
          `${path} carries no general mandatory feature-branch rule`,
        ).not.toMatch(pattern);
      }
    }
  });
});

/**
 * The project contract and its tracked mirror gain the minimal rule text for the
 * result-envelope evidence bounds and the checkpoint-boundary active rebuild, staying
 * whitespace-normalized equal in full. These are focused content assertions on the
 * delivered contract text; they are static delivered-content evidence, not host
 * runtime enforcement.
 */
describe('contract context-boundary rules', () => {
  const contractPaths = ['templates/project/AGENTS.md', '.ai-workflow/AGENTS.md'];

  // The result-envelope evidence bound.
  it('bounds each Evidence entry to an absolute artifact or report reference path with at most one sentence and no embedded bodies', async () => {
    for (const path of contractPaths) {
      const text = (await readFile(packagePath(path), 'utf8')).replace(/\s+/g, ' ');
      expect(text, `${path} keeps the ### Evidence entry heading`).toMatch(/### Evidence/);
      expect(
        text,
        `${path} names the absolute path of the produced artifact or an explicit report reference`,
      ).toMatch(
        /absolute (?:file )?path[^.]{0,140}(?:artifact|report reference)|(?:artifact|report reference)[^.]{0,140}absolute (?:file )?path|(?:artifact|report) (?:absolute )?path[^.]{0,100}report reference/i,
      );
      expect(text, `${path} names an explicit report reference`).toMatch(/\breport reference\b/i);
      expect(text, `${path} caps the conclusion at at most one sentence`).toMatch(
        /at most one sentence|one[- ]sentence cap|single[- ]sentence cap/i,
      );
      expect(
        text,
        `${path} prohibits embedded diffs, logs, JSON bodies or code blocks in Evidence entries`,
      ).toMatch(
        /(?:prohibit|forbid|never|must not|do not|no )[\s\S]{0,240}?(?:diff|log|JSON|code block)s?/i,
      );
    }
  });

  // The checkpoint-boundary active rebuild.
  it('allows an active rebuild only at a clean checkpointed phase or verified delivery boundary, derived from records and never conversation history', async () => {
    for (const path of contractPaths) {
      const text = (await readFile(packagePath(path), 'utf8')).replace(/\s+/g, ' ');
      expect(text, `${path} allows an active context rebuild`).toMatch(
        /active rebuild|actively rebuild (?:its |the )?context/i,
      );
      expect(text, `${path} names the checkpoint boundary`).toMatch(/\bcheckpoint/i);
      expect(
        text,
        `${path} restricts an active rebuild to a clean, fully checkpointed phase boundary or a verified repository delivery boundary`,
      ).toMatch(
        /clean,? fully checkpointed[^.]{0,100}(?:phase |repository )?boundar|verified repository delivery boundar/i,
      );
      expect(
        text,
        `${path} re-derives state from the frozen files and implementation records`,
      ).toMatch(
        /re-?deriv\w+[^.]{0,200}(?:frozen files|implementation records)|(?:frozen files|implementation records)[^.]{0,200}re-?deriv/i,
      );
      expect(text, `${path} never takes state from conversation history`).toMatch(
        /(?:never|not|instead of|rather than)[^.]{0,180}conversation history|conversation history[^.]{0,180}(?:never|not)/i,
      );
      expect(text, `${path} requires read-only SHA and drift verification before continuing`).toMatch(
        /read-only[\s\S]{0,240}?(?:SHA|drift)|(?:SHA|drift)[\s\S]{0,240}?read-only/i,
      );
      expect(text, `${path} verifies recorded checkpoint SHAs`).toMatch(/\bSHAs?\b/i);
      expect(text, `${path} checks for no drift`).toMatch(/\bdrift\b/i);
    }
  });
});
