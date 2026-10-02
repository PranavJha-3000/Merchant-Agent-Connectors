import { randomUUID } from 'node:crypto';
import type { AuthStrategy } from './auth.ts';
import {
  AuthenticationError,
  extractUpstreamErrorDetail,
  isConnectorError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  UpstreamResponseError,
  UpstreamUnavailableError,
  ValidationError,
  ConflictError,
  AuthorizationError,
  type ConnectorError,
} from './errors.ts';
import type { Logger } from './logger.ts';
import { computeBackoffMs, DEFAULT_RETRY_POLICY, isRetryableStatus, parseRetryAfterMs, type RetryPolicy } from './retry.ts';

/**
 * Shared HTTP runtime: the single place every provider request flows through.
 *
 * Owns: URL building, auth header injection (via AuthStrategy), timeout+abort,
 * bounded retry with exponential backoff+jitter, Retry-After honoring,
 * in-process pacing + concurrency limiting, JSON parsing, correlation IDs,
 * and safe structured logging. Providers own only *what* to request and how to
 * translate the response (see AGENTS.md §6/§10).
 *
 * Built on Node's native fetch (Node >= 20) — no HTTP client dependency.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | undefined;

export interface GetSpec {
  /** Path relative to baseUrl, e.g. '/tickets'. */
  path: string;
  query?: Record<string, QueryValue>;
  /** Stable operation name for logs/errors, e.g. 'freshdesk.listTickets'. */
  operation: string;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  json: unknown;
  headers: Headers;
  attempts: number;
  durationMs: number;
  correlationId: string;
}

export interface MapErrorInput {
  provider: string;
  status: number;
  detail?: string;
  body: unknown;
  operation: string;
  correlationId: string;
  retryAfterMs?: number;
}

export interface HttpClientOptions {
  provider: string;
  baseUrl: string;
  auth: AuthStrategy;
  logger: Logger;
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  /** Per-attempt timeout. Default 10s. */
  timeoutMs?: number;
  /** Minimum spacing between request starts (in-process pacing). Default 100ms. */
  minIntervalMs?: number;
  /** Max concurrent in-flight requests. Default 4. */
  concurrency?: number;
  /** Injectable sleep (tests capture delays instead of waiting). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for deterministic jitter in tests. */
  random?: () => number;
  /** Provider-specific HTTP error translation hook. Defaults to mapHttpStatus. */
  mapError?: (input: MapErrorInput) => ConnectorError;
}

function defaultSleep(ms: number): Promise<void> {
  // NOTE: deliberately NOT unref'd. This sleep suspends an in-flight operation
  // (backoff/pacing), so the timer must keep the event loop alive. Unref'ing it
  // would let a short-lived process exit silently mid-request.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function statusCategory(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function mapHttpStatus(input: MapErrorInput): ConnectorError {
  const ctx = {
    provider: input.provider,
    operation: input.operation,
    correlationId: input.correlationId,
    status: input.status,
    retryAfterMs: input.retryAfterMs,
    message: `Upstream ${input.status} on ${input.operation}${input.detail ? `: ${input.detail}` : ''}`,
  } as const;
  switch (true) {
    case input.status === 400 || input.status === 422:
      return new ValidationError({ ...ctx, hint: 'The request was rejected as invalid. Fix the arguments and call again.' });
    case input.status === 401:
      return new AuthenticationError({ ...ctx, hint: 'Credentials are missing, invalid, or expired. Check provider configuration.' });
    case input.status === 403:
      return new AuthorizationError({ ...ctx, hint: 'The credentials lack permission for this operation. Check scopes/roles.' });
    case input.status === 404:
      return new NotFoundError({ ...ctx, hint: 'The resource does not exist. Do not retry with the same ID.' });
    case input.status === 409:
      return new ConflictError({ ...ctx, hint: 'The resource is in a conflicting state.' });
    case input.status === 429:
      return new RateLimitError({
        ...ctx,
        hint: input.retryAfterMs !== undefined
          ? `Rate limited. Wait ${Math.ceil(input.retryAfterMs / 1000)}s before retrying.`
          : 'Rate limited. Wait before retrying.',
      });
    default:
      return new UpstreamUnavailableError({ ...ctx, hint: 'The upstream failed. This is usually transient; retrying may help.' });
  }
}

export class HttpClient {
  private readonly provider: string;
  private readonly baseUrl: string;
  private readonly auth: AuthStrategy;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly concurrency: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly mapError: (input: MapErrorInput) => ConnectorError;

  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private nextStartAt = 0;

