import * as vm from 'node:vm';

export class MaterializeError extends Error {
  readonly name = 'MaterializeError';

  constructor(readonly path: string, readonly reason: string) {
    super(`${path}: ${reason}`);
  }
}

export class ScriptCompileError extends Error {
  readonly name = 'ScriptCompileError';
}

function plainPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function materialize(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MaterializeError(path, 'non-finite numbers are not JSON data');
    return value;
  }
  if (typeof value === 'undefined') throw new MaterializeError(path, 'undefined is not JSON data');
  if (typeof value === 'function') throw new MaterializeError(path, 'functions are not plain JSON data');
  if (typeof value === 'symbol') throw new MaterializeError(path, 'symbols are not plain JSON data');
  if (typeof value === 'bigint') throw new MaterializeError(path, 'bigints are not JSON data');

  const objectValue = value as object;
  if (seen.has(objectValue)) throw new MaterializeError(path, 'circular references are not JSON data');
  seen.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      const result: unknown[] = [];
      for (let index = 0; index < objectValue.length; index += 1) {
        if (!(index in objectValue)) throw new MaterializeError(`${path}[${index}]`, 'sparse arrays are not JSON data');
        result.push(materialize(objectValue[index], `${path}[${index}]`, seen));
      }
      for (const key of Object.keys(objectValue)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= objectValue.length) {
          throw new MaterializeError(`${path}.${key}`, 'arrays with non-index properties are not JSON data');
        }
      }
      if (Object.getOwnPropertySymbols(objectValue).length > 0) {
        throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data');
      }
      return result;
    }
    if (!plainPrototype(objectValue)) throw new MaterializeError(path, 'only plain objects and arrays are JSON data (exotic prototype)');
    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data');
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(objectValue)) {
      Object.defineProperty(result, key, {
        value: materialize((objectValue as Record<string, unknown>)[key], `${path}.${key}`, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(objectValue);
  }
}

export function materializeFromRealm(value: unknown, root = 'value'): unknown {
  if (value === undefined) return undefined;
  try {
    return materialize(value, root, new Set<object>());
  } catch (error) {
    if (error instanceof MaterializeError) throw error;
    throw new MaterializeError(root, `reading the value threw: ${renderThrown(error)}`);
  }
}

export function renderThrown(error: unknown): string {
  try {
    const stack = (error as { stack?: unknown } | null | undefined)?.stack;
    if (typeof stack === 'string' && stack.length > 0) return stack;
    const message = (error as { message?: unknown } | null | undefined)?.message;
    if (typeof message === 'string' && message.length > 0) return message;
    return String(error);
  } catch {
    return '[unrenderable thrown value]';
  }
}

export function compileWorkflowScript(source: string, name = 'workflow', maxBytes = 1_000_000): vm.Script {
  if (Buffer.byteLength(source, 'utf8') > maxBytes) throw new ScriptCompileError('workflow script exceeds the script size policy');
  try {
    return new vm.Script(`(async () => {\n${source}\n})()`, {
      filename: `workflow:${name}`,
      lineOffset: -1,
    });
  } catch (error) {
    throw new ScriptCompileError(`workflow script parse error: ${renderThrown(error)}`);
  }
}
