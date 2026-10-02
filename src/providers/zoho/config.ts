import { z } from 'zod';
import { ConfigurationError } from '../../core/errors.ts';

/**
 * Zoho Inventory configuration.
 *
 * Verified 2026-10-02:
 * - https://www.zoho.com/inventory/api/v1/oauth/ — OAuth 2.0; access token is
 *   sent as `Authorization: Zoho-oauthtoken {access_token}`; the token endpoint
 *   is `https://accounts.<dc>/oauth/v2/token` with
 *   `grant_type=refresh_token&refresh_token=..&client_id=..&client_secret=..`
 *   (the docs' data-center table for OAuth lists: US .com -> accounts.zoho.com,
 *   Europe .eu -> accounts.zoho.eu, India .in -> accounts.zoho.in,
 *   Australia .com.au -> accounts.zoho.com.au, Canada .ca -> accounts.zohocloud.ca
 *   — note Canada is NOT accounts.zoho.ca, hence the explicit table below).
 * - https://www.zoho.com/inventory/api/v1/introduction ("Multiple Data
 *   Centers") — API base URIs, e.g. https://www.zohoapis.com/inventory/,
 *   https://www.zohoapis.in/inventory/, https://www.zohoapis.eu/inventory/,
 *   https://www.zohoapis.com.au/inventory/, https://www.zohoapis.ca/inventory/.
 * - `organization_id` "should be sent in with every API request" (Organization ID
 *   section) — so it is configuration, never an agent-supplied argument.
 *
 * Only the five data centers whose BOTH endpoints are documented above are
 * accepted. .jp / .sa / .com.cn appear in the API-host table but their accounts
 * hosts are not documented on the pages we verified, so guessing
 * `accounts.zoho.jp` would be speculative; those DCs are rejected with a clear
 * ConfigurationError instead (docs/providers/zoho-inventory.md).
 *
 * Secrets come from the environment only, are never logged, and are never
 * persisted to disk (core/redact.ts, AGENTS.md §8/§9).
 */

export const ZOHO_DATA_CENTERS = ['com', 'in', 'eu', 'com.au', 'ca'] as const;
export type ZohoDataCenter = (typeof ZOHO_DATA_CENTERS)[number];

/** API base per data center — VERIFIED "Multiple Data Centers" table. */
const API_HOSTS: Record<ZohoDataCenter, string> = {
  com: 'https://www.zohoapis.com',
  in: 'https://www.zohoapis.in',
  eu: 'https://www.zohoapis.eu',
  'com.au': 'https://www.zohoapis.com.au',
  ca: 'https://www.zohoapis.ca',
};

/**
 * OAuth token host per data center — VERIFIED OAuth data-center table.
 * Canada is `accounts.zohocloud.ca` in the docs, which is why these are spelled
 * out instead of being derived by string interpolation.
 */
const ACCOUNTS_HOSTS: Record<ZohoDataCenter, string> = {
  com: 'https://accounts.zoho.com',
  in: 'https://accounts.zoho.in',
  eu: 'https://accounts.zoho.eu',
  'com.au': 'https://accounts.zoho.com.au',
  ca: 'https://accounts.zohocloud.ca',
};

/** `${apiDomain}` value Zoho expects in a refresh-token request (same host as API). */
function apiDomainFor(dc: ZohoDataCenter): string {
  const host = new URL(API_HOSTS[dc]).host;
  return host.startsWith('www.') ? host.slice(4) : host;
}

export function zohoApiBaseUrl(dc: ZohoDataCenter): string {
  return `${API_HOSTS[dc]}/inventory/v1`;
}

export function zohoAccountsBaseUrl(dc: ZohoDataCenter): string {
  return ACCOUNTS_HOSTS[dc];
}

export const zohoConfigSchema = z.object({
  dataCenter: z.enum(ZOHO_DATA_CENTERS),
  organizationId: z
    .string()
    .regex(/^\d+$/, 'must be the numeric organization_id (Zoho sends it as a string parameter)'),
  clientId: z.string().min(1, 'Zoho OAuth client id must not be empty'),
  clientSecret: z.string().min(1, 'Zoho OAuth client secret must not be empty'),
  /** Long-lived grant obtained once via the documented authorization-code flow. */
  refreshToken: z.string().min(1, 'Zoho OAuth refresh token must not be empty'),
});
export type ZohoConfig = z.infer<typeof zohoConfigSchema>;

export const ZOHO_CONFIG_KEYS = [
  'ZOHO_DATA_CENTER',
  'ZOHO_ORGANIZATION_ID',
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
] as const;

/** Fixture-mode credentials: syntactically valid, unusable against the real API. */
export const FIXTURE_ZOHO_CONFIG: ZohoConfig = {
  dataCenter: 'com',
  organizationId: '10234695',
  clientId: '1000.fixtureclientid',
  clientSecret: 'fixture_client_secret_not_a_real_value',
  refreshToken: '1000.fixturerefreshtoken.not-a-real-value',
};

export function zohoConfigFromEnv(env: Record<string, string | undefined>): ZohoConfig {
  const missing = ZOHO_CONFIG_KEYS.filter((k) => !env[k] || env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new ConfigurationError({
      provider: 'zoho-inventory',
      operation: 'config',
      message: `Missing required environment variables: ${missing.join(', ')}`,
      hint: 'Copy .env.example to .env and fill in the ZOHO_* values, or run in fixture mode (CONNECTOR_MODE=fixture).',
    });
  }
  const parsed = zohoConfigSchema.safeParse({
    dataCenter: env['ZOHO_DATA_CENTER'],
    organizationId: env['ZOHO_ORGANIZATION_ID'],
    clientId: env['ZOHO_CLIENT_ID'],
    clientSecret: env['ZOHO_CLIENT_SECRET'],
    refreshToken: env['ZOHO_REFRESH_TOKEN'],
  });
  if (!parsed.success) {
    throw new ConfigurationError({
      provider: 'zoho-inventory',
      operation: 'config',
      message: `Invalid Zoho Inventory configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      hint:
        `ZOHO_DATA_CENTER must be one of ${ZOHO_DATA_CENTERS.join(', ')} (the data centers with both a documented API host and a documented accounts host). `
        + 'ZOHO_ORGANIZATION_ID is the numeric id from the Zoho Inventory admin console (Manage Organizations) or GET /organizations.',
    });
  }
  return parsed.data;
}