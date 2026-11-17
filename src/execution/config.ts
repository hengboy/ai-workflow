/** Tunable limits that govern retry guidance, checkpoint retention and event sizing. */
export interface ExecutionConfig {
  maxRetries: number;
  retryBaseDelayMs: number;
  checkpointHistory: number;
  maxEventLineBytes: number;
}

/** Documented defaults used when an override is absent or unusable. */
export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = Object.freeze({
  maxRetries: 2,
  retryBaseDelayMs: 1000,
  checkpointHistory: 10,
  maxEventLineBytes: 65536,
});

/** Read a non-negative integer override, falling back on absent, negative or fractional values. */
function integerFrom(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Resolve the execution configuration from the environment. Every override is
 * independent, so one invalid value never discards the other valid ones.
 */
export function readExecutionConfig(env: NodeJS.ProcessEnv = process.env): ExecutionConfig {
  return {
    maxRetries: integerFrom(env.AI_WORKFLOW_EXECUTION_MAX_RETRIES, DEFAULT_EXECUTION_CONFIG.maxRetries),
    retryBaseDelayMs: integerFrom(env.AI_WORKFLOW_EXECUTION_RETRY_DELAY_MS, DEFAULT_EXECUTION_CONFIG.retryBaseDelayMs),
    checkpointHistory: integerFrom(env.AI_WORKFLOW_EXECUTION_CHECKPOINT_HISTORY, DEFAULT_EXECUTION_CONFIG.checkpointHistory),
    maxEventLineBytes: integerFrom(env.AI_WORKFLOW_EXECUTION_MAX_EVENT_BYTES, DEFAULT_EXECUTION_CONFIG.maxEventLineBytes),
  };
}
