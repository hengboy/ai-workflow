/* Generated from authoritative JSON Schemas. Do not edit. */

export type FindingRecheckResult = {
  [k: string]: unknown;
} & {
  result_version: "2.0.0";
  result_type: "finding-recheck";
  finding_id: FindingId;
  status: "closed" | "open";
  evidence_paths: Path[];
  evidence_digests: Digest[];
  repair_diff_digest: Digest;
  source_review_receipt_digest: Digest;
  message: string;
};
export type FindingId = string;
export type Path = string;
export type Digest = string;
