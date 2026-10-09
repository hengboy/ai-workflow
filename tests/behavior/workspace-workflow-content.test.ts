import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

const CODING_SKILL = ['templates', 'skills', 'coding', 'SKILL.md'];
const PLAN_TO_TASKS_SKILL = ['templates', 'skills', 'plan-to-tasks', 'SKILL.md'];
const GIT_OPERATOR = ['templates', 'agents', 'git-operator.md'];
const PROJECT_CONTRACT = ['templates', 'project', 'AGENTS.md'];

/** Read a shipped template without importing it, so a missing file is an assertion, not a crash. */
async function readShipped(parts: string[]): Promise<string | null> {
  try {
    return await readFile(packagePath(...parts), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Extract one Markdown heading section up to the next heading of the same or higher
 * level, so a level-three section nested under a level-two section is isolated.
 */
function section(text: string, heading: string, level = 2): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s/.exec(lines[index] ?? '');
    if (match && (match[1]?.length ?? 0) <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Extract the body of every ```text fenced example. */
function textFences(text: string): string[] {
  return [...text.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

/** Whitespace-normalized text so multi-word fragments match across source wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** Assert every required fragment appears in the scoped text, naming the missing fragment. */
function expectFragments(haystack: string, fragments: readonly string[], scope: string): void {
  for (const fragment of fragments) {
    expect(haystack, `${scope} must contain "${fragment}"`).toContain(fragment);
  }
}

describe('coding implements a slice inside its own repository (REQ-007 / AC-014, AC-015)', () => {
  it('ships a Slice sessions section that refuses a mismatched slice before any worktree or record', async () => {
    const text = await readShipped(CODING_SKILL);
    expect(text, 'the coding skill is shipped').not.toBeNull();
    const slice = section(text ?? '', '## Slice sessions');
    expect(slice, 'the Slice sessions section exists').not.toBe('');

    expectFragments(
      flatten(slice),
      [
        'slice manifest',
        'workspace.yaml',
        'refuses',
        'does not match',
        'before creating a worktree',
        'implementation record'
      ],
      'the Slice sessions identity refusal'
    );
  });

  it('implements only the slice tasks inside that repository and reports the delivery commit', async () => {
    const slice = section((await readShipped(CODING_SKILL)) ?? '', '## Slice sessions');
    expect(slice, 'the Slice sessions section exists').not.toBe('');

    expectFragments(
      flatten(slice),
      ['implements only', 'slice tasks', 'inside that repository', 'delivery commit'],
      'the slice scope and delivery report'
    );
  });

  it('completes a slice with slice plan validate, repository notes validate and MEMORY', async () => {
    const slice = section((await readShipped(CODING_SKILL)) ?? '', '## Slice sessions');
    expect(slice, 'the Slice sessions section exists').not.toBe('');

    expectFragments(
      flatten(slice),
      ['ai-workflow plan validate', 'ai-workflow notes validate', 'MEMORY.md'],
      'the slice completion checks'
    );
  });
});

describe('workspace finalization pins delivery commits through Git Operator (REQ-009 / AC-018, AC-019)', () => {
  it('ships a Workspace finalization section that verifies completed slices and pins pointers', async () => {
    const text = await readShipped(CODING_SKILL);
    expect(text, 'the coding skill is shipped').not.toBeNull();
    const finalization = section(text ?? '', '## Workspace finalization');
    expect(finalization, 'the Workspace finalization section exists').not.toBe('');

    expectFragments(
      flatten(finalization),
      [
        'all slices are completed',
        'delivery commit',
        'read-only Git',
        'source repository',
        'workspace worktree',
        'empty submodule directories',
        'stages only',
        'pointer',
        'git update-index --cacheinfo 160000,<sha>,<path>',
        'root_tasks_commit'
      ],
      'the Workspace finalization procedure'
    );
  });

  it('reports finalization readiness and finalizes in the already-running parent session without reopening it', async () => {
    const finalization = section((await readShipped(CODING_SKILL)) ?? '', '## Workspace finalization');
    expect(finalization, 'the Workspace finalization section exists').not.toBe('');

    expectFragments(
      flatten(finalization),
      ['ready_for_finalization', 'ai-workflow workspace status --plan <directory>', 'already'],
      'the workspace finalization readiness handoff'
    );
    expect(
      flatten(finalization),
      'the already-running parent session performs finalization rather than reopening itself',
    ).toMatch(/already[- ]running[^.]{0,80}(?:parent|root)[^.]{0,80}(?:session|finalization)|does not emit an instruction to reopen itself/i);

    const prompts = textFences(finalization);
    expect(prompts.length, 'the Workspace finalization ships at least one ```text example').toBeGreaterThan(0);
    const prompt = flatten(prompts.join('\n'));
    expect(prompt, 'the shipped finalization prompt invokes coding').toMatch(/coding skill/i);
    expectFragments(
      prompt,
      ['<workspace-root>', 'ai-workflow workspace status --plan <workspace-plan-directory>'],
      'the shipped finalization prompt'
    );
  });

  it('ships a Workspace pointer commit section in the Git Operator agent', async () => {
    const text = await readShipped(GIT_OPERATOR);
    expect(text, 'the git-operator agent is shipped').not.toBeNull();
    const pointer = section(text ?? '', '### Workspace pointer commit', 3);
    expect(pointer, 'the Workspace pointer commit section exists').not.toBe('');

    expectFragments(
      flatten(pointer),
      [
        'workspace worktree',
        'empty submodule directories',
        'git update-index --cacheinfo 160000,<sha>,<path>',
        'git cat-file -e',
        'before',
        'stages only',
        'pointer',
        'entire authorized batch',
        'Before any index mutation',
        'stages nothing',
        'missing second SHA must not leave the first pointer staged'
      ],
      'the Workspace pointer commit section'
    );
  });
});

