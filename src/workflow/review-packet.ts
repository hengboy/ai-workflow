import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { exists } from '../utils/fs.js';
import { packagePath } from '../utils/schema.js';

export type ReviewAxis = 'spec' | 'standards';
export type ReviewMode = 'initial' | 'recheck';
export type ReviewPurpose = 'delivery' | 'repository-local-finalization';

/** Inputs for one review packet; every value is supplied by the caller, never inferred. */
export interface ReviewPacketRequest {
  axis: ReviewAxis;
  mode: ReviewMode;
  purpose: ReviewPurpose;
  repository: string;
  contract: string;
  base: string;
  head: string;
  previousHead?: string;
  requirements?: string[];
  requirementScope?: string[];
  rawDiff?: string;
  repairDiff?: string;
  repairScope?: string[];
  sourceBlobs?: string[];
  committedTests?: string[];
  changedPaths?: string[];
  testReports?: string[];
  memory?: string;
  noteStandards?: string[];
  originalFindings?: string[];
  evidenceDir?: string;
}

export interface ReviewPacketResult { packet: string }

const referencePath = packagePath('templates/skills/coding/references/review.md');

function headingFor(axis: ReviewAxis, mode: ReviewMode): string {
  if (axis === 'spec') return mode === 'initial' ? 'Spec initial' : 'Spec recheck';
  return mode === 'initial' ? 'Standards initial' : 'Standards recheck';
}

/** Read the fenced packet body from the shipped review reference, preserving its line order. */
async function readTemplate(heading: string): Promise<string[]> {
  const reference = await readFile(referencePath, 'utf8');
  const headingIndex = reference.indexOf(`## ${heading}`);
  if (headingIndex < 0) throw new Error(`Review reference is missing the ${heading} packet`);
  const fenceStart = reference.indexOf('```text', headingIndex);
  if (fenceStart < 0) throw new Error(`Review reference is missing the ${heading} packet fence`);
  const bodyStart = reference.indexOf('\n', fenceStart) + 1;
  const bodyEnd = reference.indexOf('```', bodyStart);
  if (bodyEnd < 0) throw new Error(`Review reference is missing the ${heading} packet fence end`);
  return reference.slice(bodyStart, bodyEnd).replace(/\n$/, '').split('\n');
}

function assertChoice(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) throw new Error(`Invalid review ${label}: ${value}. Use ${allowed.join(' or ')}.`);
}

function requireText(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new Error(`Missing required field: ${label}`);
  return value;
}

function requireList(value: string[] | undefined, label: string): string[] {
  if (value === undefined || value.length === 0) throw new Error(`Missing required field: ${label}`);
  return value;
}

function requireSha(value: string, label: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`Invalid ${label} SHA: expected a full lowercase 40- or 64-character hexadecimal commit id, received "${value}"`);
  }
  return value;
}

function forbid(values: Array<[string, unknown]>, context: string): void {
  for (const [label, value] of values) {
    if (value !== undefined) throw new Error(`Option --${label} is not allowed for ${context}`);
  }
}

async function evidencePath(path: string, label: string, evidenceDir: string | undefined): Promise<string> {
  let absolute: string;
  if (isAbsolute(path)) absolute = path;
  else if (evidenceDir === undefined) throw new Error(`Relative evidence path requires --evidence-dir: ${path}`);
  else absolute = resolve(evidenceDir, path);
  if (!(await exists(absolute))) throw new Error(`Evidence file not found for ${label}: ${absolute}`);
  return absolute;
}

async function evidencePaths(paths: string[], label: string, evidenceDir: string | undefined): Promise<string[]> {
  return Promise.all(paths.map((path) => evidencePath(path, label, evidenceDir)));
}

