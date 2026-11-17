import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Static delivered-content evidence for the execution observability rollout.
// These tests read shipped documentation and the delivered execution source as
// public artifacts; they assert durable phrases and structure, not whole files.

const README = ['README.md'];
const MEMORY = ['MEMORY.md'];
const CODING_SKILL = ['templates', 'skills', 'coding', 'SKILL.md'];
const WORKSPACE_REF = ['templates', 'skills', 'coding', 'references', 'workspace.md'];
const GIT_OPERATOR = ['templates', 'agents', 'git-operator.md'];
const PROJECT_CONTRACT = ['templates', 'project', 'AGENTS.md'];
const CONTRACT_MIRROR = ['.ai-workflow', 'AGENTS.md'];
const EXECUTION_MODULES = [
  'types', 'config', 'paths', 'validate', 'store', 'failure',
  'record', 'manager', 'report', 'commands', 'recovery', 'hook',
] as const;

async function readText(parts: readonly string[]): Promise<string> {
  return readFile(packagePath(...parts), 'utf8');
}

/** Whitespace-normalized so multi-word phrases survive source wrapping. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function expectFragments(text: string, fragments: readonly string[], label: string): void {
  for (const fragment of fragments) {
    expect(text, `${label} must contain "${fragment}"`).toContain(fragment);
  }
}

/** A bounded window around the first anchor match, so related rules co-occur. */
function windowAround(text: string, anchor: RegExp, span = 700): string {
  const match = anchor.exec(text);
  if (!match) return '';
  return text.slice(Math.max(0, match.index - 120), match.index + span);
}

const HAND_WRITE = /(?:hand[\s-]?write|writ\w*[^.]{0,30}by hand|manually (?:writ|creat|edit)\w*)/i;

describe('README execution command reference', () => {
  it('documents the full execution command group and the internal host transport', async () => {
    const readme = flat(await readText(README));
    const commands = [
      'execution start', 'execution task', 'execution complete', 'execution pause',
      'execution cancel', 'execution failure', 'execution resume', 'execution status',
      'execution show', 'execution events', 'execution history', 'execution analytics',
      'execution record --host opencode',
    ];
    expectFragments(readme, commands, 'the README execution command reference');
  });

  it('states exit-code rules and that query commands are read-only', async () => {
    const readme = flat(await readText(README));
    expect(readme, 'exit 0 is success or query').toMatch(/exit\s*0[^.]{0,90}(?:success|successful|quer(?:y|ies))/i);
    expect(readme, 'exit 1 is invalid input or manual refusal').toMatch(/exit\s*1[^.]{0,110}(?:invalid|manual|refus)/i);
    expect(readme, 'exit 2 is a retryable failure').toMatch(/exit\s*2[^.]{0,110}retryable/i);
    expect(readme, 'queries are read-only').toMatch(
      /(?:quer(?:y|ies)[^.]{0,130}(?:read-only|no (?:file |git )?(?:write|mutation))|(?:read-only)[^.]{0,130}quer(?:y|ies))/i,
    );
  });
});

describe('coding skill execution contract', () => {
  it('uses execution start and execution complete for the ordinary implementation record', async () => {
    const coding = flat(await readText(CODING_SKILL));
    expect(coding).toContain('ai-workflow execution start');
    expect(coding).toContain('execution complete');
    expect(coding).toMatch(/implementation\.yaml|implementation record/i);
  });

  it('requires Git Operator to call execution task after an ordinary split task commit', async () => {
    const coding = flat(await readText(CODING_SKILL));
    expect(coding).toContain('execution task');
    expect(coding).toMatch(/Git Operator/i);
    expect(coding).toMatch(/after[^.]{0,90}(?:task )?commit/i);
  });

  it('keeps implementation.yaml authoritative and telemetry a program-owned overlay', async () => {
    const coding = flat(await readText(CODING_SKILL));
    expect(coding).toMatch(/implementation\.yaml[^.]{0,180}authoritative|authoritative[^.]{0,180}implementation\.yaml/i);
    expect(coding).toMatch(/program-owned[^.]{0,90}(?:telemetry|overlay|execution)/i);
    expect(coding).toMatch(/\boverlay\b/i);
  });

  it('requires explicit resume and failure classification on exceptions', async () => {
    const coding = flat(await readText(CODING_SKILL));
    expect(coding).toMatch(/explicit[^.]{0,70}resume|resume[^.]{0,70}explicit/i);
    expect(coding).toMatch(/classif\w*[^.]{0,120}failure|failure[^.]{0,120}classif\w*/i);
    expect(coding).toMatch(/\bexception/i);
  });

  it('forbids hand-written run, event, checkpoint and lock files', async () => {
    const coding = flat(await readText(CODING_SKILL));
    const region = windowAround(coding, HAND_WRITE);
    expect(region, 'the coding skill states a hand-write prohibition').not.toBe('');
    for (const kind of ['run', 'event', 'checkpoint', 'lock']) {
      expect(region, `the hand-write rule names ${kind} files`).toMatch(new RegExp(`\\b${kind}s?\\b`, 'i'));
    }
  });
});

