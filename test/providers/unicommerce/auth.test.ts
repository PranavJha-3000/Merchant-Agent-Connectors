import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/core/http.ts';
import { UnicommerceTokenStrategy } from '../../../src/providers/unicommerce/auth.ts';
import {
  FIXTURE_UNICOMMERCE_CONFIG,
  UNICOMMERCE_DOCUMENTED_CLIENT_ID,
  UNICOMMERCE_TOKEN_PATH,
  unicommerceConfigFromEnv,
} from '../../../src/providers/unicommerce/config.ts';

/**
 * Unicommerce OAuth tests.
 *
 * Security-critical behavior (AGENTS.md §8/§9):
 * - VERIFIED refresh grant: `GET {base}/oauth/token` with
 *   `grant_type=refresh_token`, `client_id`, `refresh_token`;
 * - VERIFIED header format `Authorization: bearer {access-token}`;
 * - tokens in memory only, proactive refresh from `expires_in`, singleflight;
 * - failure paths never echo the token response;
 * - `client_id` defaults to the documented literal but stays configurable.
 */

interface TokenCall {
  url: string;
  method: string | undefined;
}

function tokenFetch(responses: Array<() => Response>): { fetchImpl: FetchLike; calls: TokenCall[] } {
  const calls: TokenCall[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method });
    const factory = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return factory();
  };
  return { fetchImpl, calls };
}

function okToken(token: string, expiresIn = 3600): () => Response {
  return () =>
    new Response(
      JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: expiresIn, scope: 'read trust write' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

describe('Unicommerce OAuth token strategy', () => {
  it('calls the documented refresh grant and sends the bearer header', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken('1211cf66-d9b3-498b-a8a4-04c76578b72e')]);
    const strategy = new UnicommerceTokenStrategy({ config: FIXTURE_UNICOMMERCE_CONFIG, fetchImpl });

    const headers = await strategy.headers();

    expect(headers['authorization']).toBe('bearer 1211cf66-d9b3-498b-a8a4-04c76578b72e'); // VERIFIED format
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET'); // VERIFIED: the token endpoint is a GET
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(UNICOMMERCE_TOKEN_PATH);
    expect(url.origin).toBe('https://tenant.fixture.example');
    expect(url.searchParams.get('grant_type')).toBe('refresh_token');
    expect(url.searchParams.get('client_id')).toBe(UNICOMMERCE_DOCUMENTED_CLIENT_ID);
    expect(url.searchParams.get('refresh_token')).toBe(FIXTURE_UNICOMMERCE_CONFIG.refreshToken);
  });

  it('caches the token and refreshes proactively before expiry', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken('first-token')]);
    const strategy = new UnicommerceTokenStrategy({ config: FIXTURE_UNICOMMERCE_CONFIG, fetchImpl });
    await strategy.headers();
    await strategy.headers();
    expect(calls).toHaveLength(1); // cached
    expect(strategy.hasCachedToken()).toBe(true);

    // expires_in smaller than the 60s skew forces a proactive refresh.
    let shortCalls = 0;
    const shortLived = new UnicommerceTokenStrategy({
      config: FIXTURE_UNICOMMERCE_CONFIG,
      fetchImpl: async () => {
        shortCalls += 1;
        return okToken('short-token', 1)();
      },
    });
    await shortLived.headers();
    const second = await shortLived.headers();
    expect(second['authorization']).toBe('bearer short-token');
    expect(shortCalls).toBeGreaterThanOrEqual(2);
  });

  it('collapses concurrent refreshes into ONE token request (singleflight)', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken('shared-token')]);
    const strategy = new UnicommerceTokenStrategy({ config: FIXTURE_UNICOMMERCE_CONFIG, fetchImpl });
    const results = await Promise.all([strategy.headers(), strategy.headers(), strategy.headers()]);
    expect(calls).toHaveLength(1);
    for (const headers of results) expect(headers['authorization']).toBe('bearer shared-token');
  });
  it('reports failure without leaking the token response', async () => {
    const httpError = new UnicommerceTokenStrategy({
      config: FIXTURE_UNICOMMERCE_CONFIG,
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    });
    expect(await httpError.refresh()).toBe(false);
    expect(httpError.hasCachedToken()).toBe(false);
    await expect(httpError.headers()).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

    const oauthError = new UnicommerceTokenStrategy({
      config: FIXTURE_UNICOMMERCE_CONFIG,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 200 }),
    });
    expect(await oauthError.refresh()).toBe(false);

    const offline = new UnicommerceTokenStrategy({
      config: FIXTURE_UNICOMMERCE_CONFIG,
      fetchImpl: async () => {
        throw new TypeError('network down');
      },
    });
    expect(await offline.refresh()).toBe(false);

    const empty = new UnicommerceTokenStrategy({
      config: FIXTURE_UNICOMMERCE_CONFIG,
      fetchImpl: async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }),
    });
    expect(await empty.refresh()).toBe(false);
  });

  it('refresh() discards a cached token so the replay can succeed', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken('first-token'), okToken('second-token')]);
    const strategy = new UnicommerceTokenStrategy({ config: FIXTURE_UNICOMMERCE_CONFIG, fetchImpl });
    expect((await strategy.headers())['authorization']).toBe('bearer first-token');
    expect(await strategy.refresh()).toBe(true);
    expect((await strategy.headers())['authorization']).toBe('bearer second-token');
    expect(calls).toHaveLength(2);
  });

  it('config defaults client_id to the documented literal and validates the tenant URL', () => {
    // Only BASE_URL + REFRESH_TOKEN are required.
    const parsed = unicommerceConfigFromEnv({
      UNICOMMERCE_BASE_URL: 'https://acme.unicommerce.com',
      UNICOMMERCE_REFRESH_TOKEN: 'rt-value',
    });
    expect(parsed.clientId).toBe('my-trusted-client');
    expect(parsed.baseUrl).toBe('https://acme.unicommerce.com');

    expect(
      unicommerceConfigFromEnv({
        UNICOMMERCE_BASE_URL: 'https://acme.unicommerce.com',
        UNICOMMERCE_REFRESH_TOKEN: 'rt-value',
        UNICOMMERCE_CLIENT_ID: 'other-client',
      }).clientId,
    ).toBe('other-client');

    // Missing values and a non-HTTPS origin are rejected before any I/O.
    expect(() => unicommerceConfigFromEnv({})).toThrowError(/Missing required/);
    expect(() =>
      unicommerceConfigFromEnv({ UNICOMMERCE_BASE_URL: 'http://acme.unicommerce.com', UNICOMMERCE_REFRESH_TOKEN: 'r' }),
    ).toThrowError(/Invalid Unicommerce configuration/);
    expect(() =>
      unicommerceConfigFromEnv({
        UNICOMMERCE_BASE_URL: 'https://acme.unicommerce.com/services/rest',
        UNICOMMERCE_REFRESH_TOKEN: 'r',
      }),
    ).toThrowError(/Invalid Unicommerce configuration/);
  });
});
