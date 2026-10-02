import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from '../../src/core/auth.ts';
import {
  AuthenticationError,
  AuthorizationError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  UpstreamResponseError,
  UpstreamUnavailableError,
} from '../../src/core/errors.ts';
import { HttpClient, type FetchLike } from '../../src/core/http.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';

const SECRET_KEY = 'fd_test_key_never_log_me';

function makeClient(overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const sleeps: number[] = [];
  const logger = createMemoryLogger();
  const client = new HttpClient({
    provider: 'test',
    baseUrl: 'https://api.test/v1',
    auth: { kind: 'basic-api-key', headers: () => ({ authorization: basicAuthHeader(SECRET_KEY, 'X') }) },
    logger,
    minIntervalMs: 0,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...overrides,
  });
  return { client, sleeps, logger };
}

function jsonResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, { status, headers: { 'content-type': 'application/json', ...(headers ?? {}) } });
}

const spec = { path: '/things', operation: 'test.op' };

/** Await a rejection and return it typed (Promise.catch widens the union otherwise). */
async function rejects<T>(promise: Promise<unknown>): Promise<T> {
  try {
    await promise;
  } catch (e) {
    return e as T;
  }
  throw new Error('expected the promise to reject');
}

describe('HttpClient success path', () => {
  it('returns parsed JSON with attempts and correlation id', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { ok: true });
    const { client, logger } = makeClient({ fetchImpl });
    const result = await client.get(spec);
    expect(result.json).toEqual({ ok: true });
    expect(result.attempts).toBe(1);
    expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(logger.entries.some((e) => e.message === 'http_success')).toBe(true);
  });
});

describe('HttpClient non-retryable statuses', () => {
  it.each([
    [401, AuthenticationError, 'AUTHENTICATION_ERROR'],
    [403, AuthorizationError, 'AUTHORIZATION_ERROR'],
    [404, NotFoundError, 'NOT_FOUND'],
  ] as const)('maps %i without retrying', async (status, ErrorClass, code) => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(status, { description: 'nope' });
    };
    const { client, sleeps, logger } = makeClient({ fetchImpl });
    await expect(client.get(spec)).rejects.toBeInstanceOf(ErrorClass);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    const failure = logger.entries.find((e) => e.message === 'http_failure');
    expect(failure?.fields['errorCode']).toBe(code);
  });

  it('never leaks the API key through a thrown error payload', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(401, { description: 'invalid credentials' });
    const { client } = makeClient({ fetchImpl });
    const err = await rejects<{ toAgentPayload?: () => unknown }>(client.get(spec));
    const serialized = JSON.stringify(err.toAgentPayload?.() ?? err);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(Buffer.from(`${SECRET_KEY}:X`).toString('base64'));
  });
});

describe('HttpClient 429 rate limiting', () => {
  it('honors Retry-After seconds and recovers', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, { description: 'Rate limit exhausted' }, { 'retry-after': '1' })
        : jsonResponse(200, { ok: true });
    };
    const { client, sleeps } = makeClient({ fetchImpl });
    const result = await client.get(spec);
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1_000]); // Retry-After overrides backoff entirely
  });

  it('exhausts the budget into RateLimitError with actionable retryAfterMs', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(429, { description: 'Rate limit exhausted' }, { 'retry-after': '2' });
    const { client, sleeps } = makeClient({ fetchImpl });
    const err = await rejects<RateLimitError>(client.get(spec));
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err!.retryable).toBe(true);
    expect(err!.attempts).toBe(3);
    expect(err!.retryAfterMs).toBe(2_000);
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(err!.toAgentPayload().hint).toContain('2s');
  });

  it('stops immediately when Retry-After exceeds the 60s wait bound', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(429, {}, { 'retry-after': '3600' });
    };
    const { client, sleeps } = makeClient({ fetchImpl });
    const err = await rejects<RateLimitError>(client.get(spec));
    expect(err).toBeInstanceOf(RateLimitError);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(err!.retryAfterMs).toBe(3_600_000);
  });
});

describe('HttpClient 5xx recovery', () => {
  it('retries 500s with exponential backoff and recovers', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return calls < 3 ? jsonResponse(500, { error: 'boom' }) : jsonResponse(200, { ok: true });
    };
    const { client, sleeps } = makeClient({ fetchImpl });
    const result = await client.get(spec);
    expect(result.attempts).toBe(3);
    expect(sleeps).toEqual([250, 500]); // base * 2^(attempt-1), random fixed at 0
  });

  it('maps exhausted 5xx budget to UpstreamUnavailableError', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(503, { error: 'overloaded' });
    };
    const { client, sleeps } = makeClient({ fetchImpl });
    const err = await rejects<UpstreamUnavailableError>(client.get(spec));
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(err!.retryable).toBe(true);
    expect(err!.attempts).toBe(3);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });
});

