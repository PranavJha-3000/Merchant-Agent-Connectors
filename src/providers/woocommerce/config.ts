import { z } from 'zod';
import { ConfigurationError } from '../../core/errors.ts';

/**
 * WooCommerce configuration.
 *
 * Verified: https://developer.woocommerce.com/docs/apis/rest-api/ (v3 at
 * /wp-json/wc/v3 on the merchant's own store origin) and
 * https://developer.woocommerce.com/docs/apis/rest-api/authentication/
 * (keys from WooCommerce > Settings > Advanced > REST API; over HTTPS the
 * consumer key/secret go in an HTTP Basic header - "The username when
 * authenticating is your consumer key. The password when authenticating is
 * your consumer secret.") - checked 2026-10-02.
 *
 * V1 policy: HTTPS only. Plain-HTTP stores would require OAuth 1.0a request
 * signing, which is documented upstream but deliberately NOT implemented
 * (read-only work over TLS with a Read-only key is the safer credential story).
 *
 * Config values come from the environment only; they are validated before any
 * network I/O and never logged (see core/redact.ts).
 */

const HTTPS_ORIGIN_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/i;

export const woocommerceConfigSchema = z.object({
  baseUrl: z
    .string()
    .regex(
      HTTPS_ORIGIN_PATTERN,
      'must be the store origin over HTTPS with no path (e.g. "https://shop.example.com"), not an http:// URL and not a /wp-json/... path',
    ),
  consumerKey: z.string().min(1, 'WooCommerce consumer key must not be empty'),
  consumerSecret: z.string().min(1, 'WooCommerce consumer secret must not be empty'),
});

export type WooCommerceConfig = z.infer<typeof woocommerceConfigSchema>;

export const WOOCOMMERCE_CONFIG_KEYS = [
  'WOOCOMMERCE_BASE_URL',
  'WOOCOMMERCE_CONSUMER_KEY',
  'WOOCOMMERCE_CONSUMER_SECRET',
] as const;

/** Fixture-mode credentials: syntactically valid, unusable against the real API. */
export const FIXTURE_WOOCOMMERCE_CONFIG: WooCommerceConfig = {
  baseUrl: 'https://store.fixture.example',
  consumerKey: 'ck_fixture_not_a_real_key',
  consumerSecret: 'cs_fixture_not_a_real_secret',
};

/** Verified base path: REST API v3 lives at /wp-json/wc/v3 on the store origin. */
export function woocommerceApiBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/wp-json/wc/v3`;
}

export function woocommerceConfigFromEnv(env: Record<string, string | undefined>): WooCommerceConfig {
  const missing = WOOCOMMERCE_CONFIG_KEYS.filter((k) => !env[k] || env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new ConfigurationError({
      provider: 'woocommerce',
      operation: 'config',
      message: `Missing required environment variables: ${missing.join(', ')}`,
      hint: 'Copy .env.example to .env and fill in the WooCommerce values, or run in fixture mode (CONNECTOR_MODE=fixture).',
    });
  }
  const parsed = woocommerceConfigSchema.safeParse({
    baseUrl: env['WOOCOMMERCE_BASE_URL'],
    consumerKey: env['WOOCOMMERCE_CONSUMER_KEY'],
    consumerSecret: env['WOOCOMMERCE_CONSUMER_SECRET'],
  });
  if (!parsed.success) {
    throw new ConfigurationError({
      provider: 'woocommerce',
      operation: 'config',
      message: `Invalid WooCommerce configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      hint: 'WOOCOMMERCE_BASE_URL must be the HTTPS store origin only (https://shop.example.com). V1 does not support plain-HTTP stores (OAuth 1.0a is not implemented).',
    });
  }
  return parsed.data;
}