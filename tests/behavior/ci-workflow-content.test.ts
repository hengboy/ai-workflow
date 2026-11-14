import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { packagePath } from '../../src/utils/schema.js';

// Shipped-content evidence for the repository CI workflow (REQ-005 / AC-008).
// These assertions read the delivered workflow file; runtime CI execution is a live gap.

const WORKFLOW = '.github/workflows/ci.yml';

interface WorkflowStep {
  uses?: string;
  run?: string;
  if?: unknown;
}
interface WorkflowJob {
  permissions?: unknown;
  steps?: WorkflowStep[];
}
interface WorkflowDocument {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, WorkflowJob>;
}

async function readWorkflow(): Promise<string> {
  try {
    return await readFile(packagePath(WORKFLOW), 'utf8');
  } catch {
    throw new Error(`Missing GitHub Actions workflow at ${WORKFLOW}`);
  }
}

async function loadWorkflow(): Promise<{ text: string; document: WorkflowDocument; steps: WorkflowStep[] }> {
  const text = await readWorkflow();
  const document = parse(text) as WorkflowDocument;
  const steps = Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? []);
  return { text, document, steps };
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function triggerEvents(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((event): event is string => typeof event === 'string');
  if (on !== null && typeof on === 'object') return Object.keys(on);
  return [];
}

/** Every shell body plus step condition and action reference, in job order. */
function stepText(steps: WorkflowStep[]): string {
  return steps
    .map((step) => [step.run ?? '', typeof step.if === 'string' ? step.if : '', step.uses ?? ''].join('\n'))
    .join('\n');
}

describe('GitHub Actions CI workflow content (REQ-005 / AC-008)', () => {
  it('runs on both push and pull request in a defined job', async () => {
    const { document } = await loadWorkflow();
    expect(triggerEvents(document.on), 'the workflow declares push and pull_request triggers').toEqual(
      expect.arrayContaining(['push', 'pull_request']),
    );
    expect(Object.keys(document.jobs ?? {}).length, 'the workflow defines at least one job').toBeGreaterThan(0);
  });

  it('uses Node 22 and pnpm with a frozen-lockfile install', async () => {
    const { text } = await loadWorkflow();
    const flat = flatten(text);
    expect(flat, 'setup-node is used').toMatch(/actions\/setup-node@v\d+/);
    expect(flat, 'the configured Node version is 22').toMatch(/node-version:\s*['"]?22(?:\.(?:x|\d+))?['"]?/);
    expect(flat, 'pnpm setup is used').toMatch(/pnpm\/action-setup@v\d+/);
    expect(flat, 'dependencies install with pnpm').toMatch(/\bpnpm install\b/);
    expect(flat, 'the install is frozen to the lockfile').toMatch(/--frozen-lockfile/);
  });

  it('runs pnpm check', async () => {
    const { steps } = await loadWorkflow();
    expect(stepText(steps), 'the workflow runs pnpm check, not only a narrower check script').toMatch(/\bpnpm check(?!:)/);
  });

  it('derives the event base SHA and conditionally runs note validation with a visible skip', async () => {
    const { text, steps } = await loadWorkflow();
    const flat = flatten(text);
    const runs = stepText(steps);

    expect(flat, 'the pull-request base SHA is read').toContain('github.event.pull_request.base.sha');
    expect(flat, 'the push before SHA is read').toContain('github.event.before');
    expect(runs, 'the existing note validation command receives the computed base').toMatch(
      /pnpm exec tsx src\/cli\.ts notes validate --project \. --base\s+"?\$\{?[A-Za-z_]/,
    );
    expect(flat, 'the command is guarded against an empty base').toMatch(
      /(?:-n|-z)\s+["']?\$\{?(?:BASE|env\.BASE)\b|(?:BASE|env\.BASE)["']?\s*(?:=|!=)\s*["']{2}/,
    );
    expect(flat, 'the command is guarded against an all-zero base').toMatch(
      /\^0\+\$|\^0\{40\}\$|0\{40\}|0{7,}|\$\{BASE\/\/0\}/,
    );
    expect(flat, 'an absent or zero base prints a visible skip').toMatch(
      /(?:echo|printf)[^.]{0,240}\b(?:skip|skipping|skipped)\b|(?:skip|skipping|skipped)[^.]{0,240}(?:note|base)/i,
    );
  });

  it('regenerates types and fails on tracked src/generated drift', async () => {
    const { steps } = await loadWorkflow();
    const runs = stepText(steps);
    expect(runs, 'types are regenerated before the drift check').toMatch(
      /pnpm types:generate[\s\S]*git diff --exit-code(?:\s+--)?\s+src\/generated/,
    );
  });

  it('requires no secret, host login, elevated permission, release or remote write', async () => {
    const { text, document, steps } = await loadWorkflow();
    const flat = flatten(text);
    const uses = steps.map((step) => step.uses ?? '').join('\n');

    expect(flat, 'the workflow reads no repository secret').not.toMatch(/\bsecrets\s*\./i);
    expect(uses, 'no action performs login, credential, publish, release or deploy work').not.toMatch(
      /login|auth|credential|publish|release|deploy/i,
    );
    expect(flat, 'no command performs a remote write or release').not.toMatch(
      /\bgit push\b|\bgh release\b|\bnpm publish\b|\bpnpm publish\b|\bdocker push\b/i,
    );
    expect(flat, 'no host login is required').not.toMatch(
      /\b(?:codex|claude|opencode)\b[^.]{0,80}\blogin\b/i,
    );

    const permissions = [
      document.permissions,
      ...Object.values(document.jobs ?? {}).map((job) => job.permissions),
    ].filter((permission) => permission !== undefined);
    for (const permission of permissions) {
      expect(permission, 'declared permissions grant at most read access to repository contents').toEqual({
        contents: 'read',
      });
    }
  });
});
