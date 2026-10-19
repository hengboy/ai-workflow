import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Shipped portable prompt-transport protocol for the delegated coding workflow. These
// assertions read the public template surfaces that `install` and `init` copy to hosts and
// projects, so they describe the delivered instruction contract. They are static
// delivered-content evidence: they prove the protocol examples are shipped, not that a live
// model obeys them, and they make no runtime-cap or live-compliance claim.

const ROLE_TEMPLATES = [
  'templates/agents/backend.md',
  'templates/agents/frontend.md',
  'templates/agents/test.md',
  'templates/agents/file-explorer.md',
  'templates/agents/researcher.md',
  'templates/agents/documentation-maintainer.md',
  'templates/agents/spec-review.md',
  'templates/agents/standards-review.md',
  'templates/agents/git-operator.md',
] as const;

const CODING = 'templates/skills/coding/SKILL.md';
const WORKSPACE = 'templates/skills/coding/references/workspace.md';
const CORE = 'templates/project/AGENTS.md';
const MIRROR = '.ai-workflow/AGENTS.md';

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

/** Whitespace-normalized text so fragments match across source wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Raw slice of a heading-delimited section, stopping at the next heading of the given levels. */
function sectionRaw(text: string, marker: string, stops: readonly string[]): string {
  const start = text.indexOf(marker);
  if (start === -1) return '';
  const body = text.slice(start + marker.length);
  let end = -1;
  for (const stop of stops) {
    const at = body.indexOf(stop);
    if (at !== -1 && (end === -1 || at < end)) end = at;
  }
  return end === -1 ? body : body.slice(0, end);
}

/** The normalized `## Output checklist` region of a delivered report surface, or ''. */
function outputChecklist(text: string): string {
  return flatten(sectionRaw(text, '\n## Output checklist\n', ['\n## ']));
}

/**
 * REQ-001 / AC-001: every delivered report surface targets the whole report body at
 * most 1,200 Unicode code points for ordinary success and at most 3,000 for a review,
 * failure or blocked result, includes Summary and Evidence, and requires the author to
 * self-check. These are portable prompt instructions, not a programmatic runtime cap.
 */
describe('portable whole-body report targets (REQ-001 / AC-001)', () => {
  it('states the 1200/3000 whole-body targets, Summary/Evidence inclusion and self-check in all nine role checklists', async () => {
    for (const path of ROLE_TEMPLATES) {
      const region = outputChecklist(await read(path));
      expect(region, `${path} carries an Output checklist`).not.toBe('');
      expect(region, `${path} names the 1200 ordinary target`).toMatch(/1[,.]?200/);
      expect(region, `${path} names the 3000 review/failure/blocked target`).toMatch(/3[,.]?000/);
      expect(region, `${path} targets the whole report body`).toMatch(
        /whole[\s-]?(?:report[\s-]?)?body|entire (?:report|body)|whole report/i,
      );
      expect(region, `${path} bounds the Summary section`).toMatch(/\bSummary\b/);
      expect(region, `${path} bounds the Evidence section`).toMatch(/\bEvidence\b/);
      expect(region, `${path} requires an author self-check`).toMatch(
        /self[\s-]?check|check (?:the report )?before returning|before returning\b/i,
      );
      // Summary is not a documented loophole: the target must not exempt it.
      expect(region, `${path} does not exempt Summary from the target`).not.toMatch(
        /Summary[^.]{0,80}(?:exempt|excluded|not (?:counted|limited|included)|outside the (?:target|limit))/i,
      );
    }
  });

  it('states the same targets, boundary examples and non-BMP cases in the shared coding and core guidance', async () => {
    const coding = flatten(await read(CODING));
    const core = flatten(await read(CORE));
    for (const [label, text] of [
      ['the coding skill', coding],
      ['the core contract', core],
    ] as const) {
      expect(text, `${label} names the 1200 ordinary target`).toMatch(/1[,.]?200/);
      expect(text, `${label} names the 3000 exception target`).toMatch(/3[,.]?000/);
      expect(text, `${label} targets the whole report body`).toMatch(
        /whole[\s-]?(?:report[\s-]?)?body|entire (?:report|body)|whole report/i,
      );
      expect(text, `${label} requires an author self-check`).toMatch(/self[\s-]?check/i);
    }

    const guidance = flatten((await Promise.all([...ROLE_TEMPLATES, CODING, CORE].map(read))).join('\n'));
    // Boundary cases: an ordinary example at 1,200 and one code point above, a review/blocked
    // example at 3,000 and one above, and non-BMP characters in the example body.
    expect(guidance, 'the guidance carries a 1200 boundary example').toMatch(/1[,.]?200/);
    expect(guidance, 'the guidance carries a one-code-point-above example').toMatch(
      /1[,.]?201|one code ?point (?:above|over)|1200\s*\+\s*1|above by one/i,
    );
    expect(guidance, 'the guidance carries a 3000 boundary example').toMatch(/3[,.]?000/);
    expect(guidance, 'the guidance carries a 3001 one-above example').toMatch(
      /3[,.]?001|3000\s*\+\s*1/i,
    );
    expect(guidance, 'the boundary examples cover non-BMP characters').toMatch(
      /non-?BMP|astral|surrogate pair|emoji/i,
    );
  });

  it('labels the targets as prompt guidance and never as a host runtime cap', async () => {
    const guidance = flatten((await Promise.all([...ROLE_TEMPLATES, CODING, CORE].map(read))).join('\n'));
    expect(guidance, 'the protocol states it is portable prompt guidance').toMatch(
      /(?:portable )?prompt instructions?|guidance,? not (?:a )?(?:programmatic|runtime)|not (?:a )?programmatic(?:ally enforced)? cap|no runtime cap/i,
    );
    expect(guidance, 'no surface claims the host enforces the code-point target').not.toMatch(
      /(?:host|runtime|programmatically)[^.]{0,60}(?:enforces?|applies?|guarantees?)[^.]{0,40}(?:1[,.]?200|3[,.]?000)/i,
    );
  });
});

