import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdown } from '../utils/frontmatter.js';
import { readPlan, readTasks } from './parse.js';
import type { PlanDocument, TaskDocument } from './types.js';

export interface PlanLintWarning {
  code: string;
  path: string;
  message: string;
}

export interface PlanLintResult {
  valid: true;
  plan_id: string;
  warnings: PlanLintWarning[];
}

/** A level-two Markdown section body, ending at the next level-two heading. */
function sectionBody(body: string, title: string): string | undefined {
  const heading = new RegExp(`^##\\s+${title}\\s*$`, 'm').exec(body);
  if (!heading) return undefined;
  const rest = body.slice((heading.index ?? 0) + heading[0].length);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Rows of the first Markdown table in a section, with the delimiter row removed. */
function tableRows(section: string | undefined): string[][] {
  if (section === undefined) return [];
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

/** Acceptance criteria headings and their bounded bodies. */
function acceptanceCriteriaBodies(body: string): { id: string; content: string }[] {
  const matches = [...body.matchAll(/^###?\s*(AC-\d+)\b[^\n]*$/gm)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]?.index ?? body.length : body.length;
    return { id: match[1] ?? '', content: body.slice(start, end) };
  });
}

function hasScenario(content: string): boolean {
  return /\bGiven\b/.test(content) && /\bWhen\b/.test(content) && /\bThen\b/.test(content);
}

function writeScopeTooWide(scope: string[]): boolean {
  if (scope.length > 5) return true;
  return scope.some((path) => scope.some((other) => other !== path && other.startsWith(`${path}/`)));
}

/**
 * Lint a frozen plan and its optional tasks, returning stable advisory warnings about
 * requirement and acceptance form. The result never authorizes a workflow phase and the
 * function writes no file.
 */
export async function lintPlan(directory: string): Promise<PlanLintResult> {
  let document: PlanDocument;
  let tasks: TaskDocument[];
  let specSource: string;
  let planSource: string;
  try {
    document = await readPlan(directory);
    tasks = await readTasks(directory);
    [specSource, planSource] = await Promise.all([
      readFile(join(directory, 'spec.md'), 'utf8'),
      readFile(join(directory, 'plan.md'), 'utf8'),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid frozen plan at ${directory}: ${message}`);
  }

  const specPath = join(directory, 'spec.md');
  const planPath = join(directory, 'plan.md');
  const specBody = parseMarkdown(specSource).body;
  const planBody = parseMarkdown(planSource).body;
  const warnings: PlanLintWarning[] = [];

  const coverage = tableRows(sectionBody(planBody, 'Requirement coverage'))
    .filter((cells) => /^REQ-\d+$/.test(cells[0] ?? ''))
    .map((cells) => ({ requirement: cells[0] ?? '', acceptance: (cells[1] ?? '').match(/AC-\d+/g) ?? [] }));
  for (const requirement of document.requirements) {
    if (!coverage.some((row) => row.requirement === requirement && row.acceptance.length > 0)) {
      warnings.push({
        code: 'requirement-without-acceptance-criterion',
        path: specPath,
        message: `${requirement} has no acceptance criterion in the requirement coverage table`,
      });
    }
  }

  for (const criterion of acceptanceCriteriaBodies(specBody)) {
    if (!hasScenario(criterion.content)) {
      warnings.push({
        code: 'acceptance-criterion-missing-given-when-then',
        path: specPath,
        message: `${criterion.id} does not state a Given/When/Then scenario`,
      });
    }
  }

  const nonGoals = sectionBody(specBody, 'Non-goals');
  if (nonGoals === undefined || nonGoals.trim().length === 0) {
    warnings.push({ code: 'missing-non-goals', path: specPath, message: 'spec.md has no non-goals content' });
  }

  if (!/^\s*[-*]\s+Boundary\b/m.test(specBody)) {
    warnings.push({ code: 'missing-boundary', path: specPath, message: 'spec.md states no boundary condition' });
  }
  if (!/^\s*[-*]\s+Counterexample\b/m.test(specBody)) {
    warnings.push({ code: 'missing-counterexample', path: specPath, message: 'spec.md states no counterexample' });
  }

  const verification = tableRows(sectionBody(specBody, 'Verification layers and RED criteria'))
    .flatMap((cells) => (cells[0] ?? '').match(/REQ-\d+/g) ?? []);
  for (const requirement of document.requirements) {
    if (!verification.includes(requirement)) {
      warnings.push({
        code: 'missing-verification-layer',
        path: specPath,
        message: `${requirement} has no row in the verification layers table`,
      });
    }
  }

  for (const task of tasks) {
    if (task.testCommands.length === 0) {
      warnings.push({ code: 'task-missing-test-command', path: task.path, message: `${task.id} declares no test command` });
    }
    if (writeScopeTooWide(task.writeScope)) {
      warnings.push({ code: 'task-write-scope-too-wide', path: task.path, message: `${task.id} writes to a wide or overlapping scope` });
    }
  }

  if (tasks.length >= 6 && tasks.every((task) => task.writeScope.length <= 1)) {
    warnings.push({
      code: 'task-over-split',
      path: planPath,
      message: `${tasks.length} tasks each touch at most one write path; the split looks finer than the work requires`,
    });
  }

  warnings.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return { valid: true, plan_id: document.planId, warnings };
}
