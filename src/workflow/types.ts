import type { Workflow, Node, Gate } from '../generated/workflow.schema.js';
export type { Workflow, Node, Gate };
export type Host = Workflow['host'];
export type Role = Node['role'];
export interface PlanDocument { planId: string; status: string; requirements: string[]; acceptanceCriteria: string[]; specDigest: string; planDigest: string; digest: string; directory: string }
export interface TaskDocument { id: string; requirements: string[]; acceptanceCriteria: string[]; dependsOn: string[]; surface: string; feature?: string; locatorReadOrder: string[]; readScope: string[]; newModuleDirectories: string[]; writeScope: string[]; testCommands: string[]; path: string }