describe('workspace reference per-repository telemetry', () => {
  it('records one run per participating repository slice plus a distinct root run', async () => {
    const workspace = flat(await readText(WORKSPACE_REF));
    expect(workspace).toMatch(
      /one run per[^.]{0,150}(?:repositor|slice)|one run in each[^.]{0,120}repositor|each[^.]{0,120}repositor[^.]{0,80}one run/i,
    );
    expect(workspace).toMatch(/participating[^.]{0,90}repositor/i);
    expect(workspace).toMatch(/root[- ]owned[^.]{0,40}run|root run|separate[^.]{0,40}root[^.]{0,40}run/i);
  });

  it('keeps execution state in per-repository execution directories', async () => {
    const workspace = flat(await readText(WORKSPACE_REF));
    expect(workspace).toMatch(/execution\//);
    expect(workspace).toMatch(/(?:per|each)[- ]repository[^.]{0,140}execution[^.]{0,40}(?:director|file|state)|execution[^.]{0,60}(?:director|state)[^.]{0,100}(?:per|each)[- ]repository/i);
  });

  it('keeps telemetry additive and never changes checkpoint or delivery gates', async () => {
    const workspace = flat(await readText(WORKSPACE_REF));
    expect(workspace).toMatch(/\badditive\b/i);
    expect(workspace).toMatch(/never[^.]{0,160}(?:change|alter|affect)[^.]{0,110}(?:checkpoint|delivery)[^.]{0,40}gate/i);
  });
});

describe('Git Operator post-commit task recording', () => {
  it('records a completed ordinary split task after its commit via execution task', async () => {
    const operator = flat(await readText(GIT_OPERATOR));
    expect(operator).toContain('ai-workflow execution task');
    expect(operator).toMatch(/after[^.]{0,90}(?:task )?commit/i);
    expect(operator).toMatch(/ordinary[^.]{0,70}split|split[^.]{0,50}plan/i);
  });

  it('reports a recording failure without re-committing or retrying it', async () => {
    const operator = flat(await readText(GIT_OPERATOR));
    expect(operator).toMatch(/recording[^.]{0,50}fail|fail[^.]{0,50}record/i);
    expect(operator).toMatch(/report/i);
    expect(operator).toMatch(/never[^.]{0,90}(?:re-?commit|retry)|(?:not|no)[^.]{0,70}(?:re-?commit|retry)/i);
  });
});

describe('project contract program-owned telemetry boundary', () => {
  it('states a program-owned boundary that forbids hand-written execution files', async () => {
    const contract = flat(await readText(PROJECT_CONTRACT));
    expect(contract).toMatch(/program-owned[^.]{0,100}(?:telemetry|execution|overlay)/i);
    const region = windowAround(contract, /program-owned[^.]{0,100}(?:telemetry|execution|overlay)/i, 950);
    expect(region).toMatch(HAND_WRITE);
    for (const kind of ['run', 'event', 'checkpoint', 'lock']) {
      expect(region, `the contract hand-write rule names ${kind} files`).toMatch(new RegExp(`\\b${kind}s?\\b`, 'i'));
    }
  });

  it('scopes runs per repository slice and keeps implementation.yaml authoritative', async () => {
    const contract = flat(await readText(PROJECT_CONTRACT));
    expect(contract).toMatch(/per[- ]repository[^.]{0,90}(?:slice|run)|one run per[^.]{0,90}repositor/i);
    expect(contract).toMatch(/implementation\.yaml[^.]{0,160}authoritative|authoritative[^.]{0,160}implementation\.yaml/i);
  });

  it('treats a telemetry failure as a warning with no retry', async () => {
    const contract = flat(await readText(PROJECT_CONTRACT));
    expect(contract).toMatch(/telemetry[^.]{0,120}(?:fail|warn)|(?:fail|warn)[^.]{0,120}telemetry/i);
    expect(contract).toMatch(/warning/i);
    expect(contract).toMatch(/no[^.]{0,30}retry|never[^.]{0,40}retr(?:y|ies)|without[^.]{0,30}retr(?:y|ies)/i);
  });

  it('states no model, network or periodic behavior and read-only queries', async () => {
    const contract = flat(await readText(PROJECT_CONTRACT));
    expect(contract).toMatch(/no[^.]{0,90}model|never[^.]{0,90}(?:call(?:s)?[^.]{0,40}a? ?model|model[^.]{0,40}call)/i);
    expect(contract).toMatch(/no[^.]{0,90}(?:network|HTTP)|never[^.]{0,90}(?:network|HTTP)/i);
    expect(contract).toMatch(/no[^.]{0,90}periodic|never[^.]{0,90}periodic/i);
    expect(contract).toMatch(/quer(?:y|ies)[^.]{0,130}read-only|read-only[^.]{0,130}quer(?:y|ies)/i);
  });

  it('states the phase-entry unfinished-run notice is read-only and once per phase entry, with explicit resume', async () => {
    const contract = flat(await readText(PROJECT_CONTRACT));
    expect(contract).toMatch(/phase[- ]entry/i);
    expect(contract).toMatch(/unfinished run/i);
    expect(contract).toMatch(/read-only/i);
    expect(contract).toMatch(/once per phase entry/i);
    expect(contract).toMatch(/resume[^.]{0,80}explicit|explicit[^.]{0,80}resume/i);
  });

  it('keeps the tracked contract mirror byte-identical to its template', async () => {
    const template = await readFile(packagePath(...PROJECT_CONTRACT));
    const mirror = await readFile(packagePath(...CONTRACT_MIRROR));
    expect(mirror.equals(template), '.ai-workflow/AGENTS.md mirrors templates/project/AGENTS.md byte-for-byte').toBe(true);
  });
});

describe('MEMORY delivered execution standard', () => {
  it('records the command group, execution module location and authoritative boundary', async () => {
    const memory = flat(await readText(MEMORY));
    expectFragments(memory, ['execution start', 'execution status', 'execution resume'], 'MEMORY execution command group');
    expect(memory, 'MEMORY locates execution modules under the plan execution directory').toMatch(
      /\.ai-workflow\/plans\/[^/\s]+\/execution\//,
    );
    expect(memory).toMatch(/implementation\.yaml[^.]{0,180}authoritative|authoritative[^.]{0,180}implementation\.yaml/i);
  });

  it('records the cost guard and host capability limits', async () => {
    const memory = flat(await readText(MEMORY));
    expect(memory).toMatch(/cost guard|no[^.]{0,60}(?:model call|network call)/i);
    expect(memory).toMatch(/OpenCode/i);
    expect(memory).toMatch(/N\/A/);
  });
});

describe('README future note and navigation references', () => {
  it('references the future architecture note and navigation feature id without asserting their existence', async () => {
    const readme = await readText(README);
    expect(readme).toContain('.ai-workflow/notes/implemented/architecture/2026-11-17-execution-observability-resilience.md');
    expect(readme).toContain('execution-observability');
  });
});

describe('static cost and privacy guard over delivered execution source', () => {
  async function executionSources(): Promise<Array<{ name: string; text: string }>> {
    return Promise.all(EXECUTION_MODULES.map(async (name) => ({
      name: `src/execution/${name}.ts`,
      text: await readText(['src', 'execution', `${name}.ts`]),
    })));
  }

  it('uses no HTTP, fetch or network client and no model SDK in the execution modules', async () => {
    const forbidden = [
      /\bfetch\s*\(/i,
      /\bXMLHttpRequest\b|\bWebSocket\b/i,
      /\bhttps?\.(?:request|get|post)\s*\(/i,
      /\b(?:node:https?|undici|axios|node-fetch)\b/i,
      /\bcreateConnection\s*\(/i,
      /\bfrom\s+['"](?:openai|@openai|@anthropic-ai|langchain|@langchain)/i,
      /\b(?:generateText|streamText|createOpenAI|new\s+OpenAI)\s*\(/i,
    ];
    for (const { name, text } of await executionSources()) {
      for (const pattern of forbidden) {
        expect(text, `${name} must not use ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('adds no periodic timer loop in the execution modules', async () => {
    for (const { name, text } of await executionSources()) {
      expect(text, `${name} must not schedule a periodic timer`).not.toMatch(/\bsetInterval\s*\(/);
      expect(text, `${name} must not schedule a deferred loop`).not.toMatch(/\bsetTimeout\s*\(/);
    }
  });

  it('excludes prompt, reasoning and tool-call fields from event and failure payload construction', async () => {
    const forbiddenKeys = /\b(?:prompt|reasoning|tool_calls?|toolCalls?|tool_call)\s*:/i;
    for (const { name, text } of await executionSources()) {
      expect(text, `${name} payload construction excludes sensitive model fields`).not.toMatch(forbiddenKeys);
    }
  });

  it('states the structural guarantees and host capability limits in README and shipped prompts', async () => {
    const readme = flat(await readText(README));
    const coding = flat(await readText(CODING_SKILL));
    const contract = flat(await readText(PROJECT_CONTRACT));
    const docs = { readme, coding, contract };
    for (const [label, text] of Object.entries(docs)) {
      expect(text, `${label} states no model or network call in execution paths`).toMatch(
        /no[^.]{0,90}(?:model call|network call|model or network)|never[^.]{0,90}(?:call(?:s)?[^.]{0,40}model|open[^.]{0,40}network)/i,
      );
      expect(text, `${label} states no periodic scan`).toMatch(/no[^.]{0,80}periodic|never[^.]{0,80}periodic/i);
    }
    expect(readme, 'README states the OpenCode session-evidence capability').toMatch(/OpenCode[^.]{0,120}(?:session|invocation)/i);
    expect(readme, 'README states other hosts report N/A').toMatch(/N\/A/);
  });
});
