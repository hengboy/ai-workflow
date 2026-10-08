import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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

export const AiWorkflowSyncPlugin = async ({ client }) => {
  const results = new Map();
  const directories = new Map();
  const loadedAuthority = new Map();
  const starts = new Map();

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

  function readsAuthority(sessionID, tool, args, result) {
    return tool === 'read' && typeof args.filePath === 'string'
      && resolve(directories.get(sessionID), args.filePath) === join(result.project, '.ai-workflow/AGENTS.md');
  }

  return {
    event: async ({ event }) => {
      if (event.type === 'server.connected') {
        results.clear();
        directories.clear();
        loadedAuthority.clear();
        starts.clear();
        return;
      }
      const id = event.properties.info?.id ?? event.properties.sessionID;
      if (event.type === 'session.deleted') {
        results.delete(id);
        directories.delete(id);
        loadedAuthority.delete(id);
        starts.delete(id);
      } else if (event.type === 'session.created' || event.type === 'session.compacted' || (event.type === 'session.updated' && !results.has(id))) {
        starts.set(id, event.type === 'session.created' ? 'startup' : event.type === 'session.compacted' ? 'compact' : 'resume');
        loadedAuthority.delete(id);
      }
    },
    'chat.message': async (input) => {
      loadedAuthority.delete(input.sessionID);
      await synchronize(input.sessionID, 'UserPromptSubmit');
    },
    'experimental.chat.system.transform': async (input, output) => {
      if (!input.sessionID) return;
      const result = await synchronize(input.sessionID, 'PreToolUse');
      output.system.push(result.context);
      if (result.authority !== undefined) loadedAuthority.set(input.sessionID, { project: result.project, authority: result.authority });
    },
    'tool.execute.before': async (input, output) => {
      const result = await synchronize(input.sessionID, 'PreToolUse', input.tool, output.args);
      if (result.decision === 'deny') throw new Error(result.context);
      const loaded = loadedAuthority.get(input.sessionID);
      if (result.authority !== undefined && (loaded?.project !== result.project || loaded?.authority !== result.authority) && !readsAuthority(input.sessionID, input.tool, output.args, result)) {
        throw new Error(`${result.context}\nRead ${join(result.project, '.ai-workflow/AGENTS.md')} before ordinary project work continues.`);
      }
    },
    'tool.execute.after': async (input) => {
      const result = results.get(input.sessionID);
      if (result?.authority === undefined || input.tool !== 'read') return;
      const session = await lookup(input.sessionID);
      directories.set(input.sessionID, session.directory);
      if (readsAuthority(input.sessionID, input.tool, input.args, result)
        && await readFile(join(result.project, '.ai-workflow/AGENTS.md'), 'utf8') === result.authority
        && results.get(input.sessionID) === result) loadedAuthority.set(input.sessionID, { project: result.project, authority: result.authority });
    },
  };
};
