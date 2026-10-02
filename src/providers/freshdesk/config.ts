import { z } from 'zod';
import { ConfigurationError } from '../../core/errors.ts';

/**
 * Freshdesk configuration.
 *
 * Verified: https://developers.freshdesk.com/api/ — base URL is
 * https://{domain}.freshdesk.com/api/v2 where {domain} is the helpdesk
 * subdomain; auth is HTTP Basic with the API key as username (any password).
 * Config values come from the environment only; they are validated before any
 * network I/O and never logged (see core/redact.ts).
 */

export const freshdeskConfigSchema = z.object({
  domain: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]{0,62}$/i,
      'must be the Freshdesk subdomain only (e.g. "acme" for acme.freshdesk.com), no scheme or slashes',
    ),
  apiKey: z.string().min(1, 'Freshdesk API key must not be empty'),
});

export type FreshdeskConfig = z.infer<typeof freshdeskConfigSchema>;

export const FRESHDESK_CONFIG_KEYS = ['FRESHDESK_DOMAIN', 'FRESHDESK_API_KEY'] as const;

/** Fixture-mode credentials: syntactically valid, unusable against the real API. */
export const FIXTURE_FRESHDESK_CONFIG: FreshdeskConfig = {
  domain: 'fixture-helpdesk',
  apiKey: 'fd_fixture_key_not_a_real_secret',
};

export function freshdeskBaseUrl(domain: string): string {
  return `https://${domain}.freshdesk.com/api/v2`;
}

export function freshdeskConfigFromEnv(env: Record<string, string | undefined>): FreshdeskConfig {
  const missing = FRESHDESK_CONFIG_KEYS.filter((k) => !env[k] || env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new ConfigurationError({
      provider: 'freshdesk',
      operation: 'config',
      message: `Missing required environment variables: ${missing.join(', ')}`,
      hint: 'Copy .env.example to .env and fill in the Freshdesk values, or run in fixture mode (CONNECTOR_MODE=fixture).',
    });
  }
  const parsed = freshdeskConfigSchema.safeParse({ domain: env['FRESHDESK_DOMAIN'], apiKey: env['FRESHDESK_API_KEY'] });
  if (!parsed.success) {
    throw new ConfigurationError({
      provider: 'freshdesk',
      operation: 'config',
      message: `Invalid Freshdesk configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      hint: 'Check FRESHDESK_DOMAIN — it must be the bare subdomain, not a URL.',
    });
  }
  return parsed.data;
}
