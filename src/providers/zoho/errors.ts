import { RateLimitError, ValidationError, type ConnectorError } from '../../core/errors.ts';
import { mapHttpStatus, type MapErrorInput } from '../../core/http.ts';

/**
 * Zoho-owned HTTP error translation (provider-specific quirks stay here).
 *
 * VERIFIED 2026-10-02:
 * - https://www.zoho.com/inventory/api/v1/errors/ ("Errors Overview"): status
 *   codes 200/201, 400 "Bad request ... malformed parameter or missing
 *   parameter", 401 "Unauthorized (Invalid AuthToken)", 404 "URL Not Found",
 *   405, 429 "Too many requests within a certain time frame", 500. Error bodies
 *   carry `{ "code": <int>, "message": "<text>" }` (e.g. { "code": 1002,
 *   "message": "Invoice does not exist." }).
 * - https://www.zoho.com/inventory/api/v1/introduction ("API Call Limit"): 429
 *   also returns code 45 (daily plan quota exceeded), code 44 (account or
 *   organization blocked for exceeding per-minute calls) or code 1070
 *   (concurrent-call limit reached).
 *
 * The mapping keys off the HTTP status (never the numeric `code`, whose values
 * vary per error) and only borrows `code`/`message` for human-readable detail.
 * Because Zoho does not document `Retry-After`, the shared layer's computed
 * backoff is used and the caller gets an explicit "slow down" hint instead.
 */
export function mapZohoHttpError(input: MapErrorInput): ConnectorError {
  const base = {
    provider: input.provider,
    operation: input.operation,
    correlationId: input.correlationId,
    status: input.status,
    retryAfterMs: input.retryAfterMs,
  } as const;

  let message: string | undefined;
  let code: string | undefined;
  if (input.body !== null && typeof input.body === 'object') {
    const rec = input.body as Record<string, unknown>;
    if (typeof rec['message'] === 'string' && rec['message'].trim().length > 0) message = rec['message'].trim();
    // Zoho `code` is numeric; keep it only as text for the human-readable detail.
    if (typeof rec['code'] === 'number' || typeof rec['code'] === 'string') code = String(rec['code']).trim();
  }
  const detail = message !== undefined ? (code !== undefined ? `${message} (code ${code})` : message) : (code ?? input.detail);

  if (input.status === 400 || input.status === 422) {
    return new ValidationError({
      ...base,
      message: `Zoho Inventory rejected the request (${input.status}): ${detail ?? 'validation failed'}`,
      hint:
        'Zoho documented 400 as "malformed parameter or missing parameter". organization_id is added by the connector, '
        + 'so check the filter values and verify ZOHO_ORGANIZATION_ID matches the account, then call again.',
    });
  }

  // Rate limits are documented per organization with fixed daily/per-minute
  // quotas, so the agent needs to know this is a quota problem, not a blip.
  // Built as a new error rather than mutating `mapped` (hint is readonly).
  if (input.status === 429) {
    return new RateLimitError({
      ...base,
      message: `Zoho Inventory rate limit reached on ${input.operation}: ${detail ?? 'too many requests'}`,
      hint:
        'Zoho Inventory rate limit: 100 requests/minute/organization plus a daily plan quota (Free 1000/day, Standard 2000, '
        + 'Professional 5000, Premium/Enterprise 10000). Wait before retrying; sustained 429s mean the daily quota is spent. '
        + 'Zoho sends no Retry-After header, so the connector waits using its own backoff.',
    });
  }
  return mapHttpStatus({ ...input, detail });
}