describe('decision records stay in their owning repository (REQ-010 / AC-020)', () => {
  it('ships a Note ownership section splitting workspace-root and child notes as plain plan-ID text', async () => {
    const text = await readShipped(CODING_SKILL);
    expect(text, 'the coding skill is shipped').not.toBeNull();
    const ownership = section(text ?? '', '## Note ownership');
    expect(ownership, 'the Note ownership section exists').not.toBe('');

    expectFragments(
      flatten(ownership),
      ['plain plan-ID text', 'never links', 'workspace root', 'decision', 'each repository', 'delivered facts', 'MEMORY.md'],
      'the Note ownership section'
    );
  });

  it('ships a Workspaces section in the project contract covering boundary, order, commands and finalization', async () => {
    const text = await readShipped(PROJECT_CONTRACT);
    expect(text, 'the project contract is shipped').not.toBeNull();
    const workspaces = section(text ?? '', '## Workspaces');
    expect(workspaces, 'the Workspaces section exists').not.toBe('');

    expectFragments(
      flatten(workspaces),
      [
        '.gitmodules',
        'submodule boundar',
        '<root>/.ai-workflow/plans/<planId>',
        'repository-level order',
        'ai-workflow workspace distribute --plan <directory>',
        'ai-workflow workspace status --plan <directory>',
        'read-only Git',
        'exception',
        'worktree confinement',
        'moving submodule checkouts after the pin is out of scope',
        'plain plan-ID text',
        'decision',
        'delivered facts',
        'finalization',
        'pointer'
      ],
      'the Workspaces section'
    );
  });
});

