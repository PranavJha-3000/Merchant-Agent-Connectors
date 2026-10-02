import { basicAuthHeader, type AuthStrategy } from '../../core/auth.ts';
import { HttpClient } from '../../core/http.ts';
import type { ProviderModule } from '../../core/registry.ts';
import { createFixtureFetch } from '../../fixtures/transport.ts';
import { FreshdeskAdapter } from './client.ts';
import { FRESHDESK_CONFIG_KEYS, FIXTURE_FRESHDESK_CONFIG, freshdeskBaseUrl, freshdeskConfigFromEnv } from './config.ts';
import { mapFreshdeskHttpError } from './errors.ts';
import { freshdeskFixtureRoutes } from './routes.ts';
import { buildFreshdeskTools } from './tools.ts';

/**
 * Freshdesk provider module — the reference implementation.
 *
 * Authentication (verified): HTTP Basic, API key as username, any string as
 * password (developers.freshdesk.com/api → Authentication). The key exists
 * only inside header construction; it is never logged (core/redact.ts).
 */
export const freshdeskModule: ProviderModule = {
  id: 'freshdesk',
  displayName: 'Freshdesk',
  capabilities: ['tickets.list', 'tickets.get', 'tickets.search', 'tickets.conversations'],
  configKeys: FRESHDESK_CONFIG_KEYS,
  buildTools(ctx) {
    const config = ctx.mode === 'live' ? freshdeskConfigFromEnv(ctx.env) : FIXTURE_FRESHDESK_CONFIG;
    const apiKey = config.apiKey;
    const auth: AuthStrategy = {
      kind: 'basic-api-key',
      headers: () => ({ authorization: basicAuthHeader(apiKey, 'X') }),
    };

    const fetchImpl =
      ctx.fetchImpl ?? (ctx.mode === 'fixture' ? createFixtureFetch({ routes: freshdeskFixtureRoutes() }) : undefined);

    const http = new HttpClient({
      provider: 'freshdesk',
      baseUrl: freshdeskBaseUrl(config.domain),
      auth,
      logger: ctx.logger,
      ...(fetchImpl ? { fetchImpl } : {}),
      mapError: mapFreshdeskHttpError,
      // Live mode gets gentle pacing; fixture mode stays instant and deterministic.
      minIntervalMs: ctx.mode === 'live' ? 100 : 0,
    });

    return buildFreshdeskTools(new FreshdeskAdapter(http));
  },
};
