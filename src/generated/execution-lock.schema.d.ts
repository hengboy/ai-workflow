/* Generated from authoritative JSON Schemas. Do not edit. */

export type Timestamp = string;

export interface ExecutionLock {
  owner_id: string;
  pid: number;
  host: string;
  acquired_at: Timestamp;
  command: string;
}