describe('plan-to-tasks completes a workspace split by distributing slices (REQ-001 / AC-001, AC-002, AC-003)', () => {
  it('states in Outcome that a workspace split also hands each participating repository its slice', async () => {
    const text = await readShipped(PLAN_TO_TASKS_SKILL);
    expect(text, 'the plan-to-tasks skill is shipped').not.toBeNull();
    const outcome = section(text ?? '', '## Outcome');
    expect(outcome, 'the Outcome section exists').not.toBe('');

    expectFragments(
      flatten(outcome),
      ['hands each participating repository its slice'],
      'the Outcome workspace completion'
    );
  });

  it('requires the approval preview to announce the slice writes and the distribute command', async () => {
    const preview = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Approval preview');
    expect(preview, 'the Approval preview section exists').not.toBe('');

    expectFragments(
      flatten(preview),
      [
        'writes a slice into each participating repository',
        'ai-workflow workspace distribute --plan <directory>'
      ],
      'the approval preview slice announcement'
    );
  });

  it('runs distribution after the task triplets, pair records and plan validate, then reports each slice state', async () => {
    const workspace = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');

    expectFragments(
      flatten(workspace),
      [
        'after the task triplets and their pair records',
        'ai-workflow plan validate --plan <directory>',
        'ai-workflow workspace distribute --plan <directory>',
        'slice state',
        'reserved root entry'
      ],
      'the workspace split distribution completion'
    );
  });

  it('reports each repository name, path and slice state in delivery order with the workspace status command', async () => {
    const workspace = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');

    const flat = flatten(workspace);
    expect(flat, 'the completion report names each participating repository with its name and path').toMatch(
      /each participating repository[^.]*name[^.]*path/i,
    );
    expectFragments(
      flat,
      [
        'slice state',
        'delivery order',
        'reserved root entry',
        'ai-workflow workspace status --plan <directory>'
      ],
      'the workspace completion report'
    );
  });

  it('hands the next Coding session a copyable prompt naming the frozen plan directory', async () => {
    const workspace = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');

    expectFragments(
      flatten(workspace),
      ['next Coding', 'copy', 'prompt', 'frozen plan directory'],
      'the next-session handoff prompt'
    );

    const prompts = textFences(workspace);
    expect(prompts.length, 'the Workspace split ships at least one ```text example').toBeGreaterThan(0);
    const prompt = flatten(prompts.join('\n'));
    expect(prompt, 'the shipped prompt actually invokes coding').toMatch(/coding skill/i);
    expectFragments(
      prompt,
      [
        '<repository-root>',
        '<repository-plan-directory>',
        'ai-workflow workspace status --plan <workspace-plan-directory>'
      ],
      'the shipped next-Coding prompt'
    );
  });

  it('refuses with a rerun of workspace distribute after repair and keeps the not-ready wording', async () => {
    const workspace = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');

    expectFragments(
      flatten(workspace),
      ['not ready', 'repair', 'rerun', 'ai-workflow workspace distribute --plan <directory>'],
      'the workspace split refusal repair rerun'
    );
  });

  it('reports a refusal without declaring the plan ready and keeps the written artifacts in place', async () => {
    const workspace = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');

    expectFragments(
      flatten(workspace),
      ['exact error', 'repair instructions', 'not ready for coding', 'stay in place'],
      'the workspace split refusal report'
    );
  });

  it('exempts a workspace plan that declares only the reserved workspace root entry', async () => {
    const workspace = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');

    expectFragments(
      flatten(workspace),
      ['reserved workspace root entry', 'implemented unsplit'],
      'the plan-to-tasks root-only workspace exemption'
    );
  });
});

describe('coding gates an undistributed workspace plan (REQ-002, REQ-003 / AC-004, AC-005, AC-006)', () => {
  it('refuses an undistributed cross-repository workspace plan using workspace status before any worktree or record', async () => {
    const text = await readShipped(CODING_SKILL);
    expect(text, 'the coding skill is shipped').not.toBeNull();
    const coding = flatten(text ?? '');

    expectFragments(
      coding,
      [
        'at least one non-root participating repository',
        'workspace status --plan <directory>',
        'before creating a worktree',
        'implementation record',
        'plan-to-tasks',
        'ai-workflow workspace distribute --plan <directory>',
        'root-only',
        'unsplit'
      ],
      'the coding workspace handoff gate'
    );
  });

  it('refuses a participating repository with no slice manifest and names the distribute repair', async () => {
    const text = await readShipped(CODING_SKILL);
    expect(text, 'the coding skill is shipped').not.toBeNull();
    const slice = section(text ?? '', '## Slice sessions');
    expect(slice, 'the Slice sessions section exists').not.toBe('');

    expectFragments(
      flatten(slice),
      [
        'missing manifest',
        'workspace.yaml',
        'before creating a worktree',
        'implementation record',
        'ai-workflow workspace distribute --plan <directory>'
      ],
      'the missing slice manifest refusal'
    );
  });
});

