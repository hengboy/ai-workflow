/* Generated from authoritative JSON Schemas. Do not edit. */

export interface AgentPacket {
  packet_version: "1.0.0";
  run_id: string;
  plan_id: string;
  task_id?: string;
  role:
    | "file-explorer"
    | "git-operator"
    | "task-worker"
    | "backend"
    | "frontend"
    | "test"
    | "standards-review"
    | "spec-review"
    | "researcher";
  objective: string;
  cwd: string;
  read_paths: string[];
  write_paths: string[];
  evidence: string[];
  screenshot_dir: string;
  allowed_commands: string[];
  timeout_ms: number;
  result_schema: "schemas/result.schema.json";
}
