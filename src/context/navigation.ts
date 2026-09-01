export interface NavigationSymbol {
  file: string;
  name: string;
  kind: string;
  visibility: 'public' | 'private';
}

export interface NavigationRelation {
  kind: string;
  from: string;
  to: string;
}

export interface NavigationFeature {
  id: string;
  name: string;
  aliases: string[];
  module_root: string;
  entries: string[];
  symbols: NavigationSymbol[];
  related_files: string[];
  tests: string[];
  depends_on: string[];
  relations: NavigationRelation[];
  owner_role: string;
  responsibility: string;
  read_scope: string[];
  shared_entry: boolean;
}

export interface NavigationModuleRoot {
  id: string;
  path: string;
  owner_role: string;
  responsibility: string;
  language: string;
  entry_kinds: string[];
}

export interface NavigationIndex {
  version: 1;
  module_roots: NavigationModuleRoot[];
  features: NavigationFeature[];
}

function column(values: string[]): string { return values.join(', '); }

export function renderNavigation(index: NavigationIndex): string {
  const rows = index.features.map((feature) => [
    feature.name,
    column(feature.entries),
    column(feature.symbols.map((symbol) => `${symbol.file}#${symbol.name}`)),
    column(feature.related_files),
    column(feature.tests),
    column(feature.read_scope),
    feature.owner_role,
    feature.responsibility
  ].join(' | '));
  return ['# Feature navigation', '', '| Feature | Entries | Public Symbols | Related Files | Tests | Read Scope | Owner | Responsibility |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows.map((row) => `| ${row} |`), ''].join('\n');
}