/**
 * REQ-001 / AC-002: complete findings take precedence over the length target when no
 * complete recoverable reference exists, the unmet protocol is exposed and acceptance
 * stays unresolved, and a fresh read-only digest grants no write permission, no automatic
 * replay of a completed operation and no claim to remove content already received.
 */
describe('complete-findings precedence and digest boundaries (REQ-001 / AC-002)', () => {
  const surfaces = [...ROLE_TEMPLATES, CODING, CORE] as const;

  it('retains complete findings and exposes the length exception instead of dropping facts', async () => {
    const guidance = flatten((await Promise.all(surfaces.map(read))).join('\n'));
    expect(guidance, 'complete findings take precedence over the length target').toMatch(
      /complete findings?[^.]{0,140}(?:precedence|before|outrank|over)[^.]{0,80}(?:length|brevity|target)|(?:length|brevity)[^.]{0,120}(?:not at the cost|yields? to|gives? way)[^.]{0,80}(?:findings|completeness)/i,
    );
    expect(guidance, 'the unmet protocol or length exception is visibly reported').toMatch(
      /(?:visible|expose|report|disclose)[^.]{0,120}(?:exception|unmet (?:protocol|length|condition))|exception[^.]{0,80}visible/i,
    );
    expect(guidance, 'acceptance stays unresolved without a recoverable reference').toMatch(
      /(?:leave|keeps?|remains?)[^.]{0,80}acceptance[^.]{0,40}unresolved|acceptance[^.]{0,60}unresolved/i,
    );
    expect(guidance, 'known SHA, exit-code, verdict and blocker facts are retained').toMatch(
      /(?:SHA|exit code|verdict|blocker)/i,
    );
  });

  it('forbids a fresh read-only digest from granting write, replay or removal', async () => {
    const guidance = flatten((await Promise.all([...surfaces, WORKSPACE].map(read))).join('\n'));
    expect(guidance, 'a fresh read-only digest is explicitly read-only').toMatch(
      /fresh[^.]{0,80}read-only[^.]{0,60}(?:digest|session)|read-only[^.]{0,60}(?:digest|session)/i,
    );
    expect(guidance, 'the digest grants no write or edit permission').toMatch(
      /(?:digest|read-only)[^.]{0,140}(?:no |not |never )(?:write|edit|mutat|file-write)|(?:no |not |never )[^.]{0,80}(?:write|edit)[^.]{0,80}permission[^.]{0,80}read-only/i,
    );
    expect(guidance, 'a completed operation is never automatically replayed').toMatch(
      /(?:never|not|no )[^.]{0,80}(?:rerun|replay|redo)[^.]{0,80}(?:completed|side effect|operation)/i,
    );
    expect(guidance, 'previously received content is not claimed as removed').toMatch(
      /(?:not|never|no )[^.]{0,80}(?:remov|discard)[^.]{0,80}(?:already|previously) received|(?:already|previously) received[^.]{0,80}(?:not|never)[^.]{0,60}(?:remov|discard)/i,
    );
  });

  it('keeps read-only reviewers without write permission', async () => {
    for (const path of ['templates/agents/spec-review.md', 'templates/agents/standards-review.md']) {
      const text = await read(path);
      expect(text, `${path} stays read-only`).toMatch(/^tools: \[read\]$/m);
      expect(text, `${path} gains no write permission`).not.toMatch(/^tools: \[[^\]]*\b(?:edit|write|shell)\b/m);
    }
  });
});

/**
 * REQ-002 / AC-003: the primary reads its current-phase task bodies rather than eagerly
 * reading future tasks, relies on verified workspace status, and references the frozen
 * task for canonical exact scopes instead of re-transporting both relative and resolved
 * lists. Leaves still self-read their fixed context and frozen inputs.
 */
