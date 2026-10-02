import { AuthenticationError, RateLimitError, ValidationError, type ConnectorError } from '../../core/errors.ts';
import { mapHttpStatus, type MapErrorInput } from '../../core/http.ts';
import type { RawApiError } from './types.ts';
import { describeApiErrors } from './normalize.ts';

/**
 * Unicommerce error translation (provider-specific quirks stay here).
 *
 * VERIFIED 2026-10-02 (https://documentation.unicommerce.com/):
 * - `/docs/response-codes.html` publishes a catalog of application-level codes
 *   (`NAME numeric`, e.g. `INVALID_TOKEN 100209`, `INVALID_SALE_ORDER_CODE
 *   40005`, `INVALID_TENANT 100084`). Every API response carries them in
 *   `errors[].code` with `errors[].message` / `description` / `fieldName`.
 * - The docs do NOT publish an HTTP status taxonomy, so HTTP-level failures are
 *   mapped by the shared status mapping and only enriched with the documented
 *   code detail.
 * - No rate limit is documented anywhere on the pages verified, so the 429 hint
 *   is explicitly generic instead of inventing a budget.
 *
 * The distinctive Unicommerce case is `application errors in an HTTP 200`: both
 * endpoints answer `{ successful: false, errors: [...] }` with status 200, so
 * `unicommerceApplicationError` converts that documented channel into a
 * normalized ConnectorError instead of silently returning an empty result.
 */

/** Documented codes we can classify from the catalog's own wording. */
const AUTH_ERROR_CODES = new Set([100209]); // INVALID_TOKEN
const TENANT_ERROR_CODES = new Set([100083, 100084, 100086, 100085]); // INVALID_PASSWORD/INVALID_TENANT/INVALID_USER_DETAIL/INVALID_API_REQUEST

/**
 * Convert the documented `successful: false` + `errors[]` channel into a
 * normalized error. Only codes whose documented NAME justifies a classification
 * are special-cased; everything else becomes a non-retryable ValidationError
 * that quotes the upstream code so the operator can look it up.
 */
export function unicommerceApplicationError(input: {
  provider: string;
  operation: string;
  correlationId: string;
  status: number;
  errors: readonly RawApiError[];
}): ConnectorError {
  const detail = describeApiErrors(input.errors) ?? 'no error detail returned';
  const codes = input.errors.map((e) => e.code).filter((c): c is number => c !== null);

  if (codes.some((c) => AUTH_ERROR_CODES.has(c))) {
    return new AuthenticationError({
      provider: input.provider,
      operation: input.operation,
      correlationId: input.correlationId,
      status: input.status,
      message: `Unicommerce rejected the access token: ${detail}`,
      hint: 'The refresh token was rejected. Obtain a new one via the documented password grant - a refresh token "can only be used till 30 days of first issuance of access_token".',
    });
  }
  if (codes.some((c) => TENANT_ERROR_CODES.has(c))) {
    return new AuthenticationError({
      provider: input.provider,
      operation: input.operation,
      correlationId: input.correlationId,
      status: input.status,
      message: `Unicommerce rejected the tenant credentials: ${detail}`,
      hint: 'Check UNICOMMERCE_BASE_URL (docs: https://{tenant}.unicommerce.com) and that the user has API access for this tenant.',
    });
  }
  return new ValidationError({
    provider: input.provider,
    operation: input.operation,
    correlationId: input.correlationId,
    status: input.status,
    message: `Unicommerce reported an application error on ${input.operation}: ${detail}`,
    hint:
      'Unicommerce returns application errors in the response body with codes catalogued at '
      + 'documentation.unicommerce.com/docs/response-codes.html. Check the filters/order code and the order state; do not retry unchanged.',
  });
}

/** HTTP-level translation. Codes are absent on these bodies, so status decides. */
export function mapUnicommerceError(input: MapErrorInput): ConnectorError {
  const base = {
    provider: input.provider,
    operation: input.operation,
    correlationId: input.correlationId,
    status: input.status,
    retryAfterMs: input.retryAfterMs,
  } as const;

  let message: string | undefined;
  if (input.body !== null && typeof input.body === 'object') {
    const rec = input.body as Record<string, unknown>;
    if (typeof rec['message'] === 'string' && rec['message'].trim().length > 0) message = rec['message'].trim();
  }
  const detail = message ?? input.detail;

  if (input.status === 400 || input.status === 422) {
    return new ValidationError({
      ...base,
      message: `Unicommerce rejected the request (${input.status}): ${detail ?? 'validation failed'}`,
      hint: 'The request body did not satisfy the documented request schema. Re-check the argument types (dates are ISO-8601) and call again.',
    });
  }

  if (input.status === 429) {
    // UNVERIFIED: Unicommerce documents no rate limit on the pages checked, so
    // the hint says exactly that instead of inventing a budget.
    return new RateLimitError({
      ...base,
      message: `Unicommerce rate limited ${input.operation}: ${detail ?? 'too many requests'}`,
      hint: 'Unicommerce does not publish rate limits on the pages verified, so the connector cannot tell you the budget. Slow down, reduce page size, and retry later.',
    });
  }
  return mapHttpStatus({ ...input, detail });
}