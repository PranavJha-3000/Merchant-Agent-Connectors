import { describe, expect, it } from 'vitest';
import { ZohoTokenStrategy } from '../../../src/providers/zoho/auth.ts';
import { FIXTURE_ZOHO_CONFIG, zohoAccountsBaseUrl, zohoApiBaseUrl } from '../../../src/providers/zoho/config.ts';
import type { FetchLike } from '../../../src/core/http.ts';

/**
 * Zoho OAuth token-strategy tests.
 *
 * The security-critical behavior lives here (AGENTS.md §8/§9):
 * - VERIFIED header format `Authorization: Zoho-oauthtoken <token>`;
 * - VERIFIED refresh-token exchange parameters, sent as a form body so secrets
 *   never appear in a URL;
 * - proactive refresh before the documented expiry;
 * - singleflight: N concurrent callers cause exactly ONE token request;
 * - failure paths never propagate the token response.
 */

interface TokenCall {
  url: string;
  method: string | undefined;
  body: string | undefined;
}

function tokenFetch(responses: Array<() => Response>): { fetchImpl: FetchLike; calls: TokenCall[] } {
  const calls: TokenCall[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: typeof init.body === 'string' ? init.body : undefined });
    const factory = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return factory();
  };
  return { fetchImpl, calls };
}

function okToken(token: string, expiresIn = 3600): () => Response {
  return () =>
    new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: 'bearer' }), { status: 200 });
}

describe('Zoho OAuth token strategy', () => {
  it('sends the documented header and documented refresh parameters', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken('1000.abc123')]);
    const strategy = new ZohoTokenStrategy({ config: FIXTURE_ZOHO_CONFIG, fetchImpl });

    const headers = await strategy.headers();

    expect(headers['authorization']).toBe('Zoho-oauthtoken 1000.abc123'); // VERIFIED format
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${zohoAccountsBaseUrl('com')}/oauth/v2/token`);
    expect(calls[0]!.method).toBe('POST');
    // Credentials travel in the body, never the URL.
    expect(calls[0]!.url).not.toContain('client_secret');
    expect(calls[0]!.url).not.toContain('refresh_token');
    const body = new URLSearchParams(calls[0]!.body!);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(FIXTURE_ZOHO_CONFIG.clientId);
    expect(body.get('refresh_token')).toBe(FIXTURE_ZOHO_CONFIG.refreshToken);
    // Read-only scopes are requested explicitly.
    expect(body.get('scope')).toContain('ZohoInventory.items.READ');
    expect(body.get('scope')).toContain('ZohoInventory.salesorders.READ');
  });

  it('caches the token across calls and refreshes proactively before expiry', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken('1000.first', 3600)]);
    const strategy = new ZohoTokenStrategy({ config: FIXTURE_ZOHO_CONFIG, fetchImpl });

    await strategy.headers();
    await strategy.headers();
    expect(calls).toHaveLength(1); // cached, no second exchange
    expect(strategy.hasCachedToken()).toBe(true);

    // A lifetime shorter than the 60s skew forces a proactive refresh.
    const shortCalls: TokenCall[] = [];
    const shortLived = new ZohoTokenStrategy({
      config: FIXTURE_ZOHO_CONFIG,
      fetchImpl: async (url, init) => {
        shortCalls.push({ url, method: init.method, body: undefined });
        return okToken('1000.short', 1)();
      },
    });
    await shortLived.headers();
    const second = await shortLived.headers();
    expect(second['authorization']).toBe('Zoho-oauthtoken 1000.short');
    expect(shortCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('collapses concurrent refreshes into ONE token request (singleflight)', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken('1000.shared')]);
    const strategy = new ZohoTokenStrategy({ config: FIXTURE_ZOHO_CONFIG, fetchImpl });

    const results = await Promise.all([strategy.headers(), strategy.headers(), strategy.headers(), strategy.headers()]);

    expect(calls).toHaveLength(1); // not four exchanges
    for (const headers of results) expect(headers['authorization']).toBe('Zoho-oauthtoken 1000.shared');
  });
  it('reports failure instead of leaking the token response', async () => {
    const failing = new ZohoTokenStrategy({
      config: FIXTURE_ZOHO_CONFIG,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 }),
    });
    expect(await failing.refresh()).toBe(false);
    expect(failing.hasCachedToken()).toBe(false);
    await expect(failing.headers()).rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR' });

    const errorBody = new ZohoTokenStrategy({
      config: FIXTURE_ZOHO_CONFIG,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 200 }),
    });
    expect(await errorBody.refresh()).toBe(false);

    const offline = new ZohoTokenStrategy({
      config: FIXTURE_ZOHO_CONFIG,
      fetchImpl: async () => {
        throw new TypeError('network down');
      },
    });
    expect(await offline.refresh()).toBe(false);

    const empty = new ZohoTokenStrategy({
      config: FIXTURE_ZOHO_CONFIG,
      fetchImpl: async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }),
    });
    expect(await empty.refresh()).toBe(false);
  });

  it('refresh() forces a NEW token even when one is cached', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken('1000.first'), okToken('1000.second')]);
    const strategy = new ZohoTokenStrategy({ config: FIXTURE_ZOHO_CONFIG, fetchImpl });

    expect((await strategy.headers())['authorization']).toBe('Zoho-oauthtoken 1000.first');
    // The hook the HTTP layer calls after a 401: the cached token is discarded,
    // not reused, otherwise the replay would fail identically.
    expect(await strategy.refresh()).toBe(true);
    expect((await strategy.headers())['authorization']).toBe('Zoho-oauthtoken 1000.second');
    expect(calls).toHaveLength(2);
  });

  it('builds data-center specific hosts from the documented tables', () => {
    expect(zohoApiBaseUrl('com')).toBe('https://www.zohoapis.com/inventory/v1');
    expect(zohoApiBaseUrl('in')).toBe('https://www.zohoapis.in/inventory/v1');
    expect(zohoApiBaseUrl('eu')).toBe('https://www.zohoapis.eu/inventory/v1');
    expect(zohoApiBaseUrl('com.au')).toBe('https://www.zohoapis.com.au/inventory/v1');
    // VERIFIED quirk: Canada's OAuth host is zohocloud.ca, not zoho.ca.
    expect(zohoApiBaseUrl('ca')).toBe('https://www.zohoapis.ca/inventory/v1');
    expect(zohoAccountsBaseUrl('ca')).toBe('https://accounts.zohocloud.ca');
  });
});
