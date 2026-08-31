/* Generated from authoritative JSON Schemas. Do not edit. */

export type Digest = string;
export type Path = string;

export interface Workflow {
  schema_version: "1.0.0";
  plan_id: string;
  host: "codex" | "claude" | "opencode";
  input_digests: {
    [k: string]: Digest;
  };
  concurrency: number;
  policies: {
    max_retries: number;
    default_timeout_ms: number;
    repair_rounds: 1;
    push_allowed: false;
    rebase_allowed: false;
  };
  /**
   * @minItems 1
   */
  phases: [string, ...string[]];
  /**
   * @minItems 1
   */
  nodes: [Node, ...Node[]];
  gates: Gate[];
}
export interface Node {
  id: string;
  phase: string;
  kind: "agent" | "parallel" | "pipeline" | "phase" | "gate" | "git";
  role:
    | "file-explorer"
    | "git-operator"
    | "task-worker"
    | "backend"
    | "frontend"
    | "test"
    | "standards-review"
    | "spec-review";
  task_id?: string;
  depends_on: string[];
  read_scope: Path[];
  write_scope: Path[];
  allowed_commands?: string[];
  timeout_ms: number;
  retry: number;
  result_schema: "schemas/result.schema.json";
  on_failure: "pause" | "retry" | "repair_once";
}
export interface Gate {
  id: string;
  /**
   * @minItems 1
   */
  after: [string, ...string[]];
  kind: "tests-pass" | "reviews-pass-or-repair" | "context-valid" | "approval-valid" | "baseline-stable";
}
