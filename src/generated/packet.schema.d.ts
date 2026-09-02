/* Generated from authoritative JSON Schemas. Do not edit. */

export type Path = string;

export interface AgentPacket {
  packet_version: "1.0.0";
  run_id: string;
  plan_id: string;
  task_id?: string;
  feature?: string;
  role:
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
  objective: string;
  cwd: string;
  read_paths: string[];
  write_paths: string[];
  evidence: string[];
  screenshot_dir: string;
  allowed_commands: string[];
  timeout_ms: number;
  result_schema: "schemas/result.schema.json";
  context_locator?: ContextLocator;
}
export interface ContextLocator {
  status: "hit" | "ambiguous" | "blocked" | "missing_index" | "miss" | "stale" | "invalid";
  resolution_mode: "index";
  feature?: string;
  entries?: string[];
  symbols?: string[];
  related_files?: string[];
  tests?: string[];
  read_order?: Path[];
  related_features?: string[];
  candidates?: string[];
  reason?: string;
  fallback_required: boolean;
  fallback?: ContextFallback;
}
export interface ContextFallback {
  status: "missing_index" | "miss" | "stale" | "invalid";
  target: {
    feature?: string;
    symbol?: string;
    task?: string;
  };
  reason: string;
  known_paths: string[];
  known_symbols: string[];
  module_roots: string[];
  maintenance_authorized: boolean;
  question: string;
}
