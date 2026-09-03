/* Generated from authoritative JSON Schemas. Do not edit. */

export type CodingResource = OwnedGitResource | ProjectRunResource;
export type OwnedGitResource = {
  [k: string]: unknown;
};
export type Identifier = string;
export type Path = string;
export type Digest = string;

export interface ProjectRunResource {
  resource_version: "2.0.0";
  resource_type: "project-run-resource";
  run_id: Identifier;
  project_path: Path;
  git_common_dir_digest: Digest;
  target_branch: string;
  target_head: string;
  manifest_digest: Digest;
}
