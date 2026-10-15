import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Behavior boundary: the shipped routing text that decides whether a request enters
// Planning and whether the dual-axis review runs. Assertions read the same template
// files that install and init ship to hosts and projects.

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** Extract one `## Heading` section up to the next level-two heading. */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function frontmatter(text: string): string {
  return text.split(/^---$/m)[1] ?? '';
}

/**
 * Every Markdown bullet or paragraph containing `anchor`, whitespace-normalized.
 * Blocks split on blank lines and on top-level list-item and heading starts, so one
 * paragraph or list item is isolated from its siblings; an unrelated accurate
 * paragraph in the same document cannot satisfy or hide a scoped defect.
 */
function blocksContaining(text: string, anchor: string | RegExp): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current.join('\n'));
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
  return blocks
    .filter((block) => (typeof anchor === 'string' ? block.includes(anchor) : anchor.test(block)))
    .map((block) => flatten(block));
}

describe('change routing guidance', () => {
  it('classifies direct, mechanical and planned changes in the project contract', async () => {
    const contract = await read('templates/project/AGENTS.md');

    expect(contract, 'the contract owns the routing section').toMatch(/## Change routing/);
    expect(contract, 'a direct change is implemented without Planning').toMatch(
      /Direct change[^.]*small requirement, feature adjustment or defect fix[^.]*without Planning/i,
    );
    expect(contract, 'a direct change skips the dual-axis review').toMatch(
      /Direct change[\s\S]{0,600}?without the dual-axis review/i,
    );
    expect(contract, 'unclear or contested requirements are planned').toMatch(
      /Planned change[^.]*new feature, unclear or contested requirements/i,
    );
    expect(contract, 'mechanical edits run only the narrowest check').toMatch(
      /Mechanical change[^.]*typo, copy, comment, formatting or test-only[^.]*narrowest relevant check/i,
    );
    expect(contract, 'Planning may not restate a settled request').toMatch(
      /Never run Planning to restate a request with clear, bounded intent/i,
    );
    expect(contract, 'direct must not skip required checks').toMatch(
      /never label a change direct to skip required checks or evidence/i,
    );
  });

  it('routes the coding skill into a direct path that keeps the execution unit and skips the dual-axis review', async () => {
    const coding = await read('templates/skills/coding/SKILL.md');
    const flat = flatten(coding);

    expect(coding, 'the coding skill owns the routing section').toMatch(/## Change routing/);
    expect(frontmatter(coding), 'the skill description no longer requires an approved task').not.toMatch(
      /approved task/i,
    );
    expect(frontmatter(coding), 'the skill description names the direct or frozen-plan scope').toMatch(
      /directly or from a frozen plan/i,
    );
    expect(flat, 'a direct or mechanical change uses the request as its boundary').toMatch(
      /a direct or mechanical change uses the request's explicit scope and acceptance evidence as its boundary/i,
    );
    expect(flat, 'the execution unit and Git Operator commit are retained').toMatch(
      /still executes as one coding execution unit with its worktree and Git Operator commit/i,
    );
    expect(flat, 'direct and mechanical changes run checks without the dual-axis review').toMatch(
      /A direct or mechanical change runs the relevant checks without the dual-axis review/i,
    );
    expect(flat, 'direct changes create no implementation record').toMatch(
      /A direct or mechanical change without a frozen plan creates no record/i,
    );
    expect(flat, 'the completion checklist records the class').toMatch(
      /The change class was stated at intake and matches the delivered scope/i,
    );
  });

  it('restricts Planning to planned changes in its entry criteria and description', async () => {
    const planning = await read('templates/skills/planning/SKILL.md');
    const flat = flatten(planning);

    expect(planning, 'the planning skill owns a when-to-use section').toMatch(/## When to use/);
    expect(frontmatter(planning), 'the description excludes small fixes').toMatch(
      /small fixes are implemented directly/i,
    );
    expect(flat, 'a direct fix must not enter Planning').toMatch(
      /small requirement, feature adjustment or defect fix with clear, bounded intent is implemented directly and must not enter Planning/i,
    );
    expect(flat, 'Planning may not restate a settled request').toMatch(
      /never use Planning to restate a request whose scope is already settled/i,
    );
  });

  it('keeps the routing standard in the generated contract and the README', async () => {
    // Generic workflow obligations live in the generated project contract; the project-owned
    // MEMORY scaffolding is no longer required to carry them.
    const contract = await read('templates/project/AGENTS.md');
    expect(flatten(contract), 'the generated contract records the routing standard').toMatch(
      /Requests are classified before work starts[^.]*implemented directly without Planning or the dual-axis review/i,
    );
    expect(contract, 'the contract keeps the plan path for planned changes').toMatch(
      /runs Planning and keeps that review gate/i,
    );

    const readme = await read('README.md');
    expect(readme, 'README documents the routing section').toMatch(/### Change routing/);
    expect(readme, 'README states the direct path').toMatch(
      /implemented directly without Planning/i,
    );
  });

  it('stops a coding session after Planning and routes a child-participating workspace plan to a parent Coding session', async () => {
    const codingText = await read('templates/skills/coding/SKILL.md');
    const routing = flatten(section(codingText, '## Change routing'));

    expect(routing, 'a planned change with no frozen plan runs Planning first').toMatch(
      /planned change has no frozen plan[^.]*run Planning first/i,
    );
    expect(routing, 'the no-frozen-plan handoff is workspace-aware').toMatch(/workspace/i);
    expect(routing, 'the child-participating workspace handoff starts a new session at the workspace root').toMatch(
      /new session at (?:that )?workspace root/i,
    );
    expect(routing, 'the new session invokes the coding skill').toMatch(/invoke (?:the )?coding\b/i);
    expect(routing, 'plan-to-tasks remains the preparation procedure named by the routing').toMatch(
      /plan-to-tasks/i,
    );
    expect(routing, 'the coding session does not repeat the already-completed preparation').toMatch(
      /(?:already|without repeating|does not repeat|previously)[^.]{0,160}(?:preparation|split|distribut)|(?:preparation|split|distribut)[^.]{0,160}(?:already|without repeating|does not repeat|previously)/i,
    );
    expect(routing, 'the superseded plan-to-tasks session entry is replaced').not.toMatch(
      /start a new session at (?:that )?workspace root and invoke the plan-to-tasks skill/i,
    );
    expect(routing, 'the ordinary or root-only handoff to a coding session stays represented').toMatch(
      /root-only|coding skill/i,
    );
    expect(routing, 'the planning session creates no implementation state').toMatch(
      /Do not start implementation in that planning session: no worktree, no implementation record/i,
    );

    const coding = flatten(codingText);
    expect(coding, 'the coding session performs the approved preparation').toMatch(/approved preparation/i);
    expect(flatten(section(codingText, '## Parent workspace execution')), 'workspace preparation loads its authority before implementation').toMatch(
      /Explicitly read `references\/workspace\.md` before approved preparation or any implementation state/i,
    );
    const preparation = flatten(section(await read('templates/skills/coding/references/workspace.md'), '## Approved preparation'));
    expect(preparation, 'distribution still precedes implementation').toContain(
      'ai-workflow workspace distribute --plan <directory>',
    );
    expect(preparation, 'preparation and distribution precede any implementation state').toMatch(
      /Before any implementation state, parent Coding runs approved preparation and distribution/i,
    );
    expect(coding, 'the completion checklist records the handoff').toMatch(
      /A planned change without a frozen plan ended the session after Planning/i,
    );

    const planning = flatten(await read('templates/skills/planning/SKILL.md'));
    expect(planning, 'Planning keeps the ordinary new-session coding handoff').toMatch(
      /tell the user to start a new session and invoke the coding skill/i,
    );
    expect(planning, 'Planning routes the child-participating workspace plan to a coding session at the workspace root').toMatch(
      /new session at <workspace-root>[\s\S]{0,160}?invoke (?:the )?coding\b/i,
    );
    expect(planning, 'Planning no longer designates plan-to-tasks as the new session skill').not.toMatch(
      /invoke plan-to-tasks with the absolute frozen plan directory/i,
    );

    const readme = await read('README.md');
    expect(readme, 'README documents the Planning-to-Coding session boundary').toMatch(
      /start a new session and invoke the coding skill/i,
    );
  });

  it('removes the approved-task bias from the catalog metadata', async () => {
    const codingMetadata = await read('templates/skills/coding/agents/openai.yaml');
    expect(codingMetadata, 'coding metadata names scoped changes').toMatch(/scoped coding changes/i);
    expect(codingMetadata, 'coding metadata drops the approved-task wording').not.toMatch(/approved task/i);

    const planningMetadata = await read('templates/skills/planning/agents/openai.yaml');
    expect(planningMetadata, 'planning metadata names its entry scope').toMatch(/new or ambiguous feature/i);
  });

  it('hands the child-participating workspace root session to the coding skill after the automatic chain completes', async () => {
    const documents = [
      { label: 'templates/project/AGENTS.md', text: await read('templates/project/AGENTS.md') },
      { label: 'README.md', text: await read('README.md') },
    ];

    for (const { label, text } of documents) {
      const flat = flatten(text);
      const sessionIndex = flat.search(/new session at (?:the )?workspace root/i);
      expect(sessionIndex, `${label} states the child-participating handoff as a new session at the workspace root`).toBeGreaterThanOrEqual(0);
      const handoff = flat.slice(sessionIndex, sessionIndex + 400);
      // The chain may be described before or around the handoff sentence, so the
      // chain assertions run against everything outside the handoff window.
      const outside = `${flat.slice(0, sessionIndex)} ${flat.slice(sessionIndex + 400)}`;

      // The window after the anchor is the coding handoff that implements the frozen plan.
      expect(handoff, `${label} invokes the coding skill at the workspace root`).toMatch(/coding skill/i);
      expect(handoff, `${label} hands off implementation of the frozen plan`).toMatch(
        /(?:implement\w*[^.]{0,200}frozen plan|frozen plan[^.]{0,200}implement\w*)/i,
      );

      // The automatic chain completes before that handoff.
      expect(outside, `${label} runs the plan-to-tasks preparation before the handoff`).toMatch(/plan-to-tasks/i);
      expect(outside, `${label} distributes the slices before the handoff`).toMatch(/workspace distribute\b/i);
      expect(outside, `${label} freezes the task set only after the full distribution`).toMatch(
        /frozen only after|freezes only after|freeze gate|not frozen until/i,
      );

      // The ordinary and root-only routes stay represented.
      expect(flat, `${label} keeps the ordinary or root-only route`).toMatch(/ordinary or root-only/i);
      expect(flat, `${label} keeps the ordinary coding-skill handoff`).toMatch(/invok\w* (?:the )?coding skill/i);
    }
  });
});

// Behavior boundary: the shipped instruction text is the public contract that decides
// whether an implementation is committed automatically through Git Operator and whether
// a run may report `done` without a successful commit. Direct and mechanical execution
// units keep the same commit requirement as planned work.
describe('automatic implementation commit', () => {
  // "Automatic delegation to Git Operator" in one period-delimited thought.
  const automaticGitOperator =
    /automatic\w*[^.]{0,160}?Git Operator|Git Operator[^.]{0,160}?automatic\w*/i;

  function sentencesWith(text: string, pattern: RegExp): string[] {
    return text.split(/(?<=[.!?])\s+/).filter((sentence) => pattern.test(sentence));
  }

  it('requires an automatic Git Operator commit and a commit-backed done gate on planned, direct and mechanical routes', async () => {
    const contract = flatten(await read('templates/project/AGENTS.md'));
    const coding = await read('templates/skills/coding/SKILL.md');
    const codingFlat = flatten(coding);
    const commitInstruction = flatten(section(coding, '## Verification and Commit'));
    const checklist = flatten(section(coding, '## Completion checklist'));
    const gate = `${commitInstruction} ${checklist}`;
    const operator = flatten(await read('templates/agents/git-operator.md'));

    // 1. The project contract and the Coding commit instructions make the
    //    implementation commit an automatic delegation to Git Operator.
    expect(
      contract,
      'the project contract states the implementation commit is automatically delegated to Git Operator',
    ).toMatch(automaticGitOperator);
    expect(
      commitInstruction,
      'Coding Verification and Commit states the implementation commit is automatically delegated to Git Operator',
    ).toMatch(automaticGitOperator);

    // 2. The automatic commit covers planned, direct and mechanical changes.
    const automaticCommits = sentencesWith(
      codingFlat,
      /automatic\w*[^.]{0,200}?(?:commit|Git Operator)/i,
    );
    for (const changeClass of ['planned', 'direct', 'mechanical']) {
      expect(
        automaticCommits.some((sentence) => new RegExp(changeClass, 'i').test(sentence)),
        `the automatic Git Operator commit explicitly covers ${changeClass} changes`,
      ).toBe(true);
    }

    // 3. An already authorized implementation needs no separate commit confirmation.
    expect(
      gate,
      'Coding removes a separate user confirmation before committing an already authorized implementation',
    ).toMatch(/(?:no|without|never)[^.]{0,100}?confirm\w*/i);
    expect(
      gate,
      'the no-extra-confirmation rule names the already authorized implementation',
    ).toMatch(/authoriz\w*/i);

    // 4. The done gate is backed by a successful commit and names its SHA; a failed
    //    or blocked commit cannot return done.
    expect(checklist, 'the completion checklist gates done on the commit result').toMatch(
      /(?:done|complete)[^.]{0,200}?commit|commit[^.]{0,200}?(?:done|complete)/i,
    );
    expect(checklist, 'the success gate names the commit SHA').toMatch(
      /commit[^.]{0,80}?SHA|SHA[^.]{0,80}?commit/i,
    );
    expect(checklist, 'a failed or blocked commit prevents done').toMatch(
      /commit[^.]{0,140}?(?:fail\w*|block\w*)|(?:fail\w*|block\w*)[^.]{0,140}?commit/i,
    );

    // 5. The Completion checklist and the Git Operator role agree on the automatic commit.
    expect(
      checklist,
      'the completion checklist and the Git Operator role agree that the commit happens automatically',
    ).toMatch(automaticGitOperator);
    expect(
      operator,
      'the Git Operator role documents the automatic implementation commit',
    ).toMatch(automaticGitOperator);
  });
});

// Behavior boundary: the shipped normative guidance for a child-participating workspace
// plan. Two independent consistency regressions lock the causal order of the automatic
// chain (SPEC-2/STD-02) and the recovery-only default for the parent Coding session's
// preparation (SPEC-1/STD-01). Each assertion is scoped to the paragraph that carries the
// rule, so another accurate paragraph in the same document cannot hide the defect.
describe('post-planning workspace chaining guidance is causally consistent', () => {
  it('invokes the automatic split immediately after the frozen pair validates, not after its own artifacts', async () => {
    const documents = [
      { label: 'templates/project/AGENTS.md', text: await read('templates/project/AGENTS.md') },
      { label: '.ai-workflow/AGENTS.md', text: await read('.ai-workflow/AGENTS.md') },
      { label: 'README.md', text: await read('README.md') },
      { label: 'MEMORY.md', text: await read('MEMORY.md') },
    ];

    for (const { label, text } of documents) {
      const blocks = blocksContaining(text, 'split by plan-to-tasks before implementation');
      expect(blocks.length, `${label} states the split-before-implementation rule`).toBeGreaterThan(0);

      for (const block of blocks) {
        // The automatic split is triggered by the frozen spec/plan pair passing
        // `plan validate`; the split then writes its own artifacts and distribution follows.
        expect(
          block,
          `${label} invokes the automatic split only after the frozen pair passes plan validate`,
        ).toMatch(
          /(?:(?:immediately|right|directly)\s+after|as soon as)[^.;]{0,160}?(?:frozen|spec\.md\/plan\.md|spec\/plan pair|plan pair)[^.;]{0,160}?(?:plan validate|validat)/i,
        );
        // It must not describe the split as starting only once its own written artifacts exist.
        expect(
          block,
          `${label} does not start the split only after its own task artifacts are written`,
        ).not.toMatch(
          /(?:split|plan-to-tasks)[^.;]{0,160}?\bafter\b\s+(?:the\s+|its\s+)?(?:task (?:triplets|documents|artifacts)|pair records|three task documents|workspace\.yaml)/i,
        );
      }
    }
  });

  it('defaults the parent Coding session to the delivery gate and scopes preparation to the recovery case', async () => {
    const documents = [
      { label: 'templates/project/AGENTS.md', text: await read('templates/project/AGENTS.md') },
      { label: '.ai-workflow/AGENTS.md', text: await read('.ai-workflow/AGENTS.md') },
      { label: 'README.md', text: await read('README.md') },
    ];

    for (const { label, text } of documents) {
      const blocks = blocksContaining(text, /one primary parent Coding session|Parent workspace coding orchestration/i);
      expect(blocks.length, `${label} states the parent workspace coding orchestration`).toBeGreaterThan(0);

      for (const block of blocks) {
        // Default: after the automatic chain, the parent Coding session verifies the
        // delivery gate and does not repeat the completed preparation.
        expect(
          block,
          `${label} defaults the parent Coding session to verifying the delivery gate without repeating the preparation`,
        ).toMatch(
          /(?:verif\w*|confirm\w*|check\w*|validat\w*|ensur\w*)[^.;]{0,160}?(?:delivery (?:gate|barrier)|distributed slices?|every participating slice present|workspace status|slice presence)|without repeating[^.;]{0,160}?(?:preparation|split|distribution)|(?:does not|never|without)[^.;]{0,80}?repeat/i,
        );
        // Recovery only: invoking the preparation or distribution is bound to a plan with
        // no task set or incomplete slices.
        expect(
          block,
          `${label} scopes invoking preparation or distribution to the no-task-set or incomplete-slices recovery case`,
        ).toMatch(
          /(?:no task set|missing task set|without a task set|incomplete slices?|slices? (?:are )?incomplete|partial slices?)[^.;]{0,220}?(?:plan-to-tasks|preparation procedure|preparation|distribut)|(?:plan-to-tasks|preparation procedure|preparation)[^.;]{0,220}?(?:no task set|missing task set|incomplete slices?|partial slices?)/i,
        );
      }
    }
  });
});
