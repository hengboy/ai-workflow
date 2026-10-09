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

  it('keeps the routing standard in the project memory template and the README', async () => {
    const memory = await read('templates/project/MEMORY.md');
    expect(flatten(memory), 'MEMORY records the routing standard').toMatch(
      /Requests are classified before work starts[^.]*implemented directly without Planning or the dual-axis review/i,
    );
    expect(memory, 'MEMORY keeps the plan path for planned changes').toMatch(
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
    expect(routing, 'plan-to-tasks remains the preparation procedure invoked by the parent session').toMatch(
      /plan-to-tasks/i,
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
    expect(coding, 'distribution still precedes implementation').toContain(
      'ai-workflow workspace distribute --plan <directory>',
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

  it('routes the child-participating handoff to a coding session that prepares and distributes, not a standalone plan-to-tasks session', async () => {
    const documents = [
      { label: 'MEMORY.md', text: await read('MEMORY.md') },
      { label: 'templates/project/MEMORY.md', text: await read('templates/project/MEMORY.md') },
      { label: 'README.md', text: await read('README.md') },
    ];

    for (const { label, text } of documents) {
      const flat = flatten(text);
      const sessionIndex = flat.search(/new session at (?:the )?workspace root/i);
      expect(sessionIndex, `${label} states the child-participating handoff as a new session at the workspace root`).toBeGreaterThanOrEqual(0);
      const handoff = flat.slice(sessionIndex, sessionIndex + 400);

      const codingIndex = handoff.search(/coding skill/i);
      const planToTasksIndex = handoff.search(/plan-to-tasks/i);
      expect(codingIndex, `${label} invokes the coding skill at the workspace root for the child-participating handoff`).toBeGreaterThanOrEqual(0);
      expect(planToTasksIndex, `${label} names plan-to-tasks as the preparation procedure`).toBeGreaterThanOrEqual(0);
      expect(
        codingIndex,
        `${label} does not enter a standalone plan-to-tasks session: the workspace-root session invokes the coding skill before plan-to-tasks`,
      ).toBeLessThan(planToTasksIndex);
      expect(handoff, `${label} states plan-to-tasks as the preparation`).toMatch(/preparation/i);
      expect(handoff, `${label} distributes the slices before implementation`).toMatch(/workspace distribute\b/i);
      expect(handoff, `${label} distributes the slices before implementation`).toMatch(/before implementation/i);

      // The ordinary and root-only routes stay represented.
      expect(flat, `${label} keeps the ordinary or root-only route`).toMatch(/ordinary or root-only/i);
      expect(flat, `${label} keeps the ordinary coding-skill handoff`).toMatch(/invok\w* (?:the )?coding skill/i);
    }
  });
});
