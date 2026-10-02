# Architecture

## The problem

An AI agent needs to reach merchant systems (Freshdesk and WooCommerce today;
Zoho Inventory and Unicommerce next) safely and predictably. Left unconstrained,
such
integrations rot in three predictable ways:

1. provider HTTP details leak upward into the agent-facing layer;
2. each provider re-implements retries, timeouts and error handling slightly
   differently, so reliability varies per connector;
3. "extensibility" is claimed but adding a provider requires editing shared code.

This repository is designed so that none of those three can happen quietly.

## Layers

```
AI Agent / MCP Host
  |
  v
MCP Server  (src/mcp/server.ts, src/mcp/mainStdio.ts)
  |           - the only place the MCP SDK is imported
  |           - registers one tool per semantic operation
  |
  v
Semantic tools  (src/providers/<id>/tools.ts + src/core/tools.ts)
  |           - provider-prefixed names, zod input/output schemas, descriptions
  |           - execution wrapper turns thrown errors into agent-safe payloads
  |
  v
Provider registry  (src/core/registry.ts, src/providers/index.ts)
  |           - ProviderModule = { id, capabilities, config, buildTools }
  |           - no central ProviderId union anywhere in core
  |
  v
Provider adapters  (src/providers/<id>/client.ts, normalize.ts, errors.ts, auth.ts)
  |           - routes, query parameters, payload validation, normalization,
  |             provider-specific error translation, auth wire format
  |
  v
Shared HTTP runtime  (src/core/http.ts, retry.ts, pagination.ts)
  |           - timeout/abort, bounded retry, backoff + jitter, Retry-After,
  |             pacing, concurrency, correlation ids, safe logging
  |
  v
External merchant APIs
```

Cross-cutting: `core/errors.ts` (normalized error hierarchy), `core/redact.ts`
(secret redaction), `core/logger.ts` (structured logs), `src/fixtures/**`
(deterministic transport).

## Corrections made to the originally proposed diagram

The proposed architecture was directionally right but under-specified in three
places that matter in production:

| Proposed | Problem | Resolution |
|---|---|---|
| Auth drawn as a side concern | It is impossible to keep credentials out of logs/errors if auth is ambient | `AuthStrategy` is injected into the HTTP client; secrets exist only inside header construction |
| A provider-agnostic layer between tools and adapters | Risks becoming a generic `get(resource, provider, id)` runtime | Replaced with typed **capability interfaces** (`TicketReadable`, ...) plus shared value objects; no generic execution path exists |
| `type ProviderId = 'freshdesk' \| ...` in core | Adding a provider would edit shared code | Registry + string ids; `src/providers/index.ts` is the only file listing providers |

## Why these boundaries are enforceable

- **Adapters never import MCP types.** Tools are plain `ToolDefinition` objects in
  `core/tools.ts`; `src/mcp/server.ts` maps them onto the SDK.
- **Core never imports providers.** The dependency direction is one-way, which a
  lint/review can verify mechanically: `src/core/**` has no provider imports.
- **Providers never import each other.** Each provider folder is self-contained;
  duplicated provider-specific logic would be a review failure.
- **Docs cannot drift from code.** `test/unit/registry.test.ts` asserts every
  registered provider id appears in `docs/provider-matrix.md`.

## Request lifecycle (one tool call)

1. MCP host calls e.g. `freshdesk_search_tickets`.
2. The SDK validates arguments against the tool's `inputSchema`; a bad call
   returns `isError` and never reaches the adapter.
3. The tool handler calls the adapter, which builds a verified request and passes
   it to `HttpClient.get({ operation, path, query })`.
4. `HttpClient` applies pacing/concurrency, injects auth headers, attaches a
   correlation id, enforces the timeout, and on failure applies the retry matrix
   (honoring `Retry-After`).
5. The adapter validates the raw payload with zod, normalizes it into the domain
   model, and returns a page envelope.
6. The tool handler wraps it with provenance (`provider`, `fetchedAt`); the wrapper
   validates the result against `outputSchema` and returns `structuredContent`.
7. Any failure along the way becomes a normalized error payload:
   `{ code, message, provider, operation, correlationId, retryable, hint, ... }`.

## Deliberate non-decisions

- No database, queue, cache, dashboard, or deployment platform. Nothing in the
  requirement set needs them, and each would add an operational surface that a
  single assignment reviewer cannot verify.
- No write operations in V1. See `docs/limitations.md` for the reasoning.
- No Streamable HTTP transport yet: the server factory is transport-agnostic, but
  only stdio is wired up until a host actually needs HTTP.