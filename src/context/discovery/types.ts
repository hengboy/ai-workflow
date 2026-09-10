export interface DiscoveryDiagnostic {
  path: string;
  code: string;
  message: string;
}

export interface CandidateModuleRoot {
  id: string;
  path: string;
  ownerRole: string;
  responsibility: string;
  language: string;
  entryKinds: string[];
}

export interface CandidateSymbol {
  file: string;
  name: string;
  kind: string;
  visibility: 'public' | 'private';
}

export interface CandidateRelation {
  kind: string;
  from: string;
  to: string;
}

export interface DiscoveryCandidate {
  id: string;
  name: string;
  moduleRoot: string;
  entries: string[];
  relatedFiles: string[];
  tests: string[];
  symbols: CandidateSymbol[];
  relations: CandidateRelation[];
  ownerRole: string;
  responsibility: string;
  sharedEntry: boolean;
}

export interface AdapterResult {
  moduleRoots: CandidateModuleRoot[];
  candidates: DiscoveryCandidate[];
  diagnostics: DiscoveryDiagnostic[];
}
