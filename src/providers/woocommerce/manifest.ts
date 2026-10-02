import { basicAuthHeader, type AuthStrategy } from '../../core/auth.ts';
import { HttpClient } from '../../core/http.ts';
import type { ProviderModule } from '../../core/registry.ts';
import { createFixtureFetch } from '../../fixtures/transport.ts';
import { WooCommerceAdapter } from './client.ts';
import {
  FIXTURE_WOOCOMMERCE_CONFIG,
  WOOCOMMERCE_CONFIG_KEYS,
  woocommerceApiBaseUrl,
  woocommerceConfigFromEnv,
} from './config.ts';
import { mapWooCommerceHttpError } from './errors.ts';
import { woocommerceFixtureRoutes } from './routes.ts';
import { buildWooCommerceTools } from './tools.ts';

/**
 * WooCommerce provider module.
 *
 * Authentication (VERIFIED:
 * https://developer.woocommerce.com/docs/apis/rest-api/authentication/ -
 * "Authentication over HTTPS"): HTTP Basic with the consumer key as username
 * and the consumer secret as password, over HTTPS only. The credentials exist
 * only inside header construction; they are never logged (core/redact.ts).
 * Static key => no refresh hook; a 401 is final, never replayed.
 */
export const woocommerceModule: ProviderModule = {
  id: 'woocommerce',
  displayName: 'WooCommerce',
  capabilities: ['orders.list', 'orders.get', 'products.list', 'products.get'],
  configKeys: WOOCOMMERCE_CONFIG_KEYS,
  buildTools(ctx) {
    const config = ctx.mode === 'live' ? woocommerceConfigFromEnv(ctx.env) : FIXTURE_WOOCOMMERCE_CONFIG;
    const auth: AuthStrategy = {
      kind: 'basic-consumer-key',
      headers: () => ({ authorization: basicAuthHeader(config.consumerKey, config.consumerSecret) }),
    };

    const fetchImpl =
      ctx.fetchImpl ??
      (ctx.mode === 'fixture' ? createFixtureFetch({ routes: woocommerceFixtureRoutes() }) : undefined);

    const http = new HttpClient({
      provider: 'woocommerce',
      baseUrl: woocommerceApiBaseUrl(config.baseUrl),
      auth,
      logger: ctx.logger,
      ...(fetchImpl ? { fetchImpl } : {}),
      mapError: mapWooCommerceHttpError,
      // Live mode gets gentle pacing; fixture mode stays instant and deterministic.
      minIntervalMs: ctx.mode === 'live' ? 100 : 0,
    });

    return buildWooCommerceTools(new WooCommerceAdapter(http));
  },
};