import { scrubSecrets } from './redact.ts';

/**
 * Normalized error hierarchy.
 *
 * Every failure that can reach an agent is one of these classes. The wire form
 * (`AgentErrorPayload`) carries enough context to debug a merchant integration
 * — code, provider, operation, correlation id, HTTP status, retryability, an
 * actionable hint — and never carries credentials, auth headers, tokens, raw
 * upstream bodies, or customer payloads.
 *
 * Retryability is part of the contract: agents branch on `retryable`.
 * The retry matrix lives in docs/reliability.md and is enforced in core/http.ts.
 */

export type AgentErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_RESPONSE_ERROR'
  | 'INTERNAL_ERROR';

export interface AgentErrorPayload {
  code: AgentErrorCode;
  message: string;
  provider: string;
  operation: string;
  correlationId?: string;
  status?: number;
  retryable: boolean;
  /** Milliseconds the upstream asked us to wait (429 Retry-After), when known. */
  retryAfterMs?: number;
  /** Total HTTP attempts made before giving up (including the first). */
  attempts?: number;
  /** Agent-actionable next step. Short, imperative, no secrets. */
  hint?: string;
}

export interface ConnectorErrorInit {
  provider: string;
  operation: string;
  message: string;
  correlationId?: string;
  status?: number;
  retryAfterMs?: number;
  attempts?: number;
  hint?: string;
}

const MAX_MESSAGE_LENGTH = 500;

function sanitizeMessage(message: string): string {
  const noControls = message.replace(/[\r\n\t]+/g, ' ').replace(/\u0000/g, '');
  const scrubbed = scrubSecrets(noControls);
  return scrubbed.length > MAX_MESSAGE_LENGTH ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH)}…` : scrubbed;
}

export abstract class ConnectorError extends Error {
  abstract readonly code: AgentErrorCode;
  abstract readonly retryable: boolean;

  readonly provider: string;
  readonly operation: string;
  readonly correlationId?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly hint?: string;
  /** Mutable: the HTTP layer stamps final attempt count at throw time. */
  attempts?: number;

  constructor(init: ConnectorErrorInit) {
    super(sanitizeMessage(init.message));
    this.name = new.target.name;
    this.provider = init.provider;
    this.operation = init.operation;
    this.correlationId = init.correlationId;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.attempts = init.attempts;
    this.hint = init.hint;
  }

  toAgentPayload(): AgentErrorPayload {
    const payload: AgentErrorPayload = {
      code: this.code,
      message: this.message,
      provider: this.provider,
      operation: this.operation,
      retryable: this.retryable,
    };
    if (this.correlationId !== undefined) payload.correlationId = this.correlationId;
    if (this.status !== undefined) payload.status = this.status;
    if (this.retryAfterMs !== undefined) payload.retryAfterMs = this.retryAfterMs;
    if (this.attempts !== undefined) payload.attempts = this.attempts;
    if (this.hint !== undefined) payload.hint = this.hint;
    return payload;
  }
}

export class ConfigurationError extends ConnectorError {
  readonly code = 'CONFIGURATION_ERROR' as const;
  readonly retryable = false;
}

export class AuthenticationError extends ConnectorError {
  readonly code = 'AUTHENTICATION_ERROR' as const;
  readonly retryable = false;
}

export class AuthorizationError extends ConnectorError {
  readonly code = 'AUTHORIZATION_ERROR' as const;
  readonly retryable = false;
}

export class ValidationError extends ConnectorError {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly retryable = false;
}

export class NotFoundError extends ConnectorError {
  readonly code = 'NOT_FOUND' as const;
  readonly retryable = false;
}

export class ConflictError extends ConnectorError {
  readonly code = 'CONFLICT' as const;
  readonly retryable = false;
}

export class RateLimitError extends ConnectorError {
  readonly code = 'RATE_LIMITED' as const;
  readonly retryable = true;
}

export class TimeoutError extends ConnectorError {
  readonly code = 'TIMEOUT' as const;
  readonly retryable = true;
}

export class NetworkError extends ConnectorError {
  readonly code = 'NETWORK_ERROR' as const;
  readonly retryable = true;
}

export class UpstreamUnavailableError extends ConnectorError {
  readonly code = 'UPSTREAM_UNAVAILABLE' as const;
  readonly retryable = true;
}

/** Malformed JSON, schema drift, or any structurally unusable response. Never retried. */
export class UpstreamResponseError extends ConnectorError {
  readonly code = 'UPSTREAM_RESPONSE_ERROR' as const;
  readonly retryable = false;
}

/** Unexpected non-connector exception (a bug). Never retried. */
export class InternalError extends ConnectorError {
  readonly code = 'INTERNAL_ERROR' as const;
  readonly retryable = false;
}

export function isConnectorError(value: unknown): value is ConnectorError {
  return value instanceof ConnectorError;
}

/**
 * Extract a short, safe detail string from a parsed upstream error body.
 * Reads only well-known error-envelope fields; never returns the raw body.
 * Recognizes Freshdesk `{description, errors:[{message}]}` as well as generic
 * `{message|error|error_message|description}` envelopes.
 */
export function extractUpstreamErrorDetail(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['description', 'message', 'error_message', 'error']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim().length > 0) parts.push(v.trim());
  }
  const errors = obj['errors'];
  if (Array.isArray(errors)) {
    for (const e of errors.slice(0, 5)) {
      if (e && typeof e === 'object') {
        const rec = e as Record<string, unknown>;
        const msg = typeof rec['message'] === 'string' ? rec['message'] : undefined;
        const field = typeof rec['field'] === 'string' ? rec['field'] : undefined;
        if (msg) parts.push(field ? `${field}: ${msg}` : msg);
      } else if (typeof e === 'string') {
        parts.push(e);
      }
    }
  }
  if (parts.length === 0) return undefined;
  const joined = [...new Set(parts)].join('; ');
  return joined.length > 300 ? `${joined.slice(0, 300)}…` : joined;
}

export interface UnknownErrorContext {
  provider: string;
  operation: string;
  correlationId?: string;
}

/** Wrap any thrown value as a ConnectorError with agent-safe payload semantics. */
export function toAgentError(value: unknown, ctx: UnknownErrorContext): ConnectorError {
  if (isConnectorError(value)) return value;
  const detail = value instanceof Error ? value.message : String(value);
  return new InternalError({
    provider: ctx.provider,
    operation: ctx.operation,
    correlationId: ctx.correlationId,
    message: `Unexpected internal error in ${ctx.operation}: ${detail}`,
    hint: 'This is not a merchant API failure. Retrying is unlikely to help; report it with the correlationId.',
  });
}
