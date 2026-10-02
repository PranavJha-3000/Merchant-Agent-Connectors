import { HttpClient } from '../../core/http.ts';
import type { ProviderModule } from '../../core/registry.ts';
import { createFixtureFetch } from '../../fixtures/transport.ts';
import { UnicommerceTokenStrategy } from './auth.ts';
import { UnicommerceAdapter } from './client.ts';
import { FIXTURE_UNICOMMERCE_CONFIG, UNICOMMERCE_CONFIG_KEYS, unicommerceConfigFromEnv } from './config.ts';
import { mapUnicommerceError } from './errors.ts';
import { unicommerceFixtureRoutes } from './routes.ts';
import { buildUnicommerceTools } from './tools.ts';

/**
 * Unicommerce provider module (read-only sale orders).
 *
 * Authentication (VERIFIED 2026-10-02, https://documentation.unicommerce.com/):
 * OAuth 2.0 against `GET {tenant}/oauth/token` using the documented refresh
 * grant (`grant_type=refresh_token`, `client_id` = "my-trusted-client"), with
 * access tokens sent as `Authorization: bearer {access-token}`.
 *
 * The base URL is tenant-specific by design (docs/url-details.html:
 * `https://{tenant}.unicommerce.com/{endpoint}`, where `{tenant}` is the
 * Uniware account code from the login URL), so it is configuration rather than a
 * hardcoded host.
 *
 * The provider owns every token behavior (UnicommerceTokenStrategy): in-memory
 * tokens, proactive refresh from the documented `expires_in`, singleflight
 * refresh, and refresh-and-replay-once for a rejected token. Nothing is
 * persisted to disk and no token reaches a log, error payload or tool response.
 *
 * Rate limits are NOT documented on the pages verified (see
 * docs/providers/unicommerce.md), so live pacing is a conservative
 * connector-imposed value rather than a claimed upstream budget.
 */
export const unicommerceModule: ProviderModule = {
  id: 'unicommerce',
  displayName: 'Unicommerce',
  capabilities: ['saleorders.search', 'saleorders.get'],
  configKeys: UNICOMMERCE_CONFIG_KEYS,
  buildTools(ctx) {
    const config = ctx.mode === 'live' ? unicommerceConfigFromEnv(ctx.env) : FIXTURE_UNICOMMERCE_CONFIG;

    // The same transport serves data calls and the token exchange, so tests can
    // observe both without touching the network.
    const fetchImpl =
      ctx.fetchImpl ?? (ctx.mode === 'fixture' ? createFixtureFetch({ routes: unicommerceFixtureRoutes() }) : undefined);

    const auth = new UnicommerceTokenStrategy({
      config,
      ...(fetchImpl ? { fetchImpl } : {}),
    });

    const http = new HttpClient({
      provider: 'unicommerce',
      baseUrl: config.baseUrl,
      auth,
      logger: ctx.logger,
      ...(fetchImpl ? { fetchImpl } : {}),
      mapError: mapUnicommerceError,
      // UNVERIFIED: no documented rate limit. 1s keeps a bursty agent well under
      // any plausible budget without pretending to know one.
      minIntervalMs: ctx.mode === 'live' ? 1_000 : 0,
    });

    return buildUnicommerceTools(new UnicommerceAdapter(http));
  },
};