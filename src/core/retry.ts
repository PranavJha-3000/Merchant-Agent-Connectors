/**
 * Retry policy: explicit, bounded, and documented.
 *
 * Retry matrix (docs/reliability.md, tests/unit/retry.test.ts):
 *   408, 429, 5xx  → retryable (bounded by maxAttempts)
 *   401/403/404/409/422/400 → NOT retryable (401 may be replayed exactly once
 *                     by a provider auth strategy that refreshes a token)
 *   network / timeout → retryable
 *   malformed JSON / schema mismatch → NOT retryable (retrying cannot fix a
 *                     structurally broken response)
 *
 * Backoff: delay = min(base * 2^(attempt-1) + U(0..jitter), maxDelayMs)
 *   where `attempt` is the number of failures so far (first retry => attempt 1).
 * Retry-After (seconds or HTTP-date) ALWAYS overrides the computed delay and is
 * bounded by maxRetryAfterMs (default 60s); if the upstream asks for longer,
 * we stop with RateLimitError{retryable:true, retryAfterMs} instead of sleeping.
 */

export interface RetryPolicy {
  /** Total attempts including the first (3 = 1 initial + 2 retries). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Extra uniform jitter added to the exponential term. */
  jitterMs: number;
  /** Upper bound on honoring a server-provided Retry-After. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitterMs: 250,
  maxRetryAfterMs: 60_000,
};

/**
 * Parse a `Retry-After` header value (delta-seconds or HTTP-date) to milliseconds.
 * Returns undefined when absent or unparseable (caller falls back to backoff).
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1_000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return undefined;
}

export interface BackoffOptions {
  retryAfterMs?: number;
  random?: () => number;
}

/** Compute the sleep before the next attempt (see module doc for the formula). */
export function computeBackoffMs(attempt: number, policy: RetryPolicy, options: BackoffOptions = {}): number {
  if (options.retryAfterMs !== undefined) {
    return Math.min(options.retryAfterMs, policy.maxRetryAfterMs);
  }
  const random = options.random ?? Math.random;
  const exponential = policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = random() * policy.jitterMs;
  return Math.min(exponential + jitter, policy.maxDelayMs);
}

/** Which HTTP statuses may be retried. 401 is handled separately (token refresh + single replay). */
export function isRetryableStatus(status: number): boolean {
  if (status === 408) return true;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}
