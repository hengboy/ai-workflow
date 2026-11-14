import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Shipped-content evidence for the read-only operator tooling and its documentation.
// These assertions read the delivered README, MEMORY, navigation and skill artifacts.
// Runtime command behavior is covered by the module unit and CLI integration suites.

const README = 'README.md';
const MEMORY = 'MEMORY.md';
const NAVIGATION_JSON = '.ai-workflow/index/navigation.json';
const NAVIGATION_MD = '.ai-workflow/index/navigation.md';
const CODING = 'templates/skills/coding/SKILL.md';
const REVIEW_REFERENCE = 'templates/skills/coding/references/review.md';

const MODULES = [
  'src/ops/doctor.ts',
  'src/install/verify.ts',
  'src/workflow/validate.ts',
  'src/workflow/review-packet.ts',
  'src/workflow/dispatch.ts',
  'src/workflow/report.ts',
  'src/host/smoke.ts',
] as const;

const TEST_FILES = [
  'tests/unit/install-verify.test.ts',
  'tests/unit/ops-doctor.test.ts',
  'tests/unit/workflow-review-packet.test.ts',
  'tests/unit/workflow-dispatch.test.ts',
  'tests/unit/workflow-report.test.ts',
  'tests/unit/host-smoke.test.ts',
  'tests/integration/doctor-cli.test.ts',
  'tests/integration/review-packet-cli.test.ts',
  'tests/integration/plan-dispatch-cli.test.ts',
  'tests/integration/plan-report-cli.test.ts',
  'tests/integration/host-smoke-cli.test.ts',
  'tests/behavior/operator-tooling-content.test.ts',
] as const;

const NOT_A_GATE =
  /\bnot\b[^.]{0,80}\b(?:workflow[- ])?gates?\b|\bnever (?:a |an )?(?:workflow[- ])?gates?\b|inspection and reporting aids?, not (?:a )?(?:workflow )?gates?/i;

const ALL_COMMANDS = [
  /ai-workflow doctor\b/i,
  /ai-workflow review packet\b/i,
  /ai-workflow plan dispatch\b/i,
  /ai-workflow plan report\b/i,
  /ai-workflow host smoke\b/i,
];

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

