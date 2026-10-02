import {
  ValidationError,
  type ConnectorError,
} from '../../core/errors.ts';
import { mapHttpStatus, type MapErrorInput } from '../../core/http.ts';

/**
 * Freshdesk-owned HTTP error translation (provider-specific quirks stay here).
 *
 * Freshdesk error body (verified: developers.freshdesk.com/api → Errors):
 *   { "description": "Validation failed",
 *     "errors": [ { "field": "name", "message": "Mandatory attribute missing", "code": "missing_field" } ] }
 * Status semantics verified in the same docs (400 validation, 401 auth, 403
 * permission, 404 bad ID/domain, 409 conflict, 429 rate limit, 5xx server).
 */
export function mapFreshdeskHttpError(input: MapErrorInput): ConnectorError {
  const base = {
    provider: input.provider,
    operation: input.operation,
    correlationId: input.correlationId,
    status: input.status,
    retryAfterMs: input.retryAfterMs,
  } as const;

  if (input.status === 400 || input.status === 422) {
    const parts: string[] = [];
    const body = input.body;
    if (body !== null && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (typeof rec['description'] === 'string') parts.push(rec['description']);
      const errs = rec['errors'];
      if (Array.isArray(errs)) {
        for (const e of errs.slice(0, 5)) {
          if (e && typeof e === 'object') {
            const er = e as Record<string, unknown>;
            const field = typeof er['field'] === 'string' ? er['field'] : undefined;
            const msg = typeof er['message'] === 'string' ? er['message'] : undefined;
            if (field && msg) parts.push(`${field}: ${msg}`);
            else if (msg) parts.push(msg);
          }
        }
      }
    }
    const detail = parts.length > 0 ? [...new Set(parts)].join('; ') : input.detail;
    return new ValidationError({
      ...base,
      message: `Freshdesk rejected the request (400): ${detail ?? 'validation failed'}`,
      hint: 'Freshdesk validation failed — adjust the arguments (field names are case-sensitive) and call again.',
    });
  }

  return mapHttpStatus({ ...input, detail: input.detail });
}
