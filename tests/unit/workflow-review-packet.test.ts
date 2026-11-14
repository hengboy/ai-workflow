import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { packagePath } from '../../src/utils/schema.js';
import { renderReviewPacket, type ReviewPacketRequest } from '../../src/workflow/review-packet.js';
import { temporary } from '../helpers.js';

// Behavior boundary: `renderReviewPacket` assembles one of the four review packets from
// `templates/skills/coding/references/review.md`. Observable = returned packet text and the
// refusal reason for invalid input. The CLI is the public boundary covered by the integration
// test; this file exercises the typed request/result directly.

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const PREVIOUS = 'c'.repeat(40);

const SPEC_INITIAL = ['role', 'mode', 'purpose', 'repository', 'contract', 'requirements', 'requirement_scope', 'base_commit', 'head_commit', 'raw_diff', 'source_blobs', 'committed_tests', 'instruction'];
const SPEC_RECHECK = ['role', 'mode', 'purpose', 'repository', 'contract', 'requirements', 'requirement_scope', 'base_commit', 'previous_head', 'head_commit', 'raw_diff', 'repair_diff', 'repair_scope', 'source_blobs', 'committed_tests', 'instruction'];
const STANDARDS_INITIAL = ['role', 'mode', 'purpose', 'repository', 'contract', 'memory', 'note_standards', 'base_commit', 'head_commit', 'changed_paths', 'raw_diff', 'source_blobs', 'test_reports', 'instruction'];
const STANDARDS_RECHECK = ['role', 'mode', 'purpose', 'repository', 'contract', 'memory', 'note_standards', 'base_commit', 'previous_head', 'head_commit', 'original_findings', 'raw_diff', 'repair_diff', 'repair_scope', 'source_blobs', 'test_reports', 'instruction'];

interface EvidenceFixture {
  root: string;
  repository: string;
  contract: string;
  memory: string;
  noteStandards: string[];
  requirements: string[];
  rawDiff: string;
  repairDiff: string;
  sourceBlobs: string[];
  committedTests: string[];
  changedPaths: string[];
  testReports: string[];
  repairScope: string[];
}

async function evidenceFixture(): Promise<EvidenceFixture> {
  const root = await temporary('ai-workflow-review-packet-');
  const repository = join(root, 'repository');
  const files: Record<string, string> = {
    '.ai-workflow/AGENTS.md': '# contract\n',
    'MEMORY.md': '# memory\n',
    'references/note-standards.md': '# note standards\n',
    'requirements/spec.md': '# specification\n',
    'evidence/raw.diff': 'diff --git a/one b/one\n',
    'evidence/repair.diff': 'diff --git a/two b/two\n',
    'evidence/report.txt': 'command: pnpm test; exit: 0\n',
    'repository/src/cli.ts': 'export const cli = true;\n',
    'repository/tests/review.test.ts': 'export const test = true;\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return {
    root,
    repository,
    contract: join(root, '.ai-workflow/AGENTS.md'),
    memory: join(root, 'MEMORY.md'),
    noteStandards: [join(root, 'references/note-standards.md')],
    requirements: [join(root, 'requirements/spec.md')],
    rawDiff: join(root, 'evidence/raw.diff'),
    repairDiff: join(root, 'evidence/repair.diff'),
    sourceBlobs: [join(repository, 'src/cli.ts')],
    committedTests: [join(repository, 'tests/review.test.ts')],
    changedPaths: ['src/cli.ts', 'tests/review.test.ts'],
    testReports: [join(root, 'evidence/report.txt')],
    repairScope: ['src/cli.ts'],
  };
}

function specInitial(fixture: EvidenceFixture, overrides: Partial<ReviewPacketRequest> = {}): ReviewPacketRequest {
  return {
    axis: 'spec',
    mode: 'initial',
    purpose: 'delivery',
    repository: fixture.repository,
    contract: fixture.contract,
    base: BASE,
    head: HEAD,
    requirements: fixture.requirements,
    requirementScope: ['REQ-005', 'AC-006'],
    rawDiff: fixture.rawDiff,
    sourceBlobs: fixture.sourceBlobs,
    committedTests: fixture.committedTests,
    ...overrides,
  };
}

