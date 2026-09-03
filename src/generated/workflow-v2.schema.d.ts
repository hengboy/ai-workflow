/* Generated from authoritative JSON Schemas. Do not edit. */

export interface WorkflowV2 {
  schema_version: "2.0.0";
  engine: "worker-thread-trusted";
  plan_id: string;
  host: "codex" | "claude" | "opencode";
  project: {
    git_common_dir_digest: string;
    target_branch: string;
  };
  input_artifacts: {
    path: string;
    kind: "spec" | "plan" | "task" | "navigation-json" | "navigation-markdown" | "script" | "meta" | "args";
    bytes_digest: string;
  }[];
  input_artifacts_digest: string;
  script: {
    path: string;
    bytes_digest: string;
    meta_digest: string;
    language: "javascript";
  };
  meta: {
    name: string;
    description: string;
    whenToUse?: string;
    phases?: unknown[];
  };
  args: {
    path: "workflow.args.json";
    bytes_digest: string;
  };
  concurrency_groups: unknown[];
  limits: {
    [k: string]: unknown;
  };
  policies: {
    [k: string]: unknown;
  };
  host_execution: {
    [k: string]: unknown;
  };
  tasks: unknown[];
  actions: unknown[];
  scope_conflicts: unknown[];
  aggregate_repair: {
    [k: string]: unknown;
  };
  repair_tests: unknown[];
  review_rechecks: unknown[];
  mandatory_gates: unknown[];
}
