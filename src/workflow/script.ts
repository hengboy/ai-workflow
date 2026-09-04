import { lstat, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import ts from 'typescript';
import type { CodingWorkflowMeta } from '../generated/workflow-script-meta.schema.js';
import { sha256, stableJson } from '../utils/hash.js';

export interface ScriptSnapshotOptions {
  projectDirectory: string;
  planDirectory: string;
  planId: string;
  actionIds: string[];
}

export interface ScriptBytesSnapshot {
  path: string;
  bytes: Buffer;
  bytes_digest: string;
  meta_digest: string;
  language: 'javascript';
}

export interface ArgsBytesSnapshot {
  path: 'workflow.args.json';
  bytes: Buffer;
  bytes_digest: string;
}

export interface WorkflowScriptSnapshot {
  script: ScriptBytesSnapshot;
  args: ArgsBytesSnapshot;
  meta: CodingWorkflowMeta;
  calls: ScriptCall[];
}

export type ScriptCall =
  | { kind: 'action'; actionId: string; callId: string }
  | { kind: 'pipeline'; actionId: string; callId: string; itemKeys: string[] };

const forbiddenIdentifiers = new Set([
  'process', 'Buffer', 'require', 'eval', 'Function', 'WebAssembly', 'Date', 'globalThis', 'fetch',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
  'XMLHttpRequest', 'WebSocket', 'net', 'http', 'https', 'fs', 'child_process', 'worker_threads',
]);
const allowedFreeIdentifiers = new Set([
  'agent', 'parallel', 'pipeline', 'phase', 'log', 'finalizeTask', 'skipAction', 'skipTask', 'args', 'undefined',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'JSON', 'Math',
]);

function pathInsideProject(projectDirectory: string, planDirectory: string): string {
  const relativePath = relative(resolve(projectDirectory), resolve(planDirectory)).split(sep).join('/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || relativePath.includes('/../')) throw new Error('Plan-local files must remain inside the project');
  if (!/^\.ai-workflow\/plans\/[^/]+$/.test(relativePath)) throw new Error(`Plan directory must be canonical: ${relativePath}`);
  return relativePath;
}

async function readPlanLocalFile(path: string): Promise<Buffer | undefined> {
  let stats;
  try { stats = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new Error(`Plan-local file must not be a symlink: ${path}`);
  if (!stats.isFile()) throw new Error(`Plan-local file must be a regular file: ${path}`);
  const bytes = await readFile(path);
  const decoded = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new Error(`Plan-local file must be UTF-8: ${path}`);
  return bytes;
}

async function planPath(projectDirectory: string, planDirectory: string): Promise<string> {
  const projectPath = await realpath(resolve(projectDirectory));
  const planPath = resolve(planDirectory);
  const planStats = await lstat(planPath);
  if (planStats.isSymbolicLink()) throw new Error(`Plan directory must not be a symlink: ${planPath}`);
  if (!planStats.isDirectory()) throw new Error(`Plan directory must be a directory: ${planPath}`);
  const realPlanPath = await realpath(planPath);
  pathInsideProject(projectPath, realPlanPath);
  return realPlanPath;
}

function stringLiteral(node: ts.Node | undefined, label: string): string {
  if (!node || !ts.isStringLiteral(node) || !node.text) throw new Error(`Script ${label} must be a non-empty string literal`);
  return node.text;
}

function parseArray(node: ts.Node | undefined): string[] {
  if (!node || !ts.isArrayLiteralExpression(node)) throw new Error('Script pipeline itemKeys must be an explicit array');
  const itemKeys = node.elements.map((item) => stringLiteral(item, 'pipeline item key'));
  if (new Set(itemKeys).size !== itemKeys.length) throw new Error('Script pipeline item keys must be unique');
  return itemKeys;
}

function parseScript(source: string, actionIds: string[]): ScriptCall[] {
  const file = ts.createSourceFile('workflow.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length) throw new Error(`Script parse error: ${ts.flattenDiagnosticMessageText(diagnostics[0]?.messageText ?? 'invalid JavaScript', '\n')}`);
  const allowedActions = new Set(actionIds);
  if (allowedActions.size !== actionIds.length) throw new Error('Manifest action IDs must be unique');
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) throw new Error('Script policy forbids import/export');
  }
  const calls: ScriptCall[] = [];
  const callIds = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node) || ts.isNamespaceExport(node)) throw new Error('Script policy forbids import/export');
    if (ts.isIdentifier(node) && !allowedFreeIdentifiers.has(node.text)) {
      const parent = node.parent;
      const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAccessExpression(parent) && parent.expression === node && node.text === 'workflow')
        || (ts.isPropertyAssignment(parent) && parent.name === node);
      const declarationName = ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent);
      if (!propertyName && !declarationName && !allowedFreeIdentifiers.has(node.text)) {
        if (forbiddenIdentifiers.has(node.text)) throw new Error(`Script policy forbids ${node.text}`);
        throw new Error(`Script policy forbids free identifier ${node.text}`);
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) throw new Error('Script policy forbids namespace calls');
      if (!ts.isIdentifier(node.expression)) throw new Error('Script policy permits only plain JavaScript hooks');
      const method = node.expression.text;
      if (['agent', 'parallel', 'pipeline', 'phase', 'log', 'finalizeTask', 'skipAction', 'skipTask'].includes(method)) {
        if (method === 'agent') {
          if (node.arguments.length !== 2) throw new Error('Script agent requires prompt and options');
          const options = node.arguments[1];
          if (!options || !ts.isObjectLiteralExpression(options)) throw new Error('Script agent options must be an object literal');
          const actionId = stringLiteral(options.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'actionId') && (options.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'actionId') as ts.PropertyAssignment).initializer, 'action ID');
          const callId = stringLiteral(options.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'callId') && (options.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'callId') as ts.PropertyAssignment).initializer, 'call ID');
          if (!allowedActions.has(actionId)) throw new Error(`Script references unknown action ${actionId}`);
          if (callIds.has(callId)) throw new Error(`Script call ID is duplicated: ${callId}`);
          callIds.add(callId);
          calls.push({ kind: 'action', actionId, callId });
        } else if (method === 'pipeline') {
          const config = node.arguments[1];
          if (!config || !ts.isObjectLiteralExpression(config)) throw new Error('Script pipeline requires an itemKeys object');
          const itemKeysProperty = config.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'itemKeys');
          const itemKeys = parseArray(itemKeysProperty && ts.isPropertyAssignment(itemKeysProperty) ? itemKeysProperty.initializer : undefined);
          if (itemKeys.length === 0) throw new Error('Script pipeline itemKeys must not be empty');
          calls.push({ kind: 'pipeline', actionId: 'pipeline', callId: `pipeline/${calls.length + 1}`, itemKeys });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

