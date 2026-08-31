/* Generated from authoritative JSON Schemas. Do not edit. */

export interface AgentResult {
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
}
