export type Host = 'codex' | 'claude' | 'opencode';
export interface WorkspaceRepo { name: string; path: string; depends_on: string[] }
export interface WorkspaceFinalizationReadScope { repo: string; paths: string[] }
export interface WorkspaceFinalization {
  requirements: string[];
  acceptanceCriteria: string[];
  readScope: WorkspaceFinalizationReadScope[];
  writeScope: string[];
  testCommands: string[];
}
export interface PlanDocument { planId: string; status: string; requirements: string[]; acceptanceCriteria: string[]; specDigest: string; planDigest: string; digest: string; directory: string; workspaceRepos?: WorkspaceRepo[]; workspaceFinalization?: WorkspaceFinalization }
export interface TaskDocument { id: string; requirements: string[]; acceptanceCriteria: string[]; dependsOn: string[]; surface: string; readScope: string[]; writeScope: string[]; testCommands: string[]; path: string; repo?: string }
export interface TaskPhase { parallel: string[] }
export interface TaskSchedule { planId: string; phases: TaskPhase[] }
