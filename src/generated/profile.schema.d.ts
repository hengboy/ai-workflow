/* Generated from authoritative JSON Schemas. Do not edit. */

export interface Profile {
  version: "1.0.0";
  agents: {
    [k: string]: Agent;
  };
}
export interface Agent {
  codex?: Model;
  claude?: Model;
  opencode?: Model;
  antigravity?: AntigravityModel;
}
export interface Model {
  model: string;
  reasoning_effort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}
export interface AntigravityModel {
  model: "inherit" | "flash_lite" | "flash" | "pro";
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}