describe('current-phase primary reads and canonical task references (REQ-002 / AC-003)', () => {
  it('requires the primary to read current-phase bodies and not eager future tasks', async () => {
    const guidance = flatten(`${await read(CODING)} ${await read(WORKSPACE)}`);
    expect(guidance, 'the primary inspects current-phase task bodies').toMatch(
      /current[- ]phase[^.]{0,140}(?:task bod|task file|task document|task)/i,
    );
    expect(guidance, 'the primary does not eagerly read future tasks').toMatch(
      /(?:not|never|rather than|instead of)[^.]{0,100}(?:eagerly read|read (?:all )?future|future tasks?|every task)/i,
    );
    expect(guidance, 'the primary relies on verified workspace status').toMatch(
      /verified (?:workspace )?status|workspace status[^.]{0,60}verified/i,
    );
  });

  it('references the frozen task for canonical scopes instead of repeating both lists', async () => {
    const guidance = flatten(`${await read(CODING)} ${await read(WORKSPACE)}`);
    expect(guidance, 'the frozen task supplies canonical read/write scopes').toMatch(
      /(?:frozen task|referenced (?:frozen )?task|task document)[^.]{0,140}(?:supplies?|provides?|carries?|is the source of)[^.]{0,80}canonical[^.]{0,40}(?:read\/write )?scope/i,
    );
    expect(guidance, 'the packet does not repeat both relative and resolved lists').toMatch(
      /(?:instead of|rather than|not)[^.]{0,100}(?:repeat|re-?transport|duplicat)[^.]{0,80}(?:relative and resolved|both lists|both scope lists)/i,
    );
  });

  it('keeps leaf self-reads and the common rules mandatory', async () => {
    const guidance = flatten(`${await read(CODING)} ${await read(WORKSPACE)}`);
    expect(guidance, 'each leaf self-reads its own fixed context').toMatch(
      /(?:each )?leaf[^.]{0,140}(?:its own|own)[^.]{0,80}(?:fixed context|AGENTS\.md)|(?:each )?leaf explicitly reads/i,
    );
    expect(guidance, 'the fixed-context self-read remains mandatory').toMatch(
      /\b(?:must|required|mandatory|explicitly)\b[^.]{0,80}(?:read|load)/i,
    );
  });
});

/**
 * REQ-002 / AC-004: a direct or mechanical unit without frozen inputs carries its complete
 * explicit scope with no missing-plan demand, while unreadable or contradictory sources
 * block before edits and neither broad discovery nor a frozen-input rewrite is introduced.
 */
describe('no-plan scope and source-refusal boundaries (REQ-002 / AC-004)', () => {
  it('gives a no-plan unit its complete explicit scope without demanding a missing plan', async () => {
    const guidance = flatten(`${await read(CODING)} ${await read('templates/agents/git-operator.md')}`);
    expect(guidance, 'a no-plan unit carries its complete explicit scope').toMatch(
      /(?:direct or mechanical|without a frozen plan|no frozen plan)[^.]{0,140}(?:complete|full|entire)[^.]{0,40}explicit scope|complete explicit scope/i,
    );
    expect(guidance, 'no missing-plan demand is made for a no-plan unit').toMatch(
      /(?:not|never|without|do not)[^.]{0,60}(?:demand|require|ask for|need)[^.]{0,60}(?:a )?(?:missing )?(?:spec\.md|plan\.md|task file)/i,
    );
  });

  it('blocks on unreadable or contradictory sources and adds no broad discovery or frozen rewrite', async () => {
    const guidance = flatten(`${await read(CODING)} ${await read(CORE)}`);
    expect(guidance, 'unreadable or contradictory sources block before edits').toMatch(
      /(?:unreadable|contradictory|missing)[^.]{0,140}(?:source|frozen (?:input|plan)|authorit)[^.]{0,90}(?:block|stop|refus)[^.]{0,60}(?:before|edits?)/i,
    );
    expect(guidance, 'no broader whole-repository discovery is introduced').toMatch(
      /(?:no|never|without)[^.]{0,60}(?:broad|wider|whole[- ]repository)[^.]{0,40}discovery/i,
    );
    expect(guidance, 'frozen inputs are never rewritten').toMatch(
      /(?:never|not|no )[^.]{0,60}(?:rewrite|edit)[^.]{0,60}frozen (?:input|spec|plan|task)/i,
    );
  });
});

/**
 * REQ-003 / AC-005: the compact core contract is at most 60% of the captured pre-edit
 * source measured over the entire file in Unicode code points, its tracked mirror is
 * byte-identical, and every distinct normative obligation maps to retained accessible
 * authority (core, or the applicable Coding/workspace reference for primary-only detail).
 * A common leaf rule must not be hidden behind a primary-only optional reference.
 */