/** Validate the supplied fields and resolve every evidence path to an existing absolute path. */
async function prepare(request: ReviewPacketRequest): Promise<Record<string, string | undefined>> {
  assertChoice(request.axis, ['spec', 'standards'], 'axis');
  assertChoice(request.mode, ['initial', 'recheck'], 'mode');
  assertChoice(request.purpose, ['delivery', 'repository-local-finalization'], 'purpose');

  const axis = request.axis;
  const mode = request.mode;
  const purpose = requireText(request.purpose, 'purpose');
  const repository = requireText(request.repository, 'repository');
  const contract = requireText(request.contract, 'contract');
  const base = requireSha(requireText(request.base, 'base'), 'base');
  const head = requireSha(requireText(request.head, 'head'), 'head');

  if (axis === 'spec') {
    forbid([
      ['memory', request.memory],
      ['note-standards', request.noteStandards],
      ['test-reports', request.testReports],
      ['original-findings', request.originalFindings],
      ['changed-paths', request.changedPaths],
    ], 'the spec axis');
  } else {
    forbid([
      ['requirements', request.requirements],
      ['requirement-scope', request.requirementScope],
      ['committed-tests', request.committedTests],
    ], 'the standards axis');
  }
  if (mode === 'initial') {
    forbid([
      ['previous-head', request.previousHead],
      ['repair-diff', request.repairDiff],
      ['repair-scope', request.repairScope],
      ['original-findings', request.originalFindings],
    ], 'the initial mode');
  }

  if (!isAbsolute(repository)) throw new Error(`Repository path must be absolute: ${repository}`);
  if (!isAbsolute(contract)) throw new Error(`Contract path must be absolute: ${contract}`);

  const values: Record<string, string | undefined> = {
    purpose,
    repository,
    contract,
    base_commit: base,
    head_commit: head,
  };

  if (axis === 'spec') {
    const requirements = requireList(request.requirements, 'requirements');
    const requirementScope = requireList(request.requirementScope, 'requirement_scope');
    const rawDiff = requireText(request.rawDiff, 'raw_diff');
    const sourceBlobs = requireList(request.sourceBlobs, 'source_blobs');
    const committedTests = requireList(request.committedTests, 'committed_tests');
    values.requirements = (await evidencePaths(requirements, 'requirements', request.evidenceDir)).join(', ');
    values.requirement_scope = requirementScope.join(', ');
    values.raw_diff = await evidencePath(rawDiff, 'raw_diff', request.evidenceDir);
    values.source_blobs = (await evidencePaths(sourceBlobs, 'source_blobs', request.evidenceDir)).join(', ');
    values.committed_tests = (await evidencePaths(committedTests, 'committed_tests', request.evidenceDir)).join(', ');
  } else {
    const memory = requireText(request.memory, 'memory');
    const noteStandards = requireList(request.noteStandards, 'note_standards');
    const changedPaths = requireList(request.changedPaths, 'changed_paths');
    const rawDiff = requireText(request.rawDiff, 'raw_diff');
    const sourceBlobs = requireList(request.sourceBlobs, 'source_blobs');
    const testReports = requireList(request.testReports, 'test_reports');
    values.memory = await evidencePath(memory, 'memory', request.evidenceDir);
    values.note_standards = (await evidencePaths(noteStandards, 'note_standards', request.evidenceDir)).join(', ');
    values.changed_paths = changedPaths.join(', ');
    values.raw_diff = await evidencePath(rawDiff, 'raw_diff', request.evidenceDir);
    values.source_blobs = (await evidencePaths(sourceBlobs, 'source_blobs', request.evidenceDir)).join(', ');
    values.test_reports = (await evidencePaths(testReports, 'test_reports', request.evidenceDir)).join(', ');
  }

  if (mode === 'recheck') {
    const previousHead = requireSha(requireText(request.previousHead, 'previous_head'), 'previous head');
    const repairDiff = requireText(request.repairDiff, 'repair_diff');
    const repairScope = requireList(request.repairScope, 'repair_scope');
    values.previous_head = previousHead;
    values.repair_diff = await evidencePath(repairDiff, 'repair_diff', request.evidenceDir);
    values.repair_scope = repairScope.join(', ');
    if (axis === 'standards') {
      const originalFindings = requireList(request.originalFindings, 'original_findings');
      values.original_findings = originalFindings.join('; ');
    }
  }

  return values;
}

/** Render one review packet from the supplied fields without deciding any review outcome. */
export async function renderReviewPacket(request: ReviewPacketRequest): Promise<ReviewPacketResult> {
  const values = await prepare(request);
  const lines = await readTemplate(headingFor(request.axis, request.mode));
  const packet = lines.map((line) => {
    const match = /^([a-z_]+): (<.*>)$/.exec(line);
    if (match === null) return line;
    const name = match[1];
    const value = name === undefined ? undefined : values[name];
    if (name === undefined || value === undefined) throw new Error(`Missing required field: ${name ?? line}`);
    return `${name}: ${value}`;
  }).join('\n');
  return { packet };
}
