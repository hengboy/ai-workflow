/* Generated from authoritative JSON Schemas. Do not edit. */

export type Path = string;
export type ActionId = string;

export interface CodingAgentResult {
  result_version: "2.0.0";
  status: "done" | "blocked" | "failed";
  summary: string;
  changed_paths: Path[];
  evidence: Path[];
  tests: TestResult[];
  findings: ReviewFindingDraft[];
  git_refs: string[];
  support_requests: string[];
  value?: unknown;
}
export interface TestResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  output?: string;
}
export interface ReviewFindingDraft {
  severity: "error" | "warning" | "info";
  message: string;
  path?: Path;
  applicable_action_ids: ActionId[];
}
