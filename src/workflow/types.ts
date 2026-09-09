export type Host = 'codex' | 'claude' | 'opencode';
export interface PlanDocument { planId: string; status: string; requirements: string[]; acceptanceCriteria: string[]; specDigest: string; planDigest: string; digest: string; directory: string }
export interface TaskDocument { id: string; requirements: string[]; acceptanceCriteria: string[]; dependsOn: string[]; surface: string; feature?: string; locatorReadOrder: string[]; readScope: string[]; newModuleDirectories: string[]; writeScope: string[]; testCommands: string[]; path: string }
