# Reliability

All of this lives in `src/core/http.ts` + `src/core/retry.ts` and is proven by
`test/unit/http.test.ts` and `test/unit/retry.test.ts`.

## Retry matrix

| Signal | Retried? | Behavior |
|---|---|---|
| 400 / 422 | No | `VALIDATION_ERROR`, upstream field detail included (redacted) |
| 401 | No* | `AUTHENTICATION_ERROR`. *Replayed exactly once if the provider auth strategy implements `refresh()` and it succeeds |
| 403 | No | `AUTHORIZATION_ERROR` (scope/role problem) |
| 404 | No | `NOT_FOUND` - retrying the same id cannot help |
| 408 | Yes | Request timeout: bounded retry |
| 409 | No | `CONFLICT` - a semantic state problem, not a transport one |
| 429 | Yes | Honors `Retry-After`; exhaustion -> `RATE_LIMITED` with `retryAfterMs` and `retryable: true` |
| 500 / 502 / 503 / 504 | Yes | Bounded retry, exponential backoff; exhaustion -> `UPSTREAM_UNAVAILABLE` |
| Network failure (DNS, TCP, TLS) | Yes | Bounded retry -> `NETWORK_ERROR` |
| Client timeout (AbortController) | Yes | Bounded retry -> `TIMEOUT` |
| Malformed JSON on a 2xx | **No** | `UPSTREAM_RESPONSE_ERROR` - retrying cannot fix a broken body |
| Schema mismatch after parsing | **No** | `UPSTREAM_RESPONSE_ERROR` from the adapter's validation step |

## Backoff

```
attempts        = 3          (1 initial + 2 retries)
delay(attempt)  = min(base * 2^(attempt-1) + U(0, jitter), maxDelay)
base            = 250 ms
jitter          = 250 ms      (uniform)
maxDelay        = 5000 ms
```

`attempt` is the number of failures so far, so the first retry waits ~250 ms and
the second ~500 ms (plus jitter).

## Retry-After

- Parsed from the `Retry-After` header, accepting **delta-seconds** and
  **HTTP-date** forms; anything unparseable falls back to the computed backoff.
- When present it **always overrides** the computed delay.
- The wait is bounded by `maxRetryAfterMs` (default **60 s**). If the upstream asks
  for longer, the connector stops immediately and returns `RATE_LIMITED` with
  `retryable: true`, `retryAfterMs`, and a hint telling the agent how long to wait.
  Sleeping for an hour inside a tool call would be worse than reporting it.

## Timelines

- Per-attempt timeout: **10 s** default (configurable per request).
- Implemented with `AbortController`; a blown deadline becomes `TIMEOUT`, which is
  retryable.

## Proactive rate protection (in-process)

Reactive 429 handling alone is not enough, so the client also does:

- **Pacing** - a minimum interval between request *starts* (100 ms in live mode,
  0 in fixture mode). Prevents bursting a page loop.
- **Concurrency limit** - at most 4 in-flight requests per client by default.

Both are intentionally in-process only. A distributed limiter would require Redis
or a queue, which this assignment has no requirement for; the trade-off is
documented in `docs/limitations.md`.

## Provider context

Freshdesk rate limits are **per account, plan-based** (e.g. 100/min on Growth,
400/min on Pro, 700/min on Enterprise; ticket-list endpoints have lower per-endpoint
caps). Source: https://support.freshdesk.com/support/solutions/articles/225439
(checked 2026-10-02). Because limits are account-specific, the connector does not
hardcode a budget: it paces, respects `Retry-After`, and reports the wait.

## What the agent sees on exhaustion

```json
{
  "code": "RATE_LIMITED",
  "message": "Upstream 429 on freshdesk_listTickets: Rate limit exhausted",
  "provider": "freshdesk",
  "operation": "freshdesk_list_tickets",
  "correlationId": "…",
  "status": 429,
  "retryable": true,
  "retryAfterMs": 2000,
  "attempts": 3,
  "hint": "Rate limited. Wait 2s before retrying."
}
```

No raw upstream body, no credentials, no customer records.