describe('HttpClient malformed and network failures', () => {
  it('treats malformed JSON on 200 as non-retryable UpstreamResponseError', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, '<html>this is not json</html>');
    };
    const { client, sleeps } = makeClient({ fetchImpl });
    const err = await rejects<UpstreamResponseError>(client.get(spec));
    expect(err).toBeInstanceOf(UpstreamResponseError);
    expect(err!.retryable).toBe(false);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('retries network errors and succeeds', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return jsonResponse(200, { ok: true });
    };
    const { client, sleeps } = makeClient({ fetchImpl });
    const result = await client.get(spec);
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it('exhausts network failures into NetworkError without echoing fetch details', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError(`connect ECONNREFUSED 10.0.0.1:443 ${SECRET_KEY}`);
    };
    const { client } = makeClient({ fetchImpl });
    const err = await rejects<NetworkError>(client.get(spec));
    expect(err).toBeInstanceOf(NetworkError);
    expect(err!.attempts).toBe(3);
    expect(JSON.stringify(err!.toAgentPayload())).not.toContain(SECRET_KEY);
  });

  it('times out a hanging request into TimeoutError', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };
    const { client, sleeps } = makeClient({ fetchImpl, timeoutMs: 15 });
    const err = await rejects<TimeoutError>(client.get(spec));
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err!.attempts).toBe(3);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });
});

describe('HttpClient auth refresh replay', () => {
  it('replays exactly once after auth.refresh succeeds', async () => {
    let calls = 0;
    let refreshes = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(401, {}) : jsonResponse(200, { ok: true });
    };
    const { client } = makeClient({
      fetchImpl,
      auth: {
        kind: 'bearer',
        headers: () => ({ authorization: 'Bearer stale-token-value' }),
        refresh: async () => {
          refreshes += 1;
          return true;
        },
      },
    });
    const result = await client.get(spec);
    expect(result.attempts).toBe(2);
    expect(refreshes).toBe(1);
    expect(calls).toBe(2);
  });

  it('does not retry 401 when no refresh strategy exists', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(401, {});
    };
    const { client } = makeClient({ fetchImpl });
    await expect(client.get(spec)).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toBe(1);
  });
});

describe('HttpClient pacing and concurrency', () => {
  it('spaces request starts by minIntervalMs (accumulating while fake sleep is instant)', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, {});
    const { client, sleeps } = makeClient({ fetchImpl, minIntervalMs: 50 });
    await client.get(spec);
    await client.get(spec);
    await client.get(spec);
    expect(sleeps).toHaveLength(2); // first call starts immediately
    // Fake sleep resolves instantly, so scheduled starts accumulate:
    // 2nd start waits ~50ms, 3rd start waits ~100ms.
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(50);
    expect(sleeps[1]).toBeGreaterThan(50);
    expect(sleeps[1]).toBeLessThanOrEqual(100);
  });

  it('never exceeds the concurrency limit', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl: FetchLike = async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
      return jsonResponse(200, {});
    };
    const { client } = makeClient({ fetchImpl, concurrency: 1 });
    await Promise.all([client.get(spec), client.get(spec), client.get(spec)]);
    expect(maxInflight).toBe(1);
  });
});

describe('HttpClient log safety', () => {
  it('never writes authorization header values or secrets to logs', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(500, {});
    const { client, logger } = makeClient({ fetchImpl });
    await client.get(spec).catch(() => undefined);
    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(Buffer.from(`${SECRET_KEY}:X`).toString('base64'));
    expect(serialized).not.toContain('authorization');
  });

  it('logs operational fields for every attempt lifecycle', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, {});
    const { client, logger } = makeClient({ fetchImpl });
    const result = await client.get(spec);
    const success = logger.entries.find((e) => e.message === 'http_success');
    expect(success?.fields).toMatchObject({
      provider: 'test',
      operation: 'test.op',
      attempts: 1,
      statusCategory: '2xx',
      correlationId: result.correlationId,
    });
    expect(typeof success?.fields['latencyMs']).toBe('number');
  });
});
