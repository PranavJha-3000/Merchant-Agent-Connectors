# Testing

```bash
npm test                     # everything, offline, no credentials
npm test -- test/security    # security assertions only
npm run build                # typecheck (tsc)
```

Current status: **249 passing, 1 skipped** (the skipped one is the opt-in live
test). Every test runs without network access or credentials.

## Categories

### Core unit - `test/unit/`

| File | Proves |
|---|---|
| `retry.test.ts` | `Retry-After` parsing (seconds, HTTP-date, garbage); backoff formula and caps; the retry matrix for 400/401/403/404/408/409/422/429/5xx |
| `http.test.ts` | success shape; non-retryable statuses; 429 `Retry-After` honored and bounded; 5xx recovery then exhaustion; malformed JSON; network failure; client timeout; 401 refresh-replay (once, only with a refresh hook); pacing; concurrency cap; log safety and log fields |
| `redact.test.ts` | key-based, value-based and header redaction; logger redaction (memory and JSON) |
| `registry.test.ts` | unique provider ids; fixture mode builds with no credentials; live mode fails fast naming missing keys; `docs/provider-matrix.md` lists every registered provider |
| `entrypoints.test.ts` | the demo and inspect scripts produce ASCII-only output and contain no corrupted characters |

### Provider - `test/providers/freshdesk/`

| File | Proves |
|---|---|
| `client.test.ts` | exact request construction: base URL, `Basic` auth header, correlation header, only documented query params, search quoted/encoded, ticket-scoped conversation path |
| `behaviors.test.ts` | list pagination + `Link` `hasMore`; email filter; empty page; input validation before network; detail normalization incl. custom fields; search envelope + auto-quoting; conversations oldest-first with `isPrivate`/`isIncoming`; merchant unicode passes through verbatim |
| `failures.test.ts` | 401 single-attempt stop; 429 recovery + exhaustion with wait hint; transient 500 recovered transparently; 422 with field detail; schema drift -> `UPSTREAM_RESPONSE_ERROR` with attempts preserved; malformed JSON single-attempt |
| `normalize.test.ts` | enum mapping, unknown-code degradation, null/missing tolerance, conversation semantics |

### MCP - `test/mcp/server.test.ts`

Real SDK over `InMemoryTransport`: `tools/list` returns exactly the eight shipped
tools (4 Freshdesk + 4 WooCommerce) with descriptions and read-only annotations;
a successful call returns SDK-validated `structuredContent`; a failure returns
`isError: true` with no
`structuredContent`; invalid arguments are rejected as an error result.

### Security - `test/security/secrets.test.ts`

See `docs/security.md` for the exact assertions.

### Evaluation - `test/eval/freshdesk.eval.test.ts`

Eleven deterministic merchant-support tasks. No LLM is involved. See
`docs/evaluation.md`.

### Integration - `test/integration/live.freshdesk.test.ts`

Skipped unless `FRESHDESK_DOMAIN` and `FRESHDESK_API_KEY` are set. One read-only
call. Never required for CI.

## Determinism techniques used

- injected `fetch` (fixture transport or a bespoke stub per test)
- injected `sleep` capturing delays instead of waiting
- injected `random` fixing jitter
- injected `now` for the JSON logger
- `memory logger` so log content can be asserted

## Conventions

- Test names describe the behavior, not the function.
- Failure paths are tested at least as thoroughly as success paths.
- Tests assert on the *agent-visible* contract (payload codes, `retryable`, empty
  arrays) rather than internal implementation details.