describe('the shipped contract states the workspace split rule (REQ-004 / AC-007)', () => {
  it('requires the split and distribution for a cross-repository workspace plan and exempts a root-only plan', async () => {
    const text = await readShipped(PROJECT_CONTRACT);
    expect(text, 'the project contract is shipped').not.toBeNull();
    const workspaces = section(text ?? '', '## Workspaces');
    expect(workspaces, 'the Workspaces section exists').not.toBe('');

    expectFragments(
      flatten(workspaces),
      [
        'at least one non-root participating repository',
        'before implementation',
        'ai-workflow workspace distribute --plan <directory>',
        'reserved workspace root entry',
        'implemented unsplit'
      ],
      'the shipped workspace split rule'
    );
  });
});

describe('coding distinguishes Workspace root sessions', () => {
  it('selects only the root-owned tasks of the parent plan in frozen file order without editing the schedule', async () => {
    const text = await readShipped(CODING_SKILL);
    expect(text, 'the coding skill is shipped').not.toBeNull();
    const root = section(text ?? '', '## Workspace root sessions');
    expect(root, 'the Workspace root sessions section exists').not.toBe('');

    expectFragments(
      flatten(root),
      ['task.repo', 'workspace', 'file order', 'never edit', 'recompute', 'DAG'],
      'the Workspace root session task selection'
    );
  });

  it('gates root task delivery before a worktree and runs finalization-only with no new status', async () => {
    const root = section((await readShipped(CODING_SKILL)) ?? '', '## Workspace root sessions');
    expect(root, 'the Workspace root sessions section exists').not.toBe('');

    expectFragments(
      flatten(root),
      ['delivery gate', 'before creating a worktree', 'skip', 'root_tasks_commit', 'finalization-only', 'zero task', 'no new status'],
      'the Workspace root session delivery gate'
    );
  });
});

describe('plan-to-tasks reports the next repository including root-owned tasks', () => {
  it('reports the next repository including root-owned tasks instead of a child-only advisory', async () => {
    const workspace = section((await readShipped(PLAN_TO_TASKS_SKILL)) ?? '', '## Workspace split');
    expect(workspace, 'the Workspace split section exists').not.toBe('');
    const flat = flatten(workspace);

    expect(flat, 'the Workspace split names next_repository').toMatch(/next_repository/i);
    expect(flat, 'the reported next repository includes root-owned tasks').toMatch(/root-owned/i);
    expect(flat, 'the next repository must not stay a child-only advisory').not.toMatch(/child-only/i);
  });
});

const WORKSPACE_REFERENCE = ['templates', 'skills', 'coding', 'references', 'workspace.md'];
const ROLE_TEMPLATES = [
  'backend',
  'frontend',
  'test',
  'file-explorer',
  'documentation-maintainer',
  'spec-review',
  'standards-review',
  'researcher',
  'git-operator',
] as const;
const CONTRACTS: string[][] = [
  ['templates', 'project', 'AGENTS.md'],
  ['.ai-workflow', 'AGENTS.md'],
];

describe('the parent workspace reference carries the detailed procedure (REQ-001..REQ-008)', () => {
  it('ships the linked reference file', async () => {
    const text = await readShipped(WORKSPACE_REFERENCE);
    expect(text, 'templates/skills/coding/references/workspace.md is shipped').not.toBeNull();
    expect((text ?? '').length).toBeGreaterThan(0);
  });

  it('covers activation and preflight plus phase dispatch and delivery barriers', async () => {
    const reference = flatten((await readShipped(WORKSPACE_REFERENCE)) ?? '');
    expectFragments(reference, ['.gitmodules', 'activation', 'preflight', 'phase', 'delivery barrier'], 'the reference activation and phase dispatch');
    expect(reference, 'a whole phase is awaited and verified').toMatch(/whole phase[^.]{0,80}(?:await|verif)|(?:await|verif)[^.]{0,80}whole phase/i);
  });

  it('covers repository worktrees, commits and the packet contract', async () => {
    const reference = flatten((await readShipped(WORKSPACE_REFERENCE)) ?? '');
    expectFragments(
      reference,
      ['<source-root>/.worktrees/<planId>', 'ai-workflow/<planId>', 'packet', 'workdir', 'absolute path'],
      'the reference worktree and packet contract'
    );
    expect(reference, 'task commits are checked for exact parentage').toMatch(/parentage/i);
    expect(reference, 'rename endpoints are part of the commit scope').toMatch(/rename/i);
  });

  it('covers per-repository delivery review, a separate finalization review and checkpoint/recovery rules', async () => {
    const reference = flatten((await readShipped(WORKSPACE_REFERENCE)) ?? '');
    expectFragments(
      reference,
      ['per-repository delivery review', 'finalization review', 'checkpoint', 'recovery', 'clean, fully checkpointed phase boundary'],
      'the reference review and recovery rules'
    );
    expect(reference, 'residue stops with bounded support').toMatch(/bounded support/i);
  });

  it('states same-parent finalization after all children are delivered', async () => {
    const reference = flatten((await readShipped(WORKSPACE_REFERENCE)) ?? '');
    expect(reference, 'the parent session finalizes itself').toMatch(/same[- ]parent/i);
    expect(reference, 'finalization follows every child delivery').toMatch(/all children (?:are )?delivered|after (?:all )?children delivery/i);
  });

  it('states the non-goals: no nested coordinator, no remote sessions and no child-in-root fallback', async () => {
    const reference = flatten((await readShipped(WORKSPACE_REFERENCE)) ?? '');
    expectFragments(reference, ['no nested coordinator', 'no remote sessions'], 'the reference non-goals');
    expect(reference, 'child tasks never fall back into the root').toMatch(/no fallback[^.]{0,90}root|fallback[^.]{0,60}child tasks[^.]{0,40}root/i);
  });
});

describe('the nine role templates handle packets without imposing workspace-only fields (REQ-004)', () => {
  it('states exact absolute paths and an explicit per-command workdir', async () => {
    for (const role of ROLE_TEMPLATES) {
      const template = flatten((await readShipped(['templates', 'agents', `${role}.md`])) ?? '');
      expect(template, `${role} is shipped`).not.toBe('');
      expect(template, `${role} states exact absolute paths`).toMatch(/absolute path/i);
      expect(template, `${role} states a per-command workdir`).toMatch(/workdir|working directory/i);
    }
  });

  it('explicitly reads the child repository contract, MEMORY and navigation inside a child repository', async () => {
    for (const role of ROLE_TEMPLATES) {
      const template = flatten((await readShipped(['templates', 'agents', `${role}.md`])) ?? '');
      expect(template, `${role} reads the child project contract`).toContain('.ai-workflow/AGENTS.md');
      expect(template, `${role} reads the child MEMORY`).toContain('MEMORY');
      expect(template, `${role} reads the child navigation`).toContain('navigation');
      expect(template, `${role} names a child repository`).toMatch(/child repository/i);
    }
  });

  it('keeps unchanged leaf permissions and prohibits nested dispatch', async () => {
    for (const role of ROLE_TEMPLATES) {
      const template = flatten((await readShipped(['templates', 'agents', `${role}.md`])) ?? '');
      expect(template, `${role} prohibits nested dispatch`).toMatch(/no nested dispatch|nested dispatch|never dispatch|does not dispatch/i);
    }
  });
});