describe('compact core contract with retained-obligation mapping (REQ-003 / AC-005)', () => {
  // Scalar captured from the pre-edit `templates/project/AGENTS.md` before any Step 2 edit.
  const SOURCE_BASELINE_CODE_POINTS = 35107;
  const REDUCTION_TARGET = Math.floor(SOURCE_BASELINE_CODE_POINTS * 0.6);

  it('reduces the entire source file to at most 60% of the captured baseline', async () => {
    const source = await read(CORE);
    const count = [...source].length;
    expect(
      count,
      `templates/project/AGENTS.md has ${count} code points, at most 60% of the captured baseline ${SOURCE_BASELINE_CODE_POINTS} (${REDUCTION_TARGET})`,
    ).toBeLessThanOrEqual(REDUCTION_TARGET);
  });

  it('keeps the tracked mirror byte-identical to the delivered source', async () => {
    const sourceBytes = await readFile(packagePath(CORE));
    const mirrorBytes = await readFile(packagePath(MIRROR));
    expect(
      mirrorBytes.equals(sourceBytes),
      'the tracked .ai-workflow/AGENTS.md mirror equals templates/project/AGENTS.md byte-for-byte',
    ).toBe(true);
  });

  it('retains every distinct normative obligation in the core or the applicable coding/workspace authority', async () => {
    const authority = flatten((await Promise.all([CORE, CODING, WORKSPACE].map(read))).join('\n'));
    const obligations: ReadonlyArray<readonly [string, RegExp]> = [
      ['change routing classes', /Direct change[\s\S]{0,400}Planned change[\s\S]{0,400}Mechanical change/i],
      ['class-only review trigger', /change class is the only routine review trigger/i],
      ['aggregate repair with one targeted recheck', /aggregate repair[\s\S]{0,400}targeted recheck|targeted recheck[\s\S]{0,400}aggregate repair/i],
      ['worktree confinement', /(?:project-local )?temporary worktree|single worktree/i],
      ['synchronization preflight', /sync-hook[^.]{0,80}--phase/i],
      ['notes governance pointer', /\.ai-workflow\/notes\/README\.md/],
      ['durable-artifact identifier prohibition', /transient plan-internal identifiers/i],
      ['navigation JSON authority', /navigation\.json[^.]{0,80}authoritative|JSON is authoritative/i],
      ['single implementation record', /implementation\.yaml/],
      ['Git Operator Git exclusivity', /Git Operator is the only role allowed to run Git|Git operations? (?:are allowed )?only through Git Operator/i],
      ['fresh sub-agent session boundary', /new native (?:sub-agent )?session/i],
      ['host-native role frontmatter', /model_reasoning_effort|allowed-tools|mode: subagent/i],
      ['MEMORY currency rule', /current standards and behavior/i],
    ];
    for (const [obligation, pattern] of obligations) {
      expect(authority, `retained obligation: ${obligation}`).toMatch(pattern);
    }
  });

  it('keeps common leaf rules in the core rather than only behind a primary-only reference', async () => {
    const core = flatten(await read(CORE));
    // The Markdown report shape and the durable-artifact rule bind every delegated role, so
    // they are common leaf obligations and must remain in the core contract itself.
    expect(core, 'the common report shape stays in the core').toMatch(
      /### Status[\s\S]{0,200}### Summary[\s\S]{0,200}### Evidence[\s\S]{0,200}### Support Requests/i,
    );
    expect(core, 'the common durable-artifact rule stays in the core').toMatch(
      /transient plan-internal identifiers/i,
    );
    expect(core, 'the common fixed-context read stays in the core').toMatch(/MEMORY\.md/);
  });
});

/**
 * REQ-004 / AC-008 and REQ-005 / AC-009, AC-010: the deterministic maintenance role
 * division, the preserved nine-role frontmatter/tools and five synchronization targets,
 * and the static-example evidence labels that make no live-compliance or runtime-cap
 * claim.
 */
