import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const executable = '__AI_WORKFLOW_NODE__';
const cli = '__AI_WORKFLOW_CLI__';

async function adoptedRoot(directory) {
  let root = resolve(directory);
  while (true) {
    try { await stat(join(root, '.ai-workflow')); return root; } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}

function invokeHook(input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [cli, 'sync-hook', '--host', 'opencode'], { cwd: input.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ai-workflow sync-hook failed (${code}): ${stderr}`)); return; }
      try {
        const result = JSON.parse(stdout);
        if (!['allow', 'deny', 'skip'].includes(result.decision) || typeof result.project !== 'string' || typeof result.context !== 'string') throw new Error('Invalid ai-workflow gate result');
        resolveResult(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Exact bytes of a contract file, fingerprinted as the gate's `sha256:<hex>` reference. */
function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A notice is distinct when either its decision or its context differs from the last push. */
function noticeSignature(result) {
  return `${result.decision}\n${result.context}`;
}

export const AiWorkflowSyncPlugin = async ({ client }) => {
  const results = new Map();
  const directories = new Map();
  const authorityDigests = new Map();
  const starts = new Map();
  const notices = new Map();

  async function lookup(id) {
    const session = (await client.session.get({ path: { id } })).data;
    if (!session || typeof session.directory !== 'string' || !session.directory) throw new Error(`Cannot resolve the actual OpenCode session directory: ${id}`);
    return session;
  }

  async function synchronize(sessionID, event, toolName, toolInput) {
    const session = await lookup(sessionID);
    const root = await adoptedRoot(session.directory);
    let owner = session;
    while (root && owner.parentID) {
      const parent = await lookup(owner.parentID);
      if (await adoptedRoot(parent.directory) !== root) break;
      owner = parent;
    }
    const shared = owner.id !== session.id;
    const hookEvent = shared ? 'PreToolUse' : event === 'UserPromptSubmit' ? event : starts.has(sessionID) || !results.has(sessionID) ? 'SessionStart' : event;
    const result = await invokeHook({
      cwd: session.directory,
      session_id: owner.id,
      hook_event_name: hookEvent,
      ...(hookEvent === 'SessionStart' ? { source: starts.get(sessionID) ?? 'resume' } : {}),
      ...(toolName === undefined ? {} : { tool_name: toolName, tool_input: toolInput }),
    });
    const previous = results.get(sessionID);
    directories.set(sessionID, session.directory);
    if (result.exemption !== undefined) return result;
    results.set(sessionID, result);
    starts.delete(sessionID);
    if (result.decision === 'deny' || (result.report?.warnings.length && previous?.context !== result.context)) {
      await client.tui.showToast({ body: { title: 'ai-workflow synchronization', message: result.context, variant: result.decision === 'deny' ? 'error' : 'warning' } });
    }
    return result;
  }

  function rememberAuthority(sessionID, project, digest) {
    const roots = authorityDigests.get(sessionID) ?? new Map();
    roots.set(project, digest);
    authorityDigests.set(sessionID, roots);
  }

  function contractTarget(sessionID, args) {
    if (typeof args.filePath !== 'string') return undefined;
    const path = resolve(directories.get(sessionID), args.filePath);
    if (basename(path) !== 'AGENTS.md' || basename(dirname(path)) !== '.ai-workflow') return undefined;
    return { root: dirname(dirname(path)), path };
  }

  /** The read gate is satisfied only by the current on-disk bytes matching the stored reference. */
  async function authoritySatisfied(sessionID, project, reference) {
    const stored = authorityDigests.get(sessionID)?.get(project);
    if (stored === undefined || stored !== reference.digest) return false;
    try {
      return digestBytes(await readFile(reference.path)) === reference.digest;
    } catch {
      return false;
    }
  }

  function bindingFields(...sources) {
    const fields = {};
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      if (fields.parent_session_id === undefined && typeof source.parentID === 'string') fields.parent_session_id = source.parentID;
      if (fields.role === undefined && typeof source.role === 'string') fields.role = source.role;
      if (fields.model === undefined && typeof source.model === 'string') fields.model = source.model;
      if (fields.model === undefined && typeof source.model?.id === 'string') fields.model = source.model.id;
      if (fields.tokens === undefined && typeof source.tokens === 'number') fields.tokens = source.tokens;
      if (fields.cost === undefined && typeof source.cost === 'number') fields.cost = source.cost;
    }
    return fields;
  }

  // The recorder is spawned detached from the gate path: it never blocks the host and every
  // spawn, stream or exit problem is swallowed so recording cannot break a session.
  async function recordSession(type, sessionID, extra = {}) {
    if (typeof sessionID !== 'string' || !sessionID) return;
    let cwd = directories.get(sessionID);
    if (!cwd) {
      try { cwd = (await lookup(sessionID)).directory; } catch { return; }
    }
    directories.set(sessionID, cwd);
    const child = spawn(executable, [cli, 'execution', 'record', '--host', 'opencode'], { cwd });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ event: type, cwd, session_id: sessionID, ...extra }));
  }

  return {
    event: async ({ event }) => {
      if (event.type === 'server.connected') {
        results.clear();
        directories.clear();
        authorityDigests.clear();
        starts.clear();
        notices.clear();
        return;
      }
      const id = event.properties.info?.id ?? event.properties.sessionID;
      if (event.type === 'session.deleted') {
        void recordSession('session.deleted', id).catch(() => {});
        results.delete(id);
        directories.delete(id);
        authorityDigests.delete(id);
        starts.delete(id);
        notices.delete(id);
      } else if (event.type === 'session.created' || event.type === 'session.compacted' || (event.type === 'session.updated' && !results.has(id))) {
        starts.set(id, event.type === 'session.created' ? 'startup' : event.type === 'session.compacted' ? 'compact' : 'resume');
        authorityDigests.delete(id);
        notices.delete(id);
        if (event.type === 'session.created') void recordSession('session.created', id, bindingFields(event.properties.info)).catch(() => {});
      } else if (event.type === 'session.error') {
        void recordSession('session.error', id).catch(() => {});
      }
    },
    'chat.message': async (input) => {
      await synchronize(input.sessionID, 'UserPromptSubmit');
    },
    'experimental.chat.system.transform': async (input, output) => {
      if (!input.sessionID) return;
      const result = await synchronize(input.sessionID, 'PreToolUse');
      if (result.exemption !== undefined) return;
      const signature = noticeSignature(result);
      if (notices.get(input.sessionID) !== signature) {
        output.system.push(result.context);
        notices.set(input.sessionID, signature);
      }
    },
    'tool.execute.before': async (input, output) => {
      const result = await synchronize(input.sessionID, 'PreToolUse', input.tool, output.args);
      if (result.decision === 'deny') throw new Error(result.context);
      const reference = result.authority_ref;
      if (reference === undefined || result.exemption !== undefined) return;
      if (await authoritySatisfied(input.sessionID, result.project, reference)) return;
      throw new Error(`${result.context}\nRead ${reference.path} before ordinary project work continues.`);
    },
    'tool.execute.after': async (input) => {
      if (input.tool !== 'read') return;
      if (input.status !== undefined && input.status !== 'completed') return;
      const session = await lookup(input.sessionID);
      directories.set(input.sessionID, session.directory);
      const target = contractTarget(input.sessionID, input.args);
      if (target === undefined) return;
      const bytes = await readFile(target.path).catch(() => undefined);
      if (bytes !== undefined) rememberAuthority(input.sessionID, target.root, digestBytes(bytes));
    },
  };
};
