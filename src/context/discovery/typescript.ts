import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import type { DiscoveryFacts } from './scanner.js';
import type {
  AdapterResult,
  CandidateModuleRoot,
  CandidateRelation,
  CandidateSymbol,
  DiscoveryCandidate
} from './types.js';
import type { ModuleAnalysisRequest } from './adapters.js';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function trimSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function projectPrefix(moduleRootPath: string, declared: string): string {
  const normalizedDeclared = trimSlashes(declared);
  if (normalizedDeclared === '' || normalizedDeclared === '.') return trimSlashes(moduleRootPath);
  return normalizedDeclared;
}

function isWithin(path: string, prefix: string): boolean {
  return prefix !== '' && (path === prefix || path.startsWith(`${prefix}/`));
}

const TEST_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SOURCE_EXTENSION_PATTERN = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/;

function isTypeScriptLike(language: string): boolean {
  return language === 'typescript' || language === 'javascript';
}

function topLevelDirectory(path: string): string {
  const separator = path.indexOf('/');
  return separator === -1 ? '.' : path.slice(0, separator);
}

interface Declaration {
  name: string;
  kind: string;
  exported: boolean;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function topLevelDeclarations(source: ts.SourceFile): Declaration[] {
  const result: Declaration[] = [];
  for (const statement of source.statements) {
    const exported = isExported(statement);
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) result.push({ name: statement.name.text, kind: 'function', exported });
    } else if (ts.isClassDeclaration(statement)) {
      if (statement.name) result.push({ name: statement.name.text, kind: 'class', exported });
    } else if (ts.isInterfaceDeclaration(statement)) {
      result.push({ name: statement.name.text, kind: 'interface', exported });
    } else if (ts.isEnumDeclaration(statement)) {
      result.push({ name: statement.name.text, kind: 'enum', exported });
    } else if (ts.isTypeAliasDeclaration(statement)) {
      result.push({ name: statement.name.text, kind: 'type', exported });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const kind =
          declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
            ? 'function'
            : 'variable';
        result.push({ name: declaration.name.text, kind, exported });
      }
    }
  }
  return result;
}

interface ImportBinding {
  file: string;
  name: string;
}

function directImports(file: string, source: ts.SourceFile, files: Set<string>): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const base = join(dirname(file), specifier).replace(/\\/g, '/').replace(SOURCE_EXTENSION_PATTERN, '');
    const target = [
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}.mjs`,
      `${base}.cjs`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.jsx`,
      `${base}/index.mjs`,
      `${base}/index.cjs`
    ].find((candidate) => files.has(candidate));
    if (!target) continue;
    for (const imported of statement.importClause.namedBindings.elements) {
      bindings.set(imported.name.text, { file: target, name: imported.propertyName?.text ?? imported.name.text });
    }
  }
  return bindings;
}

function importedBindingsIn(node: ts.Node, bindings: Map<string, ImportBinding>): ImportBinding[] {
  const result = new Map<string, ImportBinding>();
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) {
      const binding = bindings.get(current.text);
      if (binding) result.set(`${binding.file}#${binding.name}`, binding);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...result.values()];
}

export function detectTypeScriptModules(facts: DiscoveryFacts): CandidateModuleRoot[] {
  const groups = new Map<string, string[]>();
  for (const file of facts.files) {
    if (!isTypeScriptLike(file.language)) continue;
    const directory = topLevelDirectory(file.path);
    groups.set(directory, [...(groups.get(directory) ?? []), file.path]);
  }
  return [...groups.keys()].sort(compareStrings).map((path) => ({
    id: path === '.' ? 'root' : path,
    path,
    ownerRole: 'shared',
    responsibility: `Discovered typescript module at ${path}`,
    language: 'typescript',
    entryKinds: ['exported-symbol']
  }));
}

export async function analyzeTypeScriptModule(request: ModuleAnalysisRequest): Promise<AdapterResult> {
  const { root, facts, moduleRoot, sourceRoots, testRoots } = request;
  const sourcePrefixes = sourceRoots.map((entry) => projectPrefix(moduleRoot.path, entry)).filter((prefix) => prefix !== '');
  const testPrefixes = testRoots.map((entry) => projectPrefix(moduleRoot.path, entry)).filter((prefix) => prefix !== '');
  const withinModule = (path: string): boolean =>
    sourcePrefixes.some((prefix) => isWithin(path, prefix)) || testPrefixes.some((prefix) => isWithin(path, prefix));
  const isTestFile = (path: string): boolean =>
    testPrefixes.some((prefix) => isWithin(path, prefix)) || TEST_PATTERN.test(path);

  const moduleFiles = facts.files.filter((file) => isTypeScriptLike(file.language) && withinModule(file.path));
  const sourceFiles = moduleFiles.filter((file) => !isTestFile(file.path));
  const tests = moduleFiles.filter((file) => isTestFile(file.path)).map((file) => file.path).sort(compareStrings);
  const analyzedFiles = new Set(sourceFiles.map((file) => file.path));

  const entries: string[] = [];
  const relatedFiles: string[] = [];
  const symbols: CandidateSymbol[] = [];
  const relations: CandidateRelation[] = [];

  for (const file of sourceFiles) {
    const source = ts.createSourceFile(file.path, await readFile(join(root, file.path), 'utf8'), ts.ScriptTarget.Latest, true);
    const exported = topLevelDeclarations(source).filter((declaration) => declaration.exported);
    if (exported.length > 0) entries.push(file.path);
    else relatedFiles.push(file.path);
    for (const declaration of exported) {
      symbols.push({ file: file.path, name: declaration.name, kind: declaration.kind, visibility: 'public' });
    }
    const imports = directImports(file.path, source, analyzedFiles);
    for (const statement of source.statements) {
      const declared = topLevelDeclarations(ts.createSourceFile(file.path, statement.getText(source), ts.ScriptTarget.Latest, true));
      for (const declaration of declared) {
        if (!declaration.exported) continue;
        const from = `${file.path}#${declaration.name}`;
        for (const target of importedBindingsIn(statement, imports)) {
          relations.push({ kind: 'imports', from, to: `${target.file}#${target.name}` });
        }
      }
    }
  }

  entries.sort(compareStrings);
  relatedFiles.sort(compareStrings);
  symbols.sort(
    (left, right) =>
      compareStrings(left.file, right.file) || compareStrings(left.name, right.name) || compareStrings(left.kind, right.kind)
  );
  const uniqueRelations = [
    ...new Map(
      relations.map((relation) => [`${relation.kind}\u0000${relation.from}\u0000${relation.to}`, relation])
    ).values()
  ].sort(
    (left, right) =>
      compareStrings(left.kind, right.kind) || compareStrings(left.from, right.from) || compareStrings(left.to, right.to)
  );

  const candidate: DiscoveryCandidate = {
    id: moduleRoot.id,
    name: moduleRoot.id,
    moduleRoot: moduleRoot.id,
    entries,
    relatedFiles,
    tests,
    symbols,
    relations: uniqueRelations,
    ownerRole: moduleRoot.ownerRole,
    responsibility: moduleRoot.responsibility,
    sharedEntry: false
  };
  return { moduleRoots: [moduleRoot], candidates: [candidate], diagnostics: [] };
}
