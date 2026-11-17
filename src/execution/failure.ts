import type { ExecutionConfig } from './config.js';
import type { FailureCategory } from './types.js';

/** Bounded retry guidance derived from one failure category and its attempt count. */
export interface FailureGuidance {
  action: 'retry' | 'pause' | 'repair';
  retryDelaySeconds?: number;
}

const RETRYABLE: ReadonlySet<FailureCategory> = new Set([
  'model_unavailable',
  'network_timeout',
  'network_disconnect',
  'rate_limit',
]);

function retryable(category: FailureCategory): boolean {
  return RETRYABLE.has(category);
}

/**
 * Classify one failure into retry, pause or repair guidance. Retryable categories honor at most
 * `maxRetries` attempts with exponential backoff from `retryBaseDelayMs`; an explicit non-negative
 * integer Retry-After overrides the computed delay. Other categories pause, and task execution
 * failures route to repair without a retry loop.
 */
export function classifyFailure(
  category: FailureCategory,
  failureCount: number,
  config: ExecutionConfig,
  retryAfterSeconds?: number,
): FailureGuidance {
  if (category === 'task_execution') return { action: 'repair' };
  if (!retryable(category)) return { action: 'pause' };
  if (failureCount > config.maxRetries) return { action: 'pause' };
  if (typeof retryAfterSeconds === 'number' && Number.isInteger(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return { action: 'retry', retryDelaySeconds: retryAfterSeconds };
  }
  const exponent = Math.max(0, failureCount - 1);
  return { action: 'retry', retryDelaySeconds: (config.retryBaseDelayMs / 1000) * 2 ** exponent };
}

const DEFAULT_SUMMARY_LIMIT = 500;

/**
 * Remove credentials from a failure summary and bound its length. Recognized shapes cover provider
 * API keys, bearer credentials and password, token or api-key assignments; unrecognized prose stays
 * intact so the diagnostic detail survives.
 */
export function redactFailureSummary(text: string, limit: number = DEFAULT_SUMMARY_LIMIT): string {
  const redacted = text
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bpassword\s*[:=]\s*[^\s,;]+/gi, 'password=[REDACTED]')
    .replace(/\btoken\s*[:=]\s*[^\s,;]+/gi, 'token=[REDACTED]');
  const bounded = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_SUMMARY_LIMIT;
  return redacted.length <= bounded ? redacted : redacted.slice(0, bounded);
}