/** Whitespace-normalized text so assertions are insensitive to wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Bounded normalized windows around every anchor occurrence. */
function windows(text: string, anchor: RegExp, before = 800, after = 3000): string[] {
  const flat = flatten(text);
  const flags = anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`;
  return [...flat.matchAll(new RegExp(anchor.source, flags))].map((match) => {
    const index = match.index ?? 0;
    return flat.slice(Math.max(0, index - before), Math.min(flat.length, index + after));
  });
}

/**
 * Requires one bounded window that satisfies every check, so an overview mention in
 * one place and an unrelated statement elsewhere cannot jointly satisfy an obligation.
 */
function expectNear(
  text: string,
  anchor: RegExp,
  checks: ReadonlyArray<readonly [string, RegExp]>,
  label: string,
  before = 800,
  after = 3000,
): void {
  const candidates = windows(text, anchor, before, after);
  expect(candidates.length, `${label}: the command is mentioned`).toBeGreaterThan(0);
  const missingByWindow = candidates.map((candidate) =>
    checks.filter(([, pattern]) => !pattern.test(candidate)).map(([description]) => description),
  );
  const closest = missingByWindow.reduce((left, right) =>
    left.length <= right.length ? left : right,
  );
  expect(
    closest,
    `${label}: one nearby section must state ${checks.map(([description]) => description).join(', ')}`,
  ).toEqual([]);
}

describe('README operator tooling (REQ-008 / AC-009)', () => {
  it('documents doctor as a read-only aggregate health check with its exit codes', async () => {
    const readme = await read(README);
    expectNear(
      readme,
      /ai-workflow doctor\b/i,
      [
        ['the aggregate health purpose', /(?:aggregat\w*|health check|health report|readiness report)/i],
        ['the checked adoption, sync, navigation, notes, installation or host state', /(?:adoption|contract|synchroni[sz]ation|navigation|notes|installation|host)/i],
        ['the read-only boundary', /read-only/i],
        ['no network, file or Git mutation', /(?:writes? no|writes? nothing|no (?:file|network|git) (?:writes?|mutation)|(?:no|never|without)[^.]{0,160}(?:network|file|git)[^.]{0,120}(?:request\w*|writes?|mutation|access)|without (?:writing|network access|git mutation)|does not write)/i],
        ['exit 0 for a healthy result', /\b0\b[^.]{0,100}(?:pass|healthy|all)/i],
        ['exit 2 for warnings', /\b2\b[^.]{0,100}warn/i],
        ['exit 1 for failures', /\b1\b[^.]{0,100}(?:fail|failure)/i],
      ],
      'README doctor section',
    );
  });

  it('documents the review packet generator as read-only assembly that decides nothing', async () => {
    const readme = await read(README);
    expectNear(
      readme,
      /ai-workflow review packet\b/i,
      [
        ['the Spec and Standards axes', /(?:spec|standards)/i],
        ['the initial and recheck modes', /(?:initial|recheck)/i],
        ['rendering from supplied or exported evidence', /(?:assemble|render|supplied|exported evidence)/i],
        ['stdout-only or no-file behavior', /(?:stdout|no file|writes? only|writes? nothing)/i],
        ['never deciding an axis, finding or verdict', /never (?:decides?|selects?|infers?)|does not (?:decide|select|infer)/i],
      ],
      'README review packet section',
    );
  });

  it('documents plan dispatch as the current-phase packet view without writes or schedule recomputation', async () => {
    const readme = await read(README);
    expectNear(
      readme,
      /ai-workflow plan dispatch\b/i,
      [
        ['the current or selected phase', /(?:current|selected) phase/i],
        ['the task packet content', /(?:task packets?|packets?)/i],
        ['the scopes, roles or anchors', /(?:scope|role|anchor)/i],
        ['the no-write boundary', /(?:does not write|writes no|writes nothing|no file|read-only)/i],
        ['no schedule recomputation', /(?:does not|never)[^.]{0,120}(?:recompute|recomputes|recomputation)/i],
      ],
      'README plan dispatch section',
    );
  });

  it('documents plan report as read-only lifecycle and execution reporting that labels unknown fields', async () => {
    const readme = await read(README);
    expectNear(
      readme,
      /ai-workflow plan report\b/i,
      [
        ['the creation, start or completion times', /(?:creation|created|start|started|completion|completed)/i],
        ['task, phase, critical-path or execution-projection counts', /(?:task|phase|critical[- ]path|projection)/i],
        ['commits only for a recorded range', /commit/i],
        ['unknown for unavailable fields', /unknown/i],
        ['the no-write or no-Git-mutation boundary', /(?:does not write|writes no|writes nothing|no file|read-only|no git mutation)/i],
      ],
      'README plan report section',
    );
  });

  it('documents smoke isolation, PASS/UNVERIFIED/BLOCKED honesty, cleanup, --keep and the real-host limit', async () => {
    const readme = await read(README);
    expectNear(
      readme,
      /ai-workflow host smoke\b/i,
      [
        ['a temporary or disposable HOME', /(?:temporary|disposable|isolated) (?:HOME|home)/i],
        ['PASS results', /\bPASS\b/],
        ['UNVERIFIED results', /\bUNVERIFIED\b/],
        ['BLOCKED results', /\bBLOCKED\b/],
        ['cleanup or retention of the fixture', /(?:remove[sd]?|cleanup|delete[sd]?|retain[sd]?|cleans?)[^.]{0,200}(?:exit|--keep|after the run)/i],
        ['the --keep retention option', /--keep/i],
        ['the real HOME or working-project refusal', /(?:real HOME|real home|working project|real project)/i],
      ],
      'README host smoke section',
    );
  });

  it('states the shared read-only and not-a-gate boundary beside the operator tooling', async () => {
    const readme = await read(README);
    const shared = windows(readme, /ai-workflow (?:doctor|review packet|plan dispatch|plan report|host smoke)\b/i, 1500, 4000);
    expect(shared.length, 'README describes the operator commands').toBeGreaterThan(0);
    const nearOperatorMaterial = shared.some(
      (window) =>
        ALL_COMMANDS.filter((command) => command.test(window)).length >= 2 &&
        /read-only/i.test(window) &&
        NOT_A_GATE.test(window),
    );
    expect(
      nearOperatorMaterial,
      'README groups the operator commands with a read-only and not-a-gate statement',
    ).toBe(true);
  });
});

describe('MEMORY operator-tooling standard (REQ-008 / AC-009)', () => {
  it('records the read-only commands, the not-a-gate boundary and the no-Agent-Note rationale', async () => {
    const memory = await read(MEMORY);
    const anchors = [/operator[- ]tooling/i, /ai-workflow doctor\b/i];
    const candidates = anchors.flatMap((anchor) => windows(memory, anchor, 400, 5000));
    expect(candidates.length, 'MEMORY records the operator-tooling standard').toBeGreaterThan(0);

    const missingByWindow = candidates.map((candidate) =>
      [
        ...ALL_COMMANDS.map((command, index) => [
          `command ${index + 1}`,
          command.test(candidate),
        ] as const),
        ['the read-only boundary', /read-only/i.test(candidate)],
        ['the not-a-gate boundary', NOT_A_GATE.test(candidate)],
        ['no new Agent Note', /no (?:new )?(?:Agent )?Note/i.test(candidate)],
        ['the note-exemption rationale', /(?:README|MEMORY|tests?)/i.test(candidate) && /(?:rationale|reason|(?:fully )?(?:express|record)\w*|document\w*|supersed\w*)/i.test(candidate)],
      ]
        .filter(([, present]) => !present)
        .map(([description]) => description),
    );
    const closest = missingByWindow.reduce((left, right) =>
      left.length <= right.length ? left : right,
    );
    expect(
      closest,
      'one MEMORY standard must name all five read-only commands, the not-a-gate boundary, and the no-note rationale',
    ).toEqual([]);
  });
});

describe('operator-tooling navigation feature (REQ-008 / AC-009)', () => {
  it('indexes the new modules, tests and an ordered read scope under one feature', async () => {
    const navigation = JSON.parse(await read(NAVIGATION_JSON)) as {
      features?: Array<{
        id?: string;
        entries?: string[];
        tests?: string[];
        read_scope?: string[];
      }>;
    };
    const feature = navigation.features?.find((candidate) => candidate.id === 'operator-tooling');
    expect(feature, 'navigation.json has one operator-tooling feature').toBeDefined();

    expect(feature?.entries ?? [], 'the feature entries include every new module').toEqual(
      expect.arrayContaining([...MODULES]),
    );
    expect(feature?.tests ?? [], 'the feature tests include the new unit and CLI test files').toEqual(
      expect.arrayContaining([...TEST_FILES]),
    );

    const readScope = feature?.read_scope ?? [];
    expect(readScope.length, 'the feature read_scope is a populated read order').toBeGreaterThan(3);
    expect(new Set(readScope).size, 'the read order has no duplicate paths').toBe(readScope.length);
    expect(readScope, 'the read order starts from the workflow authorities').toEqual(
      expect.arrayContaining(['.ai-workflow/AGENTS.md', 'MEMORY.md']),
    );
    expect(readScope, 'the read order reaches an operator-tooling module').toEqual(
      expect.arrayContaining([expect.stringMatching(/^src\/(?:ops|install|workflow|host)\//)]),
    );
    expect(readScope, 'the read order reaches this behavior test').toContain(
      'tests/behavior/operator-tooling-content.test.ts',
    );
    expect(
      readScope.filter((path) => /[*?{}[\]]/.test(path)),
      'the read order uses only exact paths',
    ).toEqual([]);
  });

  it('renders the operator-tooling catalog entry with its locate command', async () => {
    const markdown = flatten(await read(NAVIGATION_MD));
    expect(markdown, 'navigation.md contains the operator-tooling catalog row').toMatch(
      /\|\s*operator-tooling\s*\|/i,
    );
    expect(markdown, 'the catalog row carries the locate command').toContain(
      'ai-workflow context locate --feature operator-tooling --verify',
    );
  });
});

describe('optional packet generators in the shipped coding guidance (REQ-008 / AC-009)', () => {
  const REVIEW_PACKET =
    /ai-workflow review packet\b|review[- ]packet generator|review packet generator/i;
  const DISPATCH_PACKET =
    /ai-workflow plan dispatch\b|dispatch[- ]packet generator|dispatch packet generator/i;

  it('mentions the review-packet and dispatch-packet generators as optional assembly aids', async () => {
    const coding = flatten(await read(CODING));
    const review = flatten(await read(REVIEW_REFERENCE));
    const documents: ReadonlyArray<readonly [string, string]> = [
      [CODING, coding],
      [REVIEW_REFERENCE, review],
    ];

    for (const [path, text] of documents) {
      const mentionsGenerator = REVIEW_PACKET.test(text) || DISPATCH_PACKET.test(text);
      expect(mentionsGenerator, `${path} mentions an optional packet generator`).toBe(true);
    }

    const union = `${coding} ${review}`;
    for (const [name, anchor] of [
      ['review packet', REVIEW_PACKET],
      ['dispatch packet', DISPATCH_PACKET],
    ] as const) {
      const candidates = windows(union, anchor, 300, 700);
      expect(candidates.length, `the ${name} generator is named`).toBeGreaterThan(0);
      expect(
        candidates.some((candidate) => /optional/i.test(candidate)),
        `the ${name} generator is described as optional`,
      ).toBe(true);
      expect(
        candidates.some((candidate) =>
          /(?:does not|never|no|without)[^.]{0,180}(?:changes?|changed|changing|alters?|replaces?|bypass\w*)[^.]{0,140}(?:gate|role|repair budget|mandatory context)|(?:gate|role|repair budget|mandatory context)[^.]{0,180}(?:unchanged|does not change|never changes)/i.test(
            candidate,
          ),
        ),
        `the ${name} generator does not change gates, roles, the repair budget or mandatory context`,
      ).toBe(true);
    }

    expect(union, 'the generators never become mandatory').not.toMatch(
      /must (?:use|run|read)[^.]{0,100}(?:review packet|plan dispatch)/i,
    );
  });

  it('keeps the mandatory initial-review and bounded-recheck gate language', async () => {
    const coding = flatten(await read(CODING));
    const review = flatten(await read(REVIEW_REFERENCE));

    expect(coding, 'the coding skill still requires the review reference before dispatch').toMatch(
      /Before any planned review dispatch[^.]{0,200}references\/review\.md[^.]{0,200}(?:initial|recheck)/i,
    );
    expect(coding, 'the two review axes still run simultaneously').toMatch(
      /simultaneous[^.]{0,160}(?:full )?Spec Review and Standards Review[^.]{0,120}batch/i,
    );
    expect(coding, 'the bounded repair/recheck budget remains').toMatch(
      /at most two repair\/recheck cycles/i,
    );
    expect(review, 'the review reference is still mandatory before review').toMatch(
      /must read this reference[^.]{0,160}(?:initial review|recheck)/i,
    );
    expect(review, 'the reference keeps both axes on one immutable head').toMatch(
      /Both axes judge the same immutable final head/i,
    );
    expect(review, 'the reference keeps the bounded repair/recheck budget').toMatch(
      /at most two repair\/recheck cycles/i,
    );
  });
});
