/* Generated from authoritative JSON Schemas. Do not edit. */

export interface WorkflowAdjustment {
  version: "1.0.0";
  /**
   * @maxItems 100
   */
  operations: (
    | {
        op: "set-concurrency";
        value: number;
      }
    | {
        op: "set-role" | "set-retry" | "set-failure-policy";
        node: string;
        value: string | number;
      }
    | {
        op: "add-dependency" | "remove-dependency";
        node: string;
        dependency: string;
      }
    | {
        op: "add-gate" | "remove-gate";
        gate: {
          [k: string]: unknown;
        };
      }
  )[];
}