function defaultScript(actionIds: string[]): Buffer {
  return Buffer.from(`${actionIds.map((actionId, index) => `await agent(${JSON.stringify(`Execute ${actionId}`)}, { actionId: ${JSON.stringify(actionId)}, callId: ${JSON.stringify(`action/${String(index + 1).padStart(4, '0')}/${actionId}`)} });`).join('\n')}\n`, 'utf8');
}

function defaultMeta(planId: string): CodingWorkflowMeta {
  return { name: `Coding workflow ${planId}`, description: `Deterministic workflow for ${planId}` };
}

function parseMeta(bytes: Buffer | undefined, planId: string): { value: CodingWorkflowMeta; digest: string } {
  if (!bytes) {
    const value = defaultMeta(planId);
    return { value, digest: sha256(stableJson(value)) };
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('workflow.meta.json must contain valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { name?: unknown }).name !== 'string' || typeof (value as { description?: unknown }).description !== 'string') throw new Error('workflow.meta.json must declare name and description');
  return { value: value as CodingWorkflowMeta, digest: sha256(bytes) };
}

async function argsSnapshot(planDirectory: string): Promise<ArgsBytesSnapshot> {
  const path = resolve(planDirectory, 'workflow.args.json');
  const raw = await readPlanLocalFile(path);
  const bytes = raw ?? Buffer.from('{}\n', 'utf8');
  if (!raw) await writeFile(path, bytes, { flag: 'wx' });
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('workflow.args.json must contain valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow.args.json must contain a JSON object');
  return { path: 'workflow.args.json', bytes, bytes_digest: sha256(bytes) };
}

export async function snapshotWorkflowScript(options: ScriptSnapshotOptions): Promise<WorkflowScriptSnapshot> {
  const planDirectory = await planPath(options.projectDirectory, options.planDirectory);
  const scriptRaw = await readPlanLocalFile(resolve(planDirectory, 'workflow.js'));
  const script = scriptRaw ?? defaultScript(options.actionIds);
  if (!scriptRaw) await writeFile(resolve(planDirectory, 'workflow.js'), script, { flag: 'wx' });
  if (script.length > 1_000_000) throw new Error('workflow.js exceeds the script size policy');
  const calls = parseScript(script.toString('utf8'), options.actionIds);
  const meta = parseMeta(await readPlanLocalFile(resolve(planDirectory, 'workflow.meta.json')), options.planId);
  const args = await argsSnapshot(planDirectory);
  return {
    script: { path: 'workflow.js', bytes: script, bytes_digest: sha256(script), meta_digest: meta.digest, language: 'javascript' },
    args,
    meta: meta.value,
    calls,
  };
}