function specRecheck(fixture: EvidenceFixture, overrides: Partial<ReviewPacketRequest> = {}): ReviewPacketRequest {
  return specInitial(fixture, {
    mode: 'recheck',
    previousHead: PREVIOUS,
    repairDiff: fixture.repairDiff,
    repairScope: fixture.repairScope,
    ...overrides,
  });
}

function standardsInitial(fixture: EvidenceFixture, overrides: Partial<ReviewPacketRequest> = {}): ReviewPacketRequest {
  return {
    axis: 'standards',
    mode: 'initial',
    purpose: 'delivery',
    repository: fixture.repository,
    contract: fixture.contract,
    memory: fixture.memory,
    noteStandards: fixture.noteStandards,
    base: BASE,
    head: HEAD,
    changedPaths: fixture.changedPaths,
    rawDiff: fixture.rawDiff,
    sourceBlobs: fixture.sourceBlobs,
    testReports: fixture.testReports,
    ...overrides,
  };
}

function standardsRecheck(fixture: EvidenceFixture, overrides: Partial<ReviewPacketRequest> = {}): ReviewPacketRequest {
  return standardsInitial(fixture, {
    mode: 'recheck',
    previousHead: PREVIOUS,
    originalFindings: ['logic: first finding'],
    repairDiff: fixture.repairDiff,
    repairScope: fixture.repairScope,
    ...overrides,
  });
}

function fieldNames(packet: string): string[] {
  return packet.split('\n').flatMap((line) => {
    const match = /^([a-z_]+): /.exec(line);
    return match ? [match[1] as string] : [];
  });
}

function field(packet: string, name: string): string {
  const line = packet.split('\n').find((entry) => entry.startsWith(`${name}: `));
  expect(line, `packet field ${name} is present`).toBeDefined();
  return (line as string).slice(name.length + 2);
}

async function templateInstruction(heading: string): Promise<string> {
  const reference = await readFile(packagePath('templates/skills/coding/references/review.md'), 'utf8');
  const start = reference.indexOf(`## ${heading}`);
  const fenceStart = reference.indexOf('```text', start);
  const bodyStart = reference.indexOf('\n', fenceStart) + 1;
  const bodyEnd = reference.indexOf('```', bodyStart);
  const body = reference.slice(bodyStart, bodyEnd);
  const line = body.split('\n').find((entry) => entry.startsWith('instruction: '));
  return line ? line.slice('instruction: '.length) : '';
}

const CASES: Array<{
  name: string;
  expected: string[];
  template: string;
  request: (fixture: EvidenceFixture) => ReviewPacketRequest;
}> = [
  { name: 'Spec initial', expected: SPEC_INITIAL, template: 'Spec initial', request: specInitial },
  { name: 'Spec recheck', expected: SPEC_RECHECK, template: 'Spec recheck', request: specRecheck },
  { name: 'Standards initial', expected: STANDARDS_INITIAL, template: 'Standards initial', request: standardsInitial },
  { name: 'Standards recheck', expected: STANDARDS_RECHECK, template: 'Standards recheck', request: standardsRecheck },
];

