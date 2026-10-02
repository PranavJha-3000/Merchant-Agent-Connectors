import { HttpClient } from '../../core/http.ts';
import type { ProviderModule } from '../../core/registry.ts';
import { createFixtureFetch } from '../../fixtures/transport.ts';
import { ZohoTokenStrategy } from './auth.ts';
import { ZohoInventoryAdapter } from './client.ts';
import { FIXTURE_ZOHO_CONFIG, ZOHO_CONFIG_KEYS, zohoApiBaseUrl, zohoConfigFromEnv } from './config.ts';
import { mapZohoHttpError } from './errors.ts';
import { zohoFixtureRoutes } from './routes.ts';
import { buildZohoTools } from './tools.ts';

/**
 * Zoho Inventory provider module.
 *
 * Authentication (VERIFIED: https://www.zoho.com/inventory/api/v1/oauth/,
 * checked 2026-10-02): OAuth 2.0 with a long-lived refresh token obtained once
 * through the documented authorization-code flow; access tokens are sent as
 * `Authorization: Zoho-oauthtoken <token>` and exchanged at
 * `<accounts base>/oauth/v2/token` with `grant_type=refresh_token`.
 *
 * The provider owns every OAuth behavior (ZohoTokenStrategy): in-memory token
 * state, proactive refresh before the documented expiry, singleflight refresh,
 * and the refresh-and-replay-once hook the shared HTTP layer calls after a 401
 * ("401 Unauthorized (Invalid AuthToken)"). Nothing is persisted to disk and no
 * token ever reaches a log, an error payload, a URL or a tool response
 * (core/redact.ts, AGENTS.md §8/§9).
 *
 * `organization_id` is configuration, appended to every request by the adapter.
 *
 * Only the four data centers whose API host AND accounts host are documented are
 * accepted (see config.ts) - guessing an undocumented host is refused rather
 * than attempted.
 */
export const zohoInventoryModule: ProviderModule = {
  id: 'zoho-inventory',
  displayName: 'Zoho Inventory',
  capabilities: ['items.list', 'items.get', 'salesorders.list', 'salesorders.get'],
  configKeys: ZOHO_CONFIG_KEYS,
  buildTools(ctx) {
    const config = ctx.mode === 'live' ? zohoConfigFromEnv(ctx.env) : FIXTURE_ZOHO_CONFIG;

    const fetchImpl =
      ctx.fetchImpl ?? (ctx.mode === 'fixture' ? createFixtureFetch({ routes: zohoFixtureRoutes() }) : undefined);

    // The same transport serves data calls and the token exchange, so tests can
    // observe both without touching the network.
    const auth = new ZohoTokenStrategy({
      config,
      ...(fetchImpl ? { fetchImpl } : {}),
    });

    const http = new HttpClient({
      provider: 'zoho-inventory',
      baseUrl: zohoApiBaseUrl(config.dataCenter),
      auth,
      logger: ctx.logger,
      ...(fetchImpl ? { fetchImpl } : {}),
      mapError: mapZohoHttpError,
      // VERIFIED "API Call Limit": 100 requests/minute/organization. Pacing at
      // ~700ms keeps a single process comfortably inside that window; the daily
      // plan quota (1000-10000/day) is a merchant budget, not something pacing
      // can fix, so it is surfaced as a 429 hint instead.
      minIntervalMs: ctx.mode === 'live' ? 700 : 0,
    });

    return buildZohoTools(new ZohoInventoryAdapter(http, config.organizationId));
  },
};