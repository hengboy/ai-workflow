/* Generated from authoritative JSON Schemas. Do not edit. */

export interface NavigationRefreshCandidate {
  version: 1;
  task_target: string;
  /**
   * @minItems 1
   */
  authorized_module_roots: [string, ...string[]];
  /**
   * @minItems 1
   */
  changed_paths: [string, ...string[]];
  maintenance_authorized: true;
  navigation: {
    [k: string]: unknown;
  };
}
