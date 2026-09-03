/* Generated from authoritative JSON Schemas. Do not edit. */

export type WorkflowV2 = CodingCapabilityManifest;

export interface CodingCapabilityManifest {
  schema_version: "2.0.0";
  engine: "worker-thread-trusted";
  plan_id: string;
  host: "codex" | "claude" | "opencode";
  project: Project;
  input_artifacts: InputArtifact[];
  input_artifacts_digest: string;
  script: Script;
  meta: Meta;
  args: Args;
  concurrency_groups: ConcurrencyGroupPolicy[];
  limits: Limits;
  policies: Policies;
  host_execution: HostExecution;
  tasks: CodingTaskCapability[];
  actions: CodingActionCapability[];
  scope_conflicts: ScopeConflict[];
  aggregate_repair: AggregateRepairCapability;
  repair_tests: RepairTestCapability[];
  review_rechecks: ReviewRecheckCapability[];
  mandatory_gates: CodingGate[];
}
export interface Project {
  git_common_dir_digest: string;
  target_branch: string;
}
export interface InputArtifact {
  path: string;
  kind: "spec" | "plan" | "task" | "navigation-json" | "navigation-markdown" | "script" | "meta" | "args";
  bytes_digest: string;
}
export interface Script {
  path: string;
  bytes_digest: string;
  meta_digest: string;
  language: "javascript";
}
export interface Meta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: {
    title: string;
    detail?: string;
  }[];
}
export interface Args {
  path: "workflow.args.json";
  bytes_digest: string;
}
export interface ConcurrencyGroupPolicy {
  group_id: string;
  kind: "parallel" | "pipeline-item" | "host-coordinator";
  action_ids: string[];
  conflict_policy: "reject-before-second-admission";
  outside_group_policy: "submission-fifo-after-predecessor-terminal";
}
export interface Limits {
  max_concurrent_agents: number;
  max_total_agents: number;
  max_items_per_call: number;
  max_script_bytes: number;
  max_result_bytes: number;
  sync_timeout_ms: number;
  dispose_grace_ms: number;
}
export interface Policies {
  max_retries: number;
  repair_rounds: 1;
  push_allowed: false;
  rebase_allowed: false;
  mixed_host_allowed: false;
  untrusted_script_allowed: false;
}
export interface HostExecution {
  adapter: "codex" | "claude" | "opencode";
  mode: "brokered-sandbox" | "read-only-diagnostic" | "unsupported";
  model_transport: {
    owner: "host-native-broker";
    network_allowed: true;
    project_write_allowed: false;
    credential_visibility: "broker-only";
  };
  action_executor: {
    process_group: true;
    network_allowed: false;
    project_write_enforced: true;
    git_metadata_write_allowed: false;
  };
  native_tool_authorization: "audited" | "unavailable";
  capability_digest: string;
}
export interface CodingTaskCapability {
  task_id: string;
  requirements: string[];
  acceptance_criteria: string[];
  feature: string;
  activation: "required" | "conditional";
  depends_on: string[];
  required_actions: string[];
  optional_actions: string[];
  finalization_action: string;
  finalization_mode: "read-only-finalize" | "commit-and-merge";
  worktree_policy: "isolated-task-worktree";
  max_repair_rounds: 1;
}
export interface CodingActionCapability {
  action_id: string;
  task_id: string;
  operation: "explore" | "implement" | "test" | "repair" | "review" | "finalize";
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
  locator_read_order: string[];
  read_scope: string[];
  write_scope: string[];
  new_module_directories: string[];
  allowed_commands: string[];
  test_commands: string[];
  output_schema?: string;
  requires_actions: string[];
  max_attempts: number;
  optional: boolean;
  write_access: boolean;
  host_only: boolean;
  repair_for_action_id?: string;
  concurrency_group_id?: string;
}
export interface ScopeConflict {
  left_action_id: string;
  right_action_id: string;
  kind: "write-write" | "write-read";
}
export interface AggregateRepairCapability {
  action_id: "plan-aggregate-repair";
  task_id: "plan";
  operation: "repair";
  role: "backend" | "frontend" | "task-worker";
  locator_read_order: string[];
  read_scope: string[];
  write_scope: string[];
  new_module_directories: string[];
  allowed_commands: string[];
  test_commands: string[];
  output_schema: "schemas/coding-agent-result.schema.json";
  requires_actions: [];
  max_attempts: 1;
  optional: false;
  write_access: true;
  host_only: true;
  maximum_write_scope: string[];
  test_actions_by_task: {
    [k: string]: string[];
  };
  worktree_policy: "isolated-repair-worktree";
}
export interface RepairTestCapability {
  action_id: string;
  task_id: string;
  operation: "test";
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
  locator_read_order: string[];
  read_scope: string[];
  write_scope: string[];
  new_module_directories: [];
  allowed_commands: [];
  test_commands: string[];
  output_schema?: string;
  requires_actions: [];
  max_attempts: 1;
  optional: false;
  write_access: false;
  host_only: true;
  source_test_action_id: string;
  worktree_policy: "isolated-repair-test-worktree";
  base_source: "plan-head-after-repair-merge";
  resource_kinds: ["repair-test-worktree", "repair-test-branch"];
  coordinator_action_id: string;
  coordinator_call_id_template: "host/repair-test/<repair-transaction-id>/<task-id>";
  repair_transaction_id: string;
}
export interface ReviewRecheckCapability {
  gate_id: "standards-review" | "spec-review";
  action_id: string;
  task_id: "plan";
  operation: "review";
  role: "standards-review" | "spec-review";
  locator_read_order: string[];
  read_scope: string[];
  write_scope: [];
  new_module_directories: [];
  allowed_commands: [];
  test_commands: [];
  output_schema: "schemas/review-repair-resolution.schema.json";
  requires_actions: [];
  max_attempts: 1;
  optional: false;
  write_access: false;
  host_only: true;
  read_scope_source: "original-review-action";
  coordinator_call_id_template: "host/finding-recheck/<gate-id>/<finding-id>";
}
export interface CodingGate {
  gate_id:
    | "task-closure"
    | "plan-validation"
    | "standards-review"
    | "spec-review"
    | "repair-closure"
    | "baseline-stable"
    | "integration";
  owner: "host";
  requires: string[];
  predicate:
    | "all-required-tasks-finalized"
    | "plan-validation-passed"
    | "review-findings-have-no-errors"
    | "every-original-finding-targeted-recheck-closed"
    | "aggregate-repair-closed"
    | "baseline-matches-receipt"
    | "target-no-ff-merge-observed";
  repair_budget: 0 | 1;
}
