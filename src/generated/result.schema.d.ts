/* Generated from authoritative JSON Schemas. Do not edit. */

export type AgentResult = {
  [k: string]: unknown;
} & {
  result_version?: "1.0.0" | "2.0.0";
  status: "done" | "blocked" | "failed";
  summary: string;
  changed_paths: string[];
  evidence: string[];
  tests: {
    command: string;
    status: "passed" | "failed" | "skipped";
    output?: string;
  }[];
  findings: {
    severity: "error" | "warning" | "info";
    message: string;
    path?: string;
  }[];
  git_refs: string[];
  support_requests: string[];
  value?: unknown;
};