describe('both contracts state the workspace execution boundary (REQ-009)', () => {
  it('activates the route only for a child-participating frozen plan matched to .gitmodules', async () => {
    for (const parts of CONTRACTS) {
      const text = flatten((await readShipped(parts)) ?? '');
      expect(text, `${parts.join('/')} is shipped`).not.toBe('');
      expect(text, `${parts.join('/')} names .gitmodules`).toContain('.gitmodules');
      expect(text, `${parts.join('/')} requires a frozen plan`).toMatch(/frozen plan/i);
      expect(text, `${parts.join('/')} requires a non-root participant`).toMatch(/at least one (?:participating )?non-root/i);
    }
  });

  it('states parent-only native orchestration, one run-owned worktree per repository and Git Operator exclusivity', async () => {
    for (const parts of CONTRACTS) {
      const text = flatten((await readShipped(parts)) ?? '');
      expect(text, `${parts.join('/')} keeps orchestration in the parent`).toMatch(/native orchestration|primary parent|parent-only/i);
      expect(text, `${parts.join('/')} owns one worktree per repository`).toMatch(/one run-owned worktree per (?:active )?repository|run-owned worktree per repository/i);
      expect(text, `${parts.join('/')} names Git Operator`).toMatch(/Git Operator/i);
      expect(text, `${parts.join('/')} keeps Git Operator exclusive`).toMatch(/only role allowed to run Git|Git operations? (?:are allowed )?only through Git Operator|all Git/i);
    }
  });

  it('states the single checkpoint CLI record rule and the separated delivery and finalization reviews', async () => {
    for (const parts of CONTRACTS) {
      const text = flatten((await readShipped(parts)) ?? '');
      expect(text, `${parts.join('/')} names the checkpoint command`).toContain('ai-workflow workspace checkpoint --plan <directory> --repo <name>');
      expect(text, `${parts.join('/')} names the single record`).toContain('implementation.yaml');
      expect(text, `${parts.join('/')} scopes the delivery review`).toMatch(/per-repository delivery review|repository delivery review/i);
      expect(text, `${parts.join('/')} scopes finalization separately`).toMatch(/separate finalization review|finalization review/i);
    }
  });

  it('states bounded recovery and keeps ordinary and root-only behavior unchanged', async () => {
    for (const parts of CONTRACTS) {
      const text = flatten((await readShipped(parts)) ?? '');
      expect(text, `${parts.join('/')} bounds recovery`).toMatch(/bounded (?:support|recovery)/i);
      expect(text, `${parts.join('/')} preserves the ordinary route`).toMatch(/ordinary|root-only/i);
    }
  });
});

describe('the Git Operator owns the repository worktree and delivery lifecycle (REQ-005, REQ-008)', () => {
  it('documents per-repository worktree identity, scoped commits and non-fast-forward delivery', async () => {
    const operator = flatten((await readShipped(GIT_OPERATOR)) ?? '');
    expect(operator, 'the common-directory identity check is documented').toContain('--git-common-dir');
    expect(operator, 'the per-repository worktree path is documented').toContain('<source-root>/.worktrees/<planId>');
    expect(operator, 'the per-repository branch is documented').toContain('ai-workflow/<planId>');
    expect(operator, 'task commits are checked for exact parentage').toMatch(/parentage/i);
    expect(operator, 'both rename endpoints are checked').toMatch(/rename/i);
    expect(operator, 'delivery integration is non-fast-forward').toMatch(/non-fast-forward/i);
    expect(operator, 'cleanup is owned').toMatch(/owned cleanup|run-owned/i);
  });

  it('documents finalization batch preverification and exact final-tree pointer updates', async () => {
    const operator = flatten((await readShipped(GIT_OPERATOR)) ?? '');
    expect(operator).toMatch(/entire authorized batch/i);
    expect(operator).toMatch(/before any index mutation/i);
    expect(operator).toContain('git update-index --cacheinfo 160000,<sha>,<path>');
    expect(operator, 'the pointer update names the exact final tree').toMatch(/final[- ]tree/i);
  });
});
