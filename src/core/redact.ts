/**
 * Secret redaction utilities.
 *
 * Central rule (AGENTS.md §9 Security): no credential material may ever reach
 * a log line, an error message, a tool response, or a fixture. Redaction here
 * is defense-in-depth — secrets are never *put* into those surfaces by
 * construction; these helpers guarantee they cannot arrive there accidentally
 * through string interpolation or object serialization either.
 */

export const REDACTED = '[REDACTED]';

/** Keys whose values are replaced wholesale when found anywhere in an object. */
const SENSITIVE_KEY_RE =
  /(api[-_]?key|apikey|token|secret|password|passwd|authorization|credential|cookie|private[-_]?key|access[-_]?key)/i;

/**
 * Values that look like an auth header payload, e.g.
 *   "Basic ZmRfYXBpX2tleTpY", "Bearer eyJhbGciOi...", "Zoho-oauthtoken 1000.xxxx"
 */
const AUTH_VALUE_RE = /\b(Basic|Bearer|Zoho-oauthtoken|Token)\s+[A-Za-z0-9+/._~=-]{6,}/g;

/** Scrub credential-shaped substrings from free text (error messages, traces). */
export function scrubSecrets(text: string): string {
  return text.replace(AUTH_VALUE_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`);
}

/**
 * Deep-clone a JSON-ish value with sensitive keys redacted and credential-shaped
 * strings scrubbed. Cycles are cut; depth is bounded. Non-plain values
 * (Date, Error, …) are stringified conservatively.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) return scrubSecrets(`${value.name}: ${value.message}`);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Redact a plain record of headers (never log Authorization verbatim). */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : scrubSecrets(v);
  }
  return out;
}