describe('maintenance division, preserved boundaries and static evidence labels (REQ-004, REQ-005)', () => {
  it('keeps Documentation Maintainer non-Git, non-source and dependency-free of a new tool', async () => {
    const maintainerRaw = await read('templates/agents/documentation-maintainer.md');
    const maintainer = flatten(maintainerRaw);
    expect(maintainer, 'maintainer may not run Git').toMatch(/may not run Git|do not commit/i);
    expect(maintainer, 'maintainer may not edit source or tests').toMatch(/may not edit source/i);
    expect(maintainerRaw, 'maintainer keeps its exact tool set').toMatch(/^tools: \[read, edit\]$/m);

    const division = flatten(`${await read(CODING)} ${await read(CORE)}`);
    expect(division, 'shell-capable generation/pairing/validation is delegated by the primary').toMatch(
      /(?:primary|orchestrator)[^.]{0,160}(?:delegat\w+)[^.]{0,160}(?:generation|pairing|validation)[^.]{0,80}command/i,
    );
    expect(division, 'no additional maintenance command is introduced').toMatch(
      /no (?:additional|new) maintenance command|not introduce[^.]{0,60}(?:new|additional) command/i,
    );
  });

  it('preserves the five managed synchronization targets and the nine native role frontmatter/tools', async () => {
    const targets = await read('src/sync/artifacts.ts');
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['templates/project/AGENTS.md', '.ai-workflow/AGENTS.md'],
      ['templates/project/notes/AGENTS.md', '.ai-workflow/notes/AGENTS.md'],
      ['templates/project/notes/README.md', '.ai-workflow/notes/README.md'],
      ['templates/project/notes/implemented/AGENTS.md', '.ai-workflow/notes/implemented/AGENTS.md'],
      ['templates/project/notes/archived/AGENTS.md', '.ai-workflow/notes/archived/AGENTS.md'],
    ];
    for (const [source, target] of pairs) {
      expect(targets, `the five-target allowlist still maps ${source} to ${target}`).toMatch(
        new RegExp(`source:\\s*'${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[\\s\\S]{0,40}?target:\\s*'${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      );
    }
    expect((targets.match(/target:\s*'\.ai-workflow\//g) ?? []).length, 'exactly five managed targets remain').toBe(5);

    expect(ROLE_TEMPLATES.length, 'exactly nine managed role templates').toBe(9);
    for (const path of ROLE_TEMPLATES) {
      expect(await read(path), `${path} keeps native role frontmatter`).toMatch(
        /^name: [a-z-]+$/m,
      );
    }
  });

  it('labels measurements as static protocol evidence and makes no live-compliance or runtime-cap claim', async () => {
    const guidance = flatten(
      (await Promise.all([CODING, CORE, WORKSPACE, 'README.md'].map(read))).join('\n'),
    );
    expect(guidance, 'the guidance distinguishes static protocol evidence from live behavior').toMatch(
      /instruction delivery|not (?:a )?(?:live|runtime) (?:compliance|behavior|model)|prompt instructions?, not|static (?:protocol |delivered |shipped )?(?:example|evidence|content)|protocol examples?/i,
    );
    expect(guidance, 'no total-window, latency or live-compliance guarantee is claimed').not.toMatch(
      /(?:guarantees?|ensures?)[^.]{0,60}(?:150k|total (?:context|window)|latency|live compliance)/i,
    );
  });
});

/**
 * REQ-002 / AC-003 and REQ-005 / AC-009: the fixed eight-task reference fixture and the
 * measurable scope-transport comparison.
 *
 * This is a deterministic static protocol fixture: it models one ordinary split and one
 * workspace packaging of the same eight concrete tasks, each with fixed metadata, absolute
 * source/worktree/plan/task references, version anchors, role, goal, assigned coverage,
 * permitted commands and the current-phase schedule reference. It then compares a
 * pre-change packet that repeated both the relative and resolved scope lists against the
 * canonical frozen-task-scope reference packet for the same eight tasks.
 *
 * The measured volumes are shipped instruction-transport examples only: they are not live
 * read counts, not proof that a live agent obeys the instructions, and not a programmatic
 * runtime-cap or model-compliance claim.
 */
describe('fixed eight-task reference fixture and scope-transport volumes (REQ-005 / AC-003, AC-009)', () => {
  const SOURCE_ROOT = '/Users/yuqiyu/AiHistorys/ai-workflow';
  const WORKTREE = `${SOURCE_ROOT}/.worktrees/20261019-prompt-context-transport`;
  const PLAN_DIR = `${SOURCE_ROOT}/.ai-workflow/plans/20261019-prompt-context-transport`;
  const BASELINE_COMMIT = 'd4ac0142808c4975fbc160b8726f06d307b34ea4';
  const FIXED_ANCHOR = 'daaa04532a5c68812f047959e2542cbb2049b076';
  const SPEC_DIGEST = 'sha256:47d3440a52e77b0529cb338dc5cddfde7a771b174316c298bb242d9ee5d46dc6';
  const PLAN_DIGEST = 'sha256:e0851633bb1f2abaa436c1e893838b84e11769e7f2986c15dd86d20322852904';

  type WorkspaceRepository = 'engine' | 'interface';

  interface FixedTask {
    readonly id: string;
    readonly phase: number;
    readonly repository: WorkspaceRepository;
    readonly role: string;
    readonly goal: string;
    readonly coverage: readonly string[];
    readonly commands: readonly string[];
    readonly readScopes: readonly string[];
    readonly writeScopes: readonly string[];
  }

  // Exactly eight concrete tasks. Identifiers, phases, roles, goals, coverage, commands and
  // scopes are fixed fixture data; nothing here reads the live project or a live session.
  const FIXED_TASKS: readonly FixedTask[] = [
    {
      id: 'T01',
      phase: 1,
      repository: 'engine',
      role: 'backend',
      goal: 'Render the concise escaped navigation catalog',
      coverage: ['REQ-003/AC-006'],
      commands: ['pnpm exec vitest run tests/unit/navigation-builder.test.ts'],
      readScopes: ['src/context/navigation.ts', 'tests/unit/navigation-builder.test.ts'],
      writeScopes: ['src/context/navigation.ts'],
    },
    {
      id: 'T02',
      phase: 1,
      repository: 'engine',
      role: 'backend',
      goal: 'Preserve authoritative JSON bytes across a render-only refresh',
      coverage: ['REQ-004/AC-007'],
      commands: ['pnpm exec vitest run tests/integration/navigation-refresh-cli.test.ts'],
      readScopes: ['src/context/validate.ts', 'src/cli.ts'],
      writeScopes: ['src/context/validate.ts'],
    },
    {
      id: 'T03',
      phase: 2,
      repository: 'interface',
      role: 'documentation-maintainer',
      goal: 'Align all nine role templates on the whole-report targets',
      coverage: ['REQ-001/AC-001'],
      commands: ['pnpm exec vitest run tests/behavior/prompt-context-transport.test.ts'],
      readScopes: ['templates/agents/backend.md', 'templates/agents/test.md'],
      writeScopes: ['templates/agents/backend.md'],
    },
    {
      id: 'T04',
      phase: 2,
      repository: 'interface',
      role: 'documentation-maintainer',
      goal: 'Ship current-phase primary-read and canonical task-scope guidance',
      coverage: ['REQ-002/AC-003'],
      commands: ['pnpm exec vitest run tests/behavior/coding-v2-content.test.ts'],
      readScopes: ['templates/skills/coding/SKILL.md', 'templates/skills/coding/references/workspace.md'],
      writeScopes: ['templates/skills/coding/SKILL.md'],
    },
    {
      id: 'T05',
      phase: 3,
      repository: 'interface',
      role: 'documentation-maintainer',
      goal: 'Compact the core contract without dropping a distinct obligation',
      coverage: ['REQ-003/AC-005'],
      commands: ['pnpm exec vitest run tests/behavior/memory-governance-content.test.ts'],
      readScopes: ['templates/project/AGENTS.md', '.ai-workflow/AGENTS.md'],
      writeScopes: ['templates/project/AGENTS.md'],
    },
    {
      id: 'T06',
      phase: 3,
      repository: 'engine',
      role: 'test',
      goal: 'Capture the source, catalog and packet-example transport volumes',
      coverage: ['REQ-005/AC-009'],
      commands: ['pnpm exec vitest run tests/behavior/prompt-context-transport.test.ts'],
      readScopes: ['tests/behavior/prompt-context-transport.test.ts', 'src/workflow/read-scope.ts'],
      writeScopes: ['tests/behavior/prompt-context-transport.test.ts'],
    },
    {
      id: 'T07',
      phase: 4,
      repository: 'interface',
      role: 'spec-review',
      goal: 'Check requirement coverage, testability and scope of the delivery',
      coverage: ['REQ-005/AC-009'],
      commands: ['pnpm exec vitest run tests/behavior/prompt-context-transport.test.ts'],
      readScopes: ['templates/project/AGENTS.md', 'tests/behavior/prompt-context-transport.test.ts'],
      writeScopes: [],
    },
    {
      id: 'T08',
      phase: 4,
      repository: 'engine',
      role: 'standards-review',
      goal: 'Check MEMORY and note consistency against the delivered standards',
      coverage: ['REQ-005/AC-010'],
      commands: ['pnpm exec vitest run tests/behavior/review-policy.test.ts'],
      readScopes: ['MEMORY.md', '.ai-workflow/notes/implemented/process/2026-10-19-prompt-context-transport.md'],
      writeScopes: [],
    },
  ];

  // Expected boundaries are declared independently of the fixture builder so the check
  // never derives its expectation from the value under test.
  const EXPECTED_TASK_IDS: readonly string[] = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08'];
  const EXPECTED_PHASES: readonly (readonly string[])[] = [
    ['T01', 'T02'],
    ['T03', 'T04'],
    ['T05', 'T06'],
    ['T07', 'T08'],
  ];

  const REPOSITORY_WORKTREES: Record<WorkspaceRepository, string> = {
    engine: `${SOURCE_ROOT}/repos/engine/.worktrees/20261019-prompt-context-transport`,
    interface: `${SOURCE_ROOT}/repos/interface/.worktrees/20261019-prompt-context-transport`,
  };

  /** The absolute frozen-task reference for a fixture task. */
  function taskPath(id: string): string {
    return `${PLAN_DIR}/tasks/${id}.md`;
  }

  /** Shared packet header: absolute refs, version anchors and the current-phase schedule. */
  function headerLines(repositoryLabel: string): string[] {
    const schedule = EXPECTED_PHASES.map((phase) => `[${phase.join(' ')}]`).join('');
    return [
      `source root: ${SOURCE_ROOT}`,
      `worktree: ${WORKTREE}`,
      `plan: ${PLAN_DIR}`,
      `repository: ${repositoryLabel}`,
      `version anchors: source baseline commit=${BASELINE_COMMIT} frozen anchor=${FIXED_ANCHOR} spec digest=${SPEC_DIGEST} plan digest=${PLAN_DIGEST}`,
      `current-phase schedule: ${PLAN_DIR}/tasks/execution-order.yaml phases=${schedule} current=phase 1`,
    ];
  }

  /** The pre-change packet: repeats both the relative and the resolved scope list per task. */
  function preChangePacket(tasks: readonly FixedTask[], repositoryLabel: string, workspace: boolean): string {
    const lines = [
      `PACKET ${workspace ? 'workspace' : 'ordinary-split'} (pre-change: repeated relative+resolved scopes)`,
      ...headerLines(repositoryLabel),
    ];
    for (const task of tasks) {
      const resolvedRead = task.readScopes.map((scope) => `${WORKTREE}/${scope}`).join(', ');
      const resolvedWrite = task.writeScopes.map((scope) => `${WORKTREE}/${scope}`).join(', ');
      const placement = workspace
        ? ` repository=${task.repository} repository-worktree=${REPOSITORY_WORKTREES[task.repository]}`
        : '';
      lines.push(
        `task ${task.id} phase=${task.phase} role=${task.role}${placement}`,
        `goal: ${task.goal}`,
        `coverage: ${task.coverage.join(', ')}`,
        `read scopes (relative): ${task.readScopes.join(', ')}`,
        `read scopes (resolved): ${resolvedRead}`,
        `write scopes (relative): ${task.writeScopes.join(', ')}`,
        `write scopes (resolved): ${resolvedWrite}`,
        `commands: ${task.commands.join(', ')}`,
        `task ref: ${taskPath(task.id)}`,
      );
    }
    return lines.join('\n');
  }

  /** The canonical packet: references the frozen task instead of repeating either list. */
  function canonicalPacket(tasks: readonly FixedTask[], repositoryLabel: string, workspace: boolean): string {
    const lines = [
      `PACKET ${workspace ? 'workspace' : 'ordinary-split'} (canonical frozen-task-scope reference)`,
      ...headerLines(repositoryLabel),
    ];
    for (const task of tasks) {
      const placement = workspace
        ? ` repository=${task.repository} repository-worktree=${REPOSITORY_WORKTREES[task.repository]}`
        : '';
      lines.push(
        `task ${task.id} phase=${task.phase} role=${task.role}${placement}`,
        `goal: ${task.goal}`,
        `coverage: ${task.coverage.join(', ')}`,
        `canonical exact read/write scopes: see ${taskPath(task.id)} (frozen plan digest ${PLAN_DIGEST})`,
        `commands: ${task.commands.join(', ')}`,
        `task ref: ${taskPath(task.id)}`,
      );
    }
    return lines.join('\n');
  }

  /** Deterministic measurement emitted into the test-run evidence with an explicit label. */
  function measure(label: string, text: string): { codepoints: number; utf8Bytes: number } {
    const codepoints = [...text].length;
    const utf8Bytes = Buffer.byteLength(text, 'utf8');
    console.log(`STATIC ${label}: codepoints=${codepoints} utf8bytes=${utf8Bytes}`);
    return { codepoints, utf8Bytes };
  }

  it('fixes exactly eight concrete tasks with complete metadata, absolute refs and anchors', () => {
    expect(FIXED_TASKS, 'the fixture carries exactly eight concrete tasks').toHaveLength(8);
    expect(FIXED_TASKS.map((task) => task.id)).toEqual(EXPECTED_TASK_IDS);
    expect(FIXED_TASKS.map((task) => task.phase)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    for (const task of FIXED_TASKS) {
      expect(task.role, `${task.id} names a role`).not.toBe('');
      expect(task.goal, `${task.id} carries a goal`).not.toBe('');
      expect(task.coverage.length, `${task.id} carries assigned coverage`).toBeGreaterThan(0);
      expect(task.commands.length, `${task.id} carries permitted commands`).toBeGreaterThan(0);
      expect(task.readScopes.length, `${task.id} carries read scopes`).toBeGreaterThan(0);
      expect(taskPath(task.id).startsWith(`${PLAN_DIR}/tasks/`), `${task.id} has an absolute plan task reference`).toBe(true);
      for (const scope of [...task.readScopes, ...task.writeScopes]) {
        expect(scope.startsWith('/'), `${task.id} scope ${scope} stays a relative worktree path`).toBe(false);
      }
    }
    const repositories = new Set(FIXED_TASKS.map((task) => task.repository));
    console.log(`STATIC SOURCE eight-task fixture: tasks=${FIXED_TASKS.length} phases=${EXPECTED_PHASES.length} repositories=${repositories.size}`);
  });

  it('covers every task exactly once across the frozen current-phase schedule', () => {
    const scheduled = EXPECTED_PHASES.flat();
    expect(scheduled, 'every task appears exactly once').toEqual(EXPECTED_TASK_IDS);
    expect(new Set(scheduled).size, 'no task is scheduled twice').toBe(8);
    expect(EXPECTED_PHASES, 'the frozen schedule has four parallel phases').toHaveLength(4);
    for (const phase of EXPECTED_PHASES) {
      expect(phase).toHaveLength(2);
    }
    console.log(`STATIC SOURCE eight-task schedule reference: phases=${EXPECTED_PHASES.length} tasks=${scheduled.length} current=phase 1`);
  });

  it('compares pre-change scope transport with the canonical frozen-task-scope packet for the same eight tasks', () => {
    const ordinaryPre = preChangePacket(FIXED_TASKS, 'ai-workflow', false);
    const ordinaryCanonical = canonicalPacket(FIXED_TASKS, 'ai-workflow', false);
    const workspacePre = preChangePacket(FIXED_TASKS, 'workspace-root', true);
    const workspaceCanonical = canonicalPacket(FIXED_TASKS, 'workspace-root', true);

    // Pre-change repeats both the relative and the resolved scope lists.
    expect(ordinaryPre, 'the pre-change packet repeats relative scopes').toContain('read scopes (relative):');
    expect(ordinaryPre, 'the pre-change packet repeats resolved scopes').toContain('read scopes (resolved):');
    expect(ordinaryPre, 'the resolved read scope is the worktree-absolute path').toContain(`${WORKTREE}/src/context/navigation.ts`);
    expect(workspacePre, 'the workspace pre-change packet also repeats resolved scopes').toContain(`${WORKTREE}/src/context/navigation.ts`);

    // The canonical packet references the frozen task instead of repeating either list.
    for (const packet of [ordinaryCanonical, workspaceCanonical]) {
      expect(packet, 'the canonical packet references the frozen task scope').toContain('canonical exact read/write scopes: see');
      expect(packet, 'the canonical packet does not repeat the relative scope list').not.toContain('scopes (relative):');
      expect(packet, 'the canonical packet does not repeat the resolved scope list').not.toContain('scopes (resolved):');
      expect(packet, 'the canonical packet carries no worktree-resolved scope path').not.toContain(`${WORKTREE}/src/context/navigation.ts`);
      for (const id of EXPECTED_TASK_IDS) {
        expect(packet, `the canonical packet keeps the ${id} reference`).toContain(`task ref: ${taskPath(id)}`);
      }
    }

    // Required authority is preserved in every packaging.
    for (const packet of [ordinaryPre, ordinaryCanonical, workspacePre, workspaceCanonical]) {
      for (const anchor of [SOURCE_ROOT, WORKTREE, PLAN_DIR, BASELINE_COMMIT, FIXED_ANCHOR, SPEC_DIGEST, PLAN_DIGEST, 'current=phase 1']) {
        expect(packet, `the packet preserves ${anchor}`).toContain(anchor);
      }
      for (const task of FIXED_TASKS) {
        expect(packet, `the packet preserves the ${task.id} goal`).toContain(task.goal);
        expect(packet, `the packet preserves the ${task.id} coverage`).toContain(task.coverage.join(', '));
        expect(packet, `the packet preserves the ${task.id} commands`).toContain(task.commands.join(', '));
      }
    }

    const ordinaryPreVolume = measure('PACKET-EXAMPLE pre-change repeated relative+resolved (ordinary split)', ordinaryPre);
    const ordinaryCanonicalVolume = measure('PACKET-EXAMPLE canonical frozen-task-scope reference (ordinary split)', ordinaryCanonical);
    const workspacePreVolume = measure('PACKET-EXAMPLE pre-change repeated relative+resolved (workspace)', workspacePre);
    const workspaceCanonicalVolume = measure('PACKET-EXAMPLE canonical frozen-task-scope reference (workspace)', workspaceCanonical);

    expect(ordinaryCanonicalVolume.codepoints, 'the canonical ordinary-split packet is smaller than the pre-change packet').toBeLessThan(ordinaryPreVolume.codepoints);
    expect(ordinaryCanonicalVolume.utf8Bytes, 'the canonical ordinary-split packet is smaller in UTF-8 bytes').toBeLessThan(ordinaryPreVolume.utf8Bytes);
    expect(workspaceCanonicalVolume.codepoints, 'the canonical workspace packet is smaller than the pre-change packet').toBeLessThan(workspacePreVolume.codepoints);
    expect(workspaceCanonicalVolume.utf8Bytes, 'the canonical workspace packet is smaller in UTF-8 bytes').toBeLessThan(workspacePreVolume.utf8Bytes);
  });

  it('provides deterministic exact-size report-body boundary protocol examples', () => {
    const REPORT_SHAPE = '### Status\ndone\n### Summary\nsummary\n### Evidence\n';
    const sizedReportBody = (size: number): string => REPORT_SHAPE + 'x'.repeat(size - [...REPORT_SHAPE].length);

    const ordinary = sizedReportBody(1200);
    const ordinaryOver = sizedReportBody(1201);
    const review = sizedReportBody(3000);
    const reviewOver = sizedReportBody(3001);
    const nonBmp = '😀'.repeat(1200);

    expect([...ordinary], 'the ordinary example is exactly 1200 code points').toHaveLength(1200);
    expect([...ordinaryOver], 'the ordinary example one code point above is 1201').toHaveLength(1201);
    expect([...review], 'the review/failure/blocked example is exactly 3000 code points').toHaveLength(3000);
    expect([...reviewOver], 'the review/failure/blocked example one code point above is 3001').toHaveLength(3001);
    expect([...nonBmp], 'a non-BMP character counts as one code point').toHaveLength(1200);
    expect(Buffer.byteLength(nonBmp, 'utf8'), 'the same non-BMP body is four UTF-8 bytes per code point').toBe(4800);

    measure('PROTOCOL EXAMPLE ordinary report body at the limit', ordinary);
    measure('PROTOCOL EXAMPLE ordinary report body one code point above', ordinaryOver);
    measure('PROTOCOL EXAMPLE review/failure/blocked body at the limit', review);
    measure('PROTOCOL EXAMPLE review/failure/blocked body one code point above', reviewOver);
    measure('PROTOCOL EXAMPLE non-BMP body counted by code point', nonBmp);
  });
});
