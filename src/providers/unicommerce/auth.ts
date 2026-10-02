import { AuthenticationError } from '../../core/errors.ts';
import type { AuthStrategy } from '../../core/auth.ts';
import type { FetchLike } from '../../core/http.ts';
import { UNICOMMERCE_TOKEN_PATH, type UnicommerceConfig } from './config.ts';

/**
 * Unicommerce token strategy (provider-owned, AGENTS.md §8).
 *
 * VERIFIED 2026-10-02 (https://documentation.unicommerce.com/):
 * - `/docs/oauth-refreshtoken.html`: "Endpoint: /oauth/token, Request Type: GET,
 *   Scheme: HTTPS" with mandatory `grant_type` = "refresh_token",
 *   `client_id` = "my-trusted-client" and `refresh_token`; the response is
 *   `{ access_token, token_type: "bearer", refresh_token, expires_in, scope }`
 *   where `expires_in` is the "valid time of access_token in seconds". The same
 *   page warns the refresh token "can only be used till 30 days of first issuance
 *   of access_token".
 * - Every API page documents "Header (Authorization): bearer {access-token}".
 *
 * Because the documented token endpoint is a GET with query parameters, the
 * refresh token necessarily appears in the request URL - that is upstream's
 * documented design, not a choice. The connector therefore keeps tokens in
 * memory only, never logs the token URL or response, parses the response
 * field-by-field so a failure can never echo a token, refreshes proactively
 * before `expires_in`, collapses concurrent refreshes into ONE request
 * (singleflight), and surfaces the 30-day window in the failure hint because that
 * is the documented way this integration dies.
 */
export interface UnicommerceTokenStrategyOptions {
  config: UnicommerceConfig;
  fetchImpl?: FetchLike;
  /** Safety margin: refresh this many ms before the documented expiry. */
  skewMs?: number;
  /** Assumed lifetime when `expires_in` is missing or unusable. */
  fallbackLifetimeMs?: number;
}

/** Only the fields we use are declared; the response is never propagated. */
interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

export class UnicommerceTokenStrategy implements AuthStrategy {
  readonly kind = 'oauth2-unicommerce';

  private readonly config: UnicommerceConfig;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly skewMs: number;
  private readonly fallbackLifetimeMs: number;

  /** In-memory only; never persisted, never logged. */
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  /** Collapses concurrent refreshes into a single token request. */
  private inFlightRefresh: Promise<boolean> | null = null;

  constructor(options: UnicommerceTokenStrategyOptions) {
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
        provider: 'unicommerce',
        operation: 'auth.token',
        correlationId: 'auth',
        message: 'Unicommerce has no valid access token and obtaining one failed.',
        hint:
          'Check UNICOMMERCE_BASE_URL and UNICOMMERCE_REFRESH_TOKEN. Documented constraint: a refresh token "can only be used '
          + 'till 30 days of first issuance of access_token" - obtain a new one via the password grant if it has expired.',
      });
    }
    // VERIFIED header format: Authorization: bearer {access-token}
    return { authorization: `bearer ${this.accessToken}` };
  }

  /**
   * Refresh hook used by the shared HTTP runtime after a 401 (the documented
   * `INVALID_TOKEN` application error surfaces the same way). Forces a real
   * refresh rather than reusing the cached token, then replays once.
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
    // VERIFIED (docs/oauth-refreshtoken.html): GET {baseUrl}/oauth/token with
    // grant_type, client_id and refresh_token as query parameters.
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, '')}${UNICOMMERCE_TOKEN_PATH}`);
    url.searchParams.set('grant_type', 'refresh_token');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('refresh_token', this.config.refreshToken);

    let payload: TokenResponse;
    try {
      const res = await doFetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      // A failed exchange is not retried here: a rejected grant is not transient.
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