/* Generated from authoritative JSON Schemas. Do not edit. */

export interface ProjectConfig {
  version: 1;
  modules?: Module[];
  features?: Feature[];
}
export interface Module {
  id: string;
  path: string;
  /**
   * @minItems 1
   */
  languages: [string, ...string[]];
  /**
   * @minItems 1
   */
  source_roots: [string, ...string[]];
  test_roots: string[];
}
export interface Feature {
  id: string;
  name: string;
  module_root: string;
  /**
   * @minItems 1
   */
  paths: [string, ...string[]];
}
