export const activeStates = ['preflight', 'baseline', 'plan_setup', 'executing', 'validating', 'reviewing', 'repairing', 'integrating'] as const;
export type ActiveState = typeof activeStates[number];
export type RunState = ActiveState | 'complete' | 'paused' | 'cancelled';
export const transitions: Record<RunState, RunState[]> = {
  preflight: ['baseline', 'paused', 'cancelled'], baseline: ['plan_setup', 'paused', 'cancelled'], plan_setup: ['executing', 'paused', 'cancelled'], executing: ['validating', 'paused', 'cancelled'], validating: ['reviewing', 'paused', 'cancelled'], reviewing: ['repairing', 'integrating', 'paused', 'cancelled'], repairing: ['integrating', 'paused', 'cancelled'], integrating: ['complete', 'paused', 'cancelled'], complete: [], paused: ['preflight', 'baseline', 'plan_setup', 'executing', 'validating', 'reviewing', 'repairing', 'integrating', 'cancelled'], cancelled: []
};
export function assertTransition(from: RunState, to: RunState): void { if (!transitions[from].includes(to)) throw new Error(`Invalid run transition: ${from} -> ${to}`); }