describe('renderReviewPacket', () => {
  it.each(CASES)('renders the $name template fields in exact order with the preserved instruction line', async ({ expected, template, request }) => {
    const fixture = await evidenceFixture();
    const { packet } = await renderReviewPacket(request(fixture));

    expect(fieldNames(packet)).toEqual(expected);
    expect(field(packet, 'instruction')).toBe(await templateInstruction(template));
  });

  it('substitutes the supplied values and leaves no unreplaced placeholder', async () => {
    const fixture = await evidenceFixture();
    const { packet } = await renderReviewPacket(specInitial(fixture));

    expect(field(packet, 'role')).toBe('spec-review');
    expect(field(packet, 'mode')).toBe('initial');
    expect(field(packet, 'purpose')).toBe('delivery');
    expect(field(packet, 'repository')).toBe(fixture.repository);
    expect(field(packet, 'contract')).toBe(fixture.contract);
    expect(field(packet, 'base_commit')).toBe(BASE);
    expect(field(packet, 'head_commit')).toBe(HEAD);
    expect(field(packet, 'raw_diff')).toBe(fixture.rawDiff);
    expect(packet).toContain(fixture.requirements[0] as string);
    expect(packet).toContain('REQ-005');
    expect(packet).toContain(fixture.sourceBlobs[0] as string);
    expect(packet).toContain(fixture.committedTests[0] as string);
    expect(packet).not.toMatch(/<[^>]+>/);
  });

  it('renders a Standards packet with its own standards fields and no Spec-only fields', async () => {
    const fixture = await evidenceFixture();
    const { packet } = await renderReviewPacket(standardsInitial(fixture));

    expect(field(packet, 'role')).toBe('standards-review');
    expect(field(packet, 'memory')).toBe(fixture.memory);
    expect(packet).toContain(fixture.noteStandards[0] as string);
    expect(packet).toContain('src/cli.ts');
    expect(packet).toContain(fixture.testReports[0] as string);
    expect(fieldNames(packet)).not.toContain('requirements');
    expect(fieldNames(packet)).not.toContain('requirement_scope');
    expect(fieldNames(packet)).not.toContain('committed_tests');
  });

  it('includes previous_head, repair_diff and repair_scope only for a recheck', async () => {
    const fixture = await evidenceFixture();
    const initial = await renderReviewPacket(specInitial(fixture));
    const recheck = await renderReviewPacket(specRecheck(fixture));

    expect(fieldNames(initial.packet)).not.toContain('previous_head');
    expect(fieldNames(initial.packet)).not.toContain('repair_diff');
    expect(fieldNames(initial.packet)).not.toContain('repair_scope');

    expect(field(recheck.packet, 'previous_head')).toBe(PREVIOUS);
    expect(field(recheck.packet, 'repair_diff')).toBe(fixture.repairDiff);
    expect(recheck.packet).toContain('src/cli.ts');
  });

  it('keeps a Spec packet free of plan, task, MEMORY and implementation narrative content', async () => {
    const fixture = await evidenceFixture();
    const { packet } = await renderReviewPacket(specRecheck(fixture));

    expect(packet).not.toMatch(/\bplan\b/i);
    expect(packet).not.toMatch(/\btasks?\b/i);
    expect(packet).not.toMatch(/\bMEMORY\b/);
    expect(packet).not.toMatch(/implementation narrative/i);
  });

  it('accepts a full 64-hex SHA', async () => {
    const fixture = await evidenceFixture();
    const base = 'd'.repeat(64);
    const head = 'e'.repeat(64);
    const { packet } = await renderReviewPacket(specInitial(fixture, { base, head }));

    expect(field(packet, 'base_commit')).toBe(base);
    expect(field(packet, 'head_commit')).toBe(head);
  });

  it('rejects a short base SHA', async () => {
    const fixture = await evidenceFixture();
    await expect(renderReviewPacket(specInitial(fixture, { base: 'abc1234' }))).rejects.toThrow(/base|sha|hex/i);
  });

  it('rejects a non-hex head SHA', async () => {
    const fixture = await evidenceFixture();
    await expect(renderReviewPacket(specInitial(fixture, { head: 'z'.repeat(40) }))).rejects.toThrow(/head|sha|hex/i);
  });

  it('rejects a recheck without previousHead', async () => {
    const fixture = await evidenceFixture();
    const request = specRecheck(fixture);
    delete request.previousHead;
    await expect(renderReviewPacket(request)).rejects.toThrow(/previous/i);
  });

  it('rejects a relative repository path', async () => {
    const fixture = await evidenceFixture();
    await expect(renderReviewPacket(specInitial(fixture, { repository: 'repository' }))).rejects.toThrow(/repository|absolute/i);
  });

  it('rejects a relative evidence path without an evidence directory', async () => {
    const fixture = await evidenceFixture();
    await expect(renderReviewPacket(specInitial(fixture, { rawDiff: 'evidence/raw.diff' }))).rejects.toThrow(/evidence|absolute|relative/i);
  });

  it('rejects a missing evidence file', async () => {
    const fixture = await evidenceFixture();
    await expect(renderReviewPacket(specInitial(fixture, { rawDiff: join(fixture.root, 'evidence/missing.diff') }))).rejects.toThrow(/missing|not found|exist|raw/i);
  });
});
