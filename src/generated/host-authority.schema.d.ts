/* Generated from authoritative JSON Schemas. Do not edit. */

export type HostAuthorityResult =
  | {
      result_version: "2.0.0";
      result_type: "plan-validation";
      valid: boolean;
      errors: string[];
    }
  | {
      result_version: "2.0.0";
      result_type: "review";
      gate_id: "standards-review" | "spec-review";
      findings: Finding[];
    }
  | {
      result_version: "2.0.0";
      result_type: "aggregate-repair";
      changed_paths: Path[];
    }
  | {
      result_version: "2.0.0";
      result_type: "repair-test";
      task_id: string;
      tests: Test[];
    };
export type Path = string;
export type ActionId = string;

export interface Finding {
  severity: "error" | "warning" | "info";
  message: string;
  path: Path;
  applicable_action_ids: ActionId[];
}
export interface Test {
  command: string;
  status: "passed" | "failed" | "skipped";
}
