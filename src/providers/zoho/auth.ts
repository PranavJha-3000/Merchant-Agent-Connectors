import { AuthenticationError } from '../../core/errors.ts';
import type { AuthStrategy } from '../../core/auth.ts';
import type { FetchLike } from '../../core/http.ts';
import { zohoAccountsBaseUrl, type ZohoConfig } from './config.ts';

/**
 * Zoho Inventory OAuth 2.0 token strategy (provider-owned, see AGENTS.md §8).
 *
 * Verified 2026-10-02 (https://www.zoho.com/inventory/api/v1/oauth/):
 * - requests authenticate with header `Authorization: Zoho-oauthtoken <token>`;
 * - the access token comes from `<accounts base>/oauth/v2/token` with
 *   `grant_type=refresh_token` plus `refresh_token`, `client_id`,
 *   `client_secret` (and `redirect_uri` for apps configured with one);
 * - `access_type=offline` is what yields a refresh token; the access token
 *   "will expire after a particular period (as given in expires_in param in the
 *   response)" (documented as one hour for online access).
 *
 * Security properties (tested in test/providers/zoho/auth.test.ts and
 * test/security/secrets.test.ts):
 * - credentials live in memory only; nothing is written to disk;
 * - the token request is a POST with an RFC 6749 form body, so client_secret and
 *   refresh_token never appear in a URL that could be logged;
 * - the response is parsed by field and every failure path collapses to a
 *   boolean/normalized error - the raw token response is never propagated;
 * - concurrent refreshes collapse into ONE token request (singleflight).
 */

export interface ZohoTokenStrategyOptions {
  config: ZohoConfig;
  /** Injected in tests/fixture mode; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Safety margin: refresh this many ms before the documented expiry. */
  skewMs?: number;
  /** Lifetime assumed when the response omits a usable expires_in. */
  fallbackLifetimeMs?: number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}
export class ZohoTokenStrategy implements AuthStrategy {
  readonly kind = 'oauth2-zoho-inventory';

  private readonly config: ZohoConfig;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly skewMs: number;
  private readonly fallbackLifetimeMs: number;

  /** In-memory only. Never persisted, never logged. */
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  /** Collapses concurrent refreshes into a single token request. */
  private inFlightRefresh: Promise<boolean> | null = null;

  constructor(options: ZohoTokenStrategyOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl;
    this.skewMs = options.skewMs ?? 60_000;
    this.fallbackLifetimeMs = options.fallbackLifetimeMs ?? 3_600_000;
  }

  /** Header for the next request; proactively refreshes an absent/expiring token. */
  async headers(): Promise<Record<string, string>> {
    if (this.accessToken === null || Date.now() >= this.accessTokenExpiresAt - this.skewMs) {
      await this.refreshOnce();
    }
    if (this.accessToken === null) {
      throw new AuthenticationError({
        provider: 'zoho-inventory',
        operation: 'auth.token',
        correlationId: 'auth',
        message: 'Zoho Inventory has no valid access token and obtaining one failed.',
        hint: 'Check ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET and that ZOHO_REFRESH_TOKEN is still valid (it is revoked if the grant is removed).',
      });
    }
    // VERIFIED header format: Authorization: Zoho-oauthtoken {access_token}
    return { authorization: `Zoho-oauthtoken ${this.accessToken}` };
  }

  /**
   * Refresh hook used by the shared HTTP runtime after a 401 (documented as
   * "401 Unauthorized (Invalid AuthToken)"). Forces a real refresh instead of
   * reusing the cached token, then replays the request exactly once.
   */
  async refresh(): Promise<boolean> {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    return this.refreshOnce();
  }

  /** Test/diagnostic seam: whether a token is cached (never its value). */
  hasCachedToken(): boolean {
    return this.accessToken !== null;
  }

  private refreshOnce(): Promise<boolean> {
    this.inFlightRefresh ??= this.requestAccessToken().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async requestAccessToken(): Promise<boolean> {
    const doFetch: FetchLike = this.fetchImpl ?? ((url, init) => fetch(url, init));
    const url = `${zohoAccountsBaseUrl(this.config.dataCenter)}/oauth/v2/token`;
    // RFC 6749 §3.2: token parameters go in a form-encoded body. Zoho's docs
    // show the same parameters as a query string; using the body keeps both
    // secrets out of anything that could be logged (see docs/limitations.md).
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.config.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: 'ZohoInventory.items.READ,ZohoInventory.salesorders.READ',
    }).toString();

    let payload: TokenResponse;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      // A failed exchange is not retried here: the shared layer turns the API
      // 401 into an AuthenticationError, and a bad grant is not transient.
      if (!res.ok) return false;
      payload = (await res.json()) as TokenResponse;
    } catch {
      return false;
    }

    if (typeof payload.error === 'string') return false;
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) return false;

    const expiresIn =
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? payload.expires_in * 1000
        : this.fallbackLifetimeMs;
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + expiresIn;
    return true;
  }
}