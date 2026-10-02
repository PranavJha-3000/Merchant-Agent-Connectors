import { z } from 'zod';
import { ConfigurationError } from '../../core/errors.ts';

/**
 * Unicommerce configuration.
 *
 * Verified 2026-10-02 (https://documentation.unicommerce.com/):
 * - `/docs/url-details.html` - "Sample URL https://{tenant}.unicommerce.com/
 *   {endpoint}?{query parameters}" where "{tenant}: Uniware account code which
 *   comes in URL after login into Uniware". So the base URL is tenant-specific
 *   and always HTTPS (every API page states "Scheme: HTTPS").
 * - `/docs/oauth-refreshtoken.html` - "GET /oauth/token" with
 *   `grant_type=refresh_token`, `client_id` (documented value
 *   "my-trusted-client") and `refresh_token`; response carries `access_token`,
 *   `token_type` ("bearer") and `expires_in` (seconds). The refresh token
 *   "can only be used till 30 days of first issuance of access_token".
 * - `/docs/oauth2.html` - the initial password grant also returns a
 *   `refresh_token`, which is why V1 only needs that one long-lived value.
 *
 * V1 deliberately does NOT take the tenant login password: the password grant
 * is documented but is a one-time operator step, and keeping a Uniware password
 * out of the connector is a better credential story (see docs/limitations.md).
 *
 * Secrets come from the environment only, are never logged and never persisted.
 */

/** Documented mandatory `client_id` value (docs: "my-trusted-client"). */
export const UNICOMMERCE_DOCUMENTED_CLIENT_ID = 'my-trusted-client';

/** https://host with no path/query; tenant codes are alphanumeric with dashes. */
const HTTPS_ORIGIN_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/i;

export const unicommerceConfigSchema = z.object({
  /** Tenant base URL, e.g. https://acme.unicommerce.com (no trailing path). */
  baseUrl: z
    .string()
    .regex(HTTPS_ORIGIN_PATTERN, 'must be the tenant origin over HTTPS with no path (e.g. "https://acme.unicommerce.com")'),
  /** Defaults to the documented literal; overridable for tenants that differ. */
  clientId: z.string().min(1, 'Unicommerce client_id must not be empty'),
  refreshToken: z.string().min(1, 'Unicommerce refresh token must not be empty'),
});
export type UnicommerceConfig = z.infer<typeof unicommerceConfigSchema>;

export const UNICOMMERCE_CONFIG_KEYS = ['UNICOMMERCE_BASE_URL', 'UNICOMMERCE_REFRESH_TOKEN'] as const;
/** Optional: `client_id` has a documented default, so it is never required. */
export const UNICOMMERCE_OPTIONAL_CONFIG_KEYS = ['UNICOMMERCE_CLIENT_ID'] as const;

/** Fixture-mode credentials: syntactically valid, unusable against the real API. */
export const FIXTURE_UNICOMMERCE_CONFIG: UnicommerceConfig = {
  baseUrl: 'https://tenant.fixture.example',
  clientId: UNICOMMERCE_DOCUMENTED_CLIENT_ID,
  refreshToken: 'fixture-refresh-token-not-a-real-value',
};

/** VERIFIED sale-order endpoints (docs/saleorder-search.html, saleorder-get.html). */
export const UNICOMMERCE_SALE_ORDER_SEARCH_PATH = '/services/rest/v1/oms/saleOrder/search';
export const UNICOMMERCE_SALE_ORDER_GET_PATH = '/services/rest/v1/oms/saleorder/get';
/** VERIFIED token endpoint (docs/oauth2.html, oauth-refreshtoken.html). */
export const UNICOMMERCE_TOKEN_PATH = '/oauth/token';

export function unicommerceConfigFromEnv(env: Record<string, string | undefined>): UnicommerceConfig {
  const missing = UNICOMMERCE_CONFIG_KEYS.filter((k) => !env[k] || env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new ConfigurationError({
      provider: 'unicommerce',
      operation: 'config',
      message: `Missing required environment variables: ${missing.join(', ')}`,
      hint: 'Copy .env.example to .env and fill in the UNICOMMERCE_* values, or run in fixture mode (CONNECTOR_MODE=fixture).',
    });
  }
  const parsed = unicommerceConfigSchema.safeParse({
    baseUrl: env['UNICOMMERCE_BASE_URL'],
    clientId: (env['UNICOMMERCE_CLIENT_ID'] ?? '').trim() || UNICOMMERCE_DOCUMENTED_CLIENT_ID,
    refreshToken: env['UNICOMMERCE_REFRESH_TOKEN'],
  });
  if (!parsed.success) {
    throw new ConfigurationError({
      provider: 'unicommerce',
      operation: 'config',
      message: `Invalid Unicommerce configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      hint: 'UNICOMMERCE_BASE_URL must be the tenant origin only, e.g. https://yourtenant.unicommerce.com (docs: https://{tenant}.unicommerce.com).',
    });
  }
  return parsed.data;
}