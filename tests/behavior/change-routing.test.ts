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

  it('stops a coding session after Planning and hands off to a new session', async () => {
    const coding = flatten(await read('templates/skills/coding/SKILL.md'));

    expect(coding, 'a planned change with no frozen plan runs Planning first').toMatch(
      /planned change has no frozen plan[^.]*run Planning first/i,
    );
    expect(coding, 'the planning session stops and hands off to a new session').toMatch(
      /tell the user to start a new session and invoke the coding skill/i,
    );
    expect(coding, 'the planning session creates no implementation state').toMatch(
      /Do not start implementation in that planning session: no worktree, no implementation record/i,
    );
    expect(coding, 'the completion checklist records the handoff').toMatch(
      /A planned change without a frozen plan ended the session after Planning/i,
    );

    const planning = flatten(await read('templates/skills/planning/SKILL.md'));
    expect(planning, 'Planning itself ends with the new-session handoff').toMatch(
      /tell the user to start a new session and invoke the coding skill/i,
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
});