  constructor(options: HttpClientOptions) {
    this.provider = options.provider;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.auth = options.auth;
    this.logger = options.logger.child({ provider: options.provider });
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.retry = { ...DEFAULT_RETRY_POLICY, ...(options.retry ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.minIntervalMs = options.minIntervalMs ?? 100;
    this.concurrency = options.concurrency ?? 4;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.mapError = options.mapError ?? mapHttpStatus;
  }

  /**
   * Execute a GET with the full reliability pipeline (timeout, bounded retry,
   * backoff+jitter, Retry-After, 401 refresh-replay, pacing, concurrency).
   * Throws a normalized ConnectorError when the retry budget is exhausted.
   */
  async get(spec: GetSpec): Promise<HttpResult> {
    const correlationId = randomUUID();
    const startedAt = Date.now();
    const url = this.buildUrl(spec);
    const logCtx = { operation: spec.operation, correlationId };
    let attempt = 0;
    let refreshed = false;

    for (;;) {
      attempt += 1;
      await this.gate();
      try {
        let res: Response;
        let timedOut = false;
        try {
          const authHeaders = await this.auth.headers();
          const controller = new AbortController();
          const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, spec.timeoutMs ?? this.timeoutMs);
          try {
            res = await this.fetchImpl(url, {
              method: 'GET',
              headers: { ...authHeaders, accept: 'application/json', 'x-correlation-id': correlationId },
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
        } catch (fetchErr) {
          // An AuthStrategy may fail to produce headers at all (e.g. Zoho's
          // token strategy raising AuthenticationError when the grant is dead).
          // That error is already normalized, so propagate it unchanged instead
          // of misclassifying it as a network failure and burning retries on a
          // problem that is not transient.
          if (isConnectorError(fetchErr)) throw fetchErr;
          const err = timedOut
            ? new TimeoutError({
                provider: this.provider,
                operation: spec.operation,
                correlationId,
                message: `Timed out after ${spec.timeoutMs ?? this.timeoutMs}ms on ${spec.operation}`,
                hint: 'The upstream did not respond in time. This is usually transient.',
              })
            : new NetworkError({
                provider: this.provider,
                operation: spec.operation,
                correlationId,
                message: `Network failure during ${spec.operation} (${fetchErr instanceof Error ? fetchErr.name : 'unknown'})`,
                hint: 'Could not reach the upstream. Check connectivity/hostname and retry.',
              });
          if (attempt < this.retry.maxAttempts) {
            const delayMs = computeBackoffMs(attempt, this.retry, { random: this.random });
            this.logger.warn('http_retry', { ...logCtx, attempt, delayMs, errorCategory: err.code });
            await this.sleep(delayMs);
            continue;
          }
          err.attempts = attempt;
          this.logger.error('http_failure', {
            ...logCtx,
            attempts: attempt,
            latencyMs: Date.now() - startedAt,
            errorCode: err.code,
            statusCategory: 'network',
          });
          throw err;
        }


        this.logger.debug('http_attempt', { ...logCtx, attempt, status: res.status, path: spec.path });

        // --- success ---------------------------------------------------------
        if (res.status >= 200 && res.status < 300) {
          const text = await res.text();
          let json: unknown = null;
          if (text.length > 0) {
            try {
              json = JSON.parse(text) as unknown;
            } catch {
              const err = new UpstreamResponseError({
                provider: this.provider,
                operation: spec.operation,
                correlationId,
                status: res.status,
                message: `Upstream returned malformed JSON on ${spec.operation} (not retried)`,
                hint: 'The response body was not valid JSON. Retrying is unlikely to help.',
              });
              err.attempts = attempt;
              this.logger.error('http_failure', {
                ...logCtx,
                attempts: attempt,
                latencyMs: Date.now() - startedAt,
                errorCode: err.code,
                statusCategory: '2xx',
              });
              throw err;
            }
          }
          this.logger.info('http_success', {
            ...logCtx,
            attempts: attempt,
            latencyMs: Date.now() - startedAt,
            statusCategory: '2xx',
            queryKeys: Object.keys(spec.query ?? {}),
          });
          return { status: res.status, json, headers: res.headers, attempts: attempt, durationMs: Date.now() - startedAt, correlationId };
        }

        // --- mapped error ----------------------------------------------------
        const status = res.status;
        const errText = await res.text();
        let body: unknown = null;
        if (errText.length > 0) {
          try {
            body = JSON.parse(errText) as unknown;
          } catch {
            body = null; // non-JSON error body: map from status only
          }
        }
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));

        // 401 -> provider may refresh a token and replay exactly once.
        if (status === 401 && !refreshed && this.auth.refresh !== undefined) {
          refreshed = true;
          const didRefresh = await this.auth.refresh().catch(() => false);
          if (didRefresh) {
            this.logger.warn('http_auth_refresh', { ...logCtx, attempt });
            continue;
          }
        }

        const err = this.mapError({
          provider: this.provider,
          status,
          detail: extractUpstreamErrorDetail(body),
          body,
          operation: spec.operation,
          correlationId,
          retryAfterMs,
        });

        const retryable = isRetryableStatus(status);
        const retryAfterTooLong = retryAfterMs !== undefined && retryAfterMs > this.retry.maxRetryAfterMs;
        if (retryable && attempt < this.retry.maxAttempts && !retryAfterTooLong) {
          const delayMs = computeBackoffMs(attempt, this.retry, { retryAfterMs, random: this.random });
          this.logger.warn('http_retry', {
            ...logCtx,
            attempt,
            delayMs,
            status,
            rateLimited: status === 429,
            retryAfterMs,
          });
          await this.sleep(delayMs);
          continue;
        }

        err.attempts = attempt;
        this.logger.error('http_failure', {
          ...logCtx,
          attempts: attempt,
          latencyMs: Date.now() - startedAt,
          status,
          statusCategory: statusCategory(status),
          errorCode: err.code,
          rateLimited: status === 429,
        });
        throw err;
      } finally {
        this.release();
      }
    }
  }

  private buildUrl(spec: GetSpec): string {
    const url = new URL(`${this.baseUrl}${spec.path}`);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Pacing (min interval between starts) + concurrency limit. In-process only. */
  private async gate(): Promise<void> {
    if (this.minIntervalMs > 0) {
      const now = Date.now();
      const startAt = Math.max(now, this.nextStartAt);
      this.nextStartAt = startAt + this.minIntervalMs;
      if (startAt > now) await this.sleep(startAt - now);
    }
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

