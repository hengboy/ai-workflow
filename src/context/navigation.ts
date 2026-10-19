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
  task_ids?: string[];
  requirement_ids?: string[];
  acceptance_criteria_ids?: string[];
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

const RESPONSIBILITY_LIMIT = 120;

function escapeCatalogCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function catalogRow(feature: NavigationFeature): string {
  const entry = feature.entries[0] ?? '';
  const responsibility = Array.from(feature.responsibility).slice(0, RESPONSIBILITY_LIMIT).join('');
  return [
    escapeCatalogCell(feature.id),
    escapeCatalogCell(feature.owner_role),
    escapeCatalogCell(entry),
    escapeCatalogCell(responsibility),
    escapeCatalogCell(`ai-workflow context locate --feature ${feature.id} --verify`)
  ].join(' | ');
}

export function renderNavigation(index: NavigationIndex): string {
  const rows = index.features.map((feature) => `| ${catalogRow(feature)} |`);
  return ['# Feature navigation', '', '| Feature | Owner | Entry | Responsibility | Locate |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}
