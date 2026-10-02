import { ValidationError, type ConnectorError } from '../../core/errors.ts';
import { mapHttpStatus, type MapErrorInput } from '../../core/http.ts';

/**
 * WooCommerce-owned HTTP error translation (provider-specific quirks stay here).
 *
 * WooCommerce error body (VERIFIED:
 * https://developer.woocommerce.com/docs/apis/rest-api/ - "Errors" section):
 *   { "code": "woocommerce_rest_term_invalid",
 *     "message": "Resource doesn't exist.",
 *     "data": { "status": 404 } }
 * Documented status semantics: 400 invalid request, 401 authentication or
 * permission error (bad keys), 404 resource missing, 500 server error.
 *
 * The mapping keys off the HTTP status (never the machine `code` string, whose
 * exact per-endpoint values we do not assert) and only borrows the envelope's
 * message/code for human-readable detail.
 */
export function mapWooCommerceHttpError(input: MapErrorInput): ConnectorError {
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
    if (typeof rec['code'] === 'string' && rec['code'].trim().length > 0) code = rec['code'].trim();
  }
  const detail = message !== undefined ? (code !== undefined ? `${message} (${code})` : message) : (code ?? input.detail);

  if (input.status === 400 || input.status === 422) {
    return new ValidationError({
      ...base,
      message: `WooCommerce rejected the request (${input.status}): ${detail ?? 'validation failed'}`,
      hint: 'WooCommerce validation failed - adjust the arguments (parameter values are case-sensitive) and call again.',
    });
  }

  return mapHttpStatus({ ...input, detail });
}