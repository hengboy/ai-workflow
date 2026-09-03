/* Generated from authoritative JSON Schemas. Do not edit. */

export type Digest = string;

export interface HostExecutionCapability {
  adapter: "codex" | "claude" | "opencode";
  mode: "brokered-sandbox" | "read-only-diagnostic" | "unsupported";
  model_transport: ModelTransport;
  action_executor: ActionExecutor;
  native_tool_authorization: "audited" | "unavailable";
  capability_digest: Digest;
}
export interface ModelTransport {
  owner: "host-native-broker";
  network_allowed: true;
  project_write_allowed: false;
  credential_visibility: "broker-only";
}
export interface ActionExecutor {
  process_group: true;
  network_allowed: false;
  project_write_enforced: true;
  git_metadata_write_allowed: false;
}
