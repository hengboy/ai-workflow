/* Generated from authoritative JSON Schemas. Do not edit. */

export interface NavigationRefreshCandidate {
  version: 1;
  task_target: string;
  /**
   * @minItems 1
   */
  authorized_module_roots: [string, ...string[]];
  /**
   * @minItems 1
   */
  changed_paths: [string, ...string[]];
  maintenance_authorized: true;
  navigation: NavigationIndex;
}
export interface NavigationIndex {
  version: 1;
  module_roots: ModuleRoot[];
  features: Feature[];
}
export interface ModuleRoot {
  id: string;
  path: string;
  owner_role:
    | "file-explorer"
    | "git-operator"
    | "task-worker"
    | "backend"
    | "frontend"
    | "test"
    | "standards-review"
    | "spec-review"
    | "researcher"
    | "documentation-maintainer";
  responsibility: string;
  language: string;
  /**
   * @minItems 1
   */
  entry_kinds: [string, ...string[]];
}
export interface Feature {
  id: string;
  name: string;
  aliases: string[];
  task_ids?: string[];
  requirement_ids?: string[];
  acceptance_criteria_ids?: string[];
  module_root: string;
  /**
   * @minItems 1
   */
  entries: [string, ...string[]];
  symbols: Symbol[];
  related_files: string[];
  tests: string[];
  depends_on: string[];
  relations: Relation[];
  owner_role:
    | "file-explorer"
    | "git-operator"
    | "task-worker"
    | "backend"
    | "frontend"
    | "test"
    | "standards-review"
    | "spec-review"
    | "researcher"
    | "documentation-maintainer";
  responsibility: string;
  /**
   * @minItems 1
   */
  read_scope: [string, ...string[]];
  shared_entry: boolean;
}
export interface Symbol {
  file: string;
  name: string;
  kind: string;
  visibility: "public" | "private";
}
export interface Relation {
  kind: string;
  from: string;
  to: string;
}
