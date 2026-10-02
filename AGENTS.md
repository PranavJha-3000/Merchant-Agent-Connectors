# AGENTS.md - Engineering Constitution

This file governs how this repository may be changed. It is binding for humans and
AI agents alike. If a change violates a rule here, the change is wrong - even if the
tests pass. Deviations require an explicit note in `docs/limitations.md`.

## 1. Mission

Give an AI agent secure, predictable, semantic access to merchant systems through
MCP, using one reusable connector architecture. Freshdesk is the reference
implementation and the quality bar every other provider must clear.

## 2. Scope

In scope: read-only merchant data access via MCP; provider adapters; shared
reliability/auth/validation/logging infrastructure; deterministic fixtures, tests,
evaluations and a reproducible demo; documentation of verified upstream behavior.

## 3. Non-goals

Explicitly out of scope unless a concrete requirement is documented first:
frontend, database, user accounts, billing, Kubernetes, microservices, cloud
deployment, write operations, webhooks, background jobs, distributed queues,
dashboards, model hosting, complex caching, speculative "Agent Studio" APIs.

## 4. Architecture

```
MCP host -> MCP server -> semantic tools -> provider registry -> provider adapter
         -> shared HTTP runtime (retry/timeout/rate policy) -> external API
```

Layer rules (enforced by review and, where mechanical, by tests):

1. The MCP layer contains no provider HTTP logic and no auth details.
2. Provider adapters contain no MCP types and never import another provider.
3. `src/core/**` contains no provider-specific business behavior.
4. Shared infrastructure owns all reliability concerns; providers own routes,
   parameters, response translation, and auth wire format.
5. Agent-facing contracts are semantic, never HTTP-oriented.

## 5. Repository rules

- `src/core/**` may not import from `src/providers/**` or `src/mcp/**`.
- `src/providers/<a>/**` may import `src/core/**` and `src/capabilities/**` only.
- `src/providers/index.ts` is the single file that imports concrete provider
  manifests. Nothing else in `src/core/**` may reference a provider id at compile
  time (there is deliberately no `ProviderId` union in core).
- `src/mcp/**` is the only place that imports the MCP SDK.
- TypeScript strict mode stays on (`noUncheckedIndexedAccess` included).
- Code must run under Node's strip-only TypeScript mode (`node file.ts`): no
  TypeScript **parameter properties**, no runtime enums, no `import x = require()`.

## 6. Provider adapter rules

- Implement only capabilities the upstream actually supports. If a capability is
  not supported, do not register a tool for it; record it in
  `docs/provider-matrix.md`.
- Send only parameters verified against official documentation. Unknown or
  unverified parameters are never sent "just in case".
- Validate every upstream payload before normalizing it. Unknown fields are
  ignored; wrong shapes become `UpstreamResponseError`, never a crash.
- Degrade unknown enum values safely (`{ code, label: 'unknown' }`), never throw.
- Preserve provider-native ids and timestamps in normalized output.
- Keep provider quirks (error envelopes, pagination oddities, header formats)
  inside the provider module.

## 7. MCP rules

- Tool names are `provider_snake_case_semantic_operation` (e.g.
  `freshdesk_get_ticket`). Raw paths are never exposed.
- Tool descriptions must state purpose, when to use, when NOT to use, and the
  empty-result/failure semantics so an agent can choose without ambiguity.
- Every tool declares `inputSchema` and `outputSchema` (zod) and read-only
  annotations. No tool is registered without both schemas.
- Success returns `structuredContent` validated against `outputSchema`. Failures
  return `isError: true` with an agent-safe JSON payload and no
  `structuredContent` (the SDK validates structuredContent only on success).
- Input validation happens before any network call and returns
  `VALIDATION_ERROR` without contacting the upstream.
- Prefer read-only tools. Adding a write tool requires a documented rationale and
  truthful `destructiveHint`/`idempotentHint` values.

## 8. Authentication rules

- Credentials come from the environment only. Never from files in the repo or
  hardcoded defaults.
- `src/core/auth.ts` owns the `AuthStrategy` interface, credential loading
  surfaces and redaction. Provider modules own header construction, token
  exchange, refresh and renewal.
- V1 keeps token state in memory only. No tokens persisted to disk.
- A refresh-and-replay of a 401 is allowed only when provider semantics justify
  it, and at most once per request.
- Configuration problems throw `ConfigurationError` before any network I/O, and
  the message names missing variables, never their values.

## 9. Security rules

- No secret may appear in source, fixtures, logs, errors, tool responses, stack
  traces, documentation, or commit history.
- `.env` is git-ignored; `.env.example` holds placeholders only.
- Fixtures are synthetic: reserved domains (`example.test`), fictional names, no
  real customer data, no real-looking tokens.
- All log fields and error payloads pass through `core/redact.ts`.
- Debug output must be safe by default; never dump request headers or bodies.
- `test/security/**` encodes these rules as failing tests. Breaking them breaks
  the build.

## 10. Reliability rules

- Every outbound request goes through `core/http.ts`. Providers never call
  `fetch` directly.
- The retry matrix in `docs/reliability.md` is authoritative. Do not add blind
  retries; do not retry semantic failures.
- Honor `Retry-After` (seconds or HTTP-date). Bound the wait (default 60s) and
  surface the wait to the agent when the bound is exceeded.
- Always send a correlation id; always include it in logs and error payloads.

## 11. Observability rules

- Structured JSON logs, one line per event, to stderr (stdout belongs to the MCP
  stdio transport).
- Log provider, operation, attempt, latency, status category, error code,
  rate-limit flag, correlation id.
- Never log customer payloads or credentials. Log field names, not values.

## 12. Testing rules

- Every behavior claimed in documentation has a test.
- Tests run offline by default; live tests are opt-in and skip cleanly.
- Cover: request construction, auth headers, validation, normalization,
  pagination, retry/backoff/`Retry-After`, error mapping, MCP registration and
  execution, security, and agent-task evaluations.
- Prefer deterministic assertions (injected clock, injected RNG, captured
  sleeps) over timing-based ones.

## 13. Documentation rules

- Every externally verifiable claim cites its official source with the date it
  was checked.
- Unverified behavior is labeled UNVERIFIED and must not be implemented as fact.
- Documentation and code must not drift: if a tool's contract changes, update
  `docs/tool-spec.md` in the same change. `test/unit/registry.test.ts` checks that
  every registered provider appears in `docs/provider-matrix.md`.

## 14. Dependency rules

- Node built-ins and `fetch` first. Current runtime dependencies are limited to
  the MCP SDK and `zod`.
- A new runtime dependency requires a written justification.
- Never add a dependency for something the standard library or existing deps do.

## 15. Git rules

- Never commit `.env`, credentials, tokens, real customer data, or build output.
- Keep commits scoped: shared-core, provider, and docs changes are separable.
- Do not rewrite history to hide a leaked secret; rotate it and document it.

## 16. Commands

```bash
npm test                    # full suite, offline, no credentials
npm test -- test/security   # security assertions only
npm run demo                # deterministic demo incl. failure paths
npm run inspect:tools       # print the MCP tool surface
npm run build               # typecheck
npm run serve:stdio         # MCP server over stdio (fixture mode by default)

# live (opt-in)
FRESHDESK_DOMAIN=... FRESHDESK_API_KEY=... npx vitest run test/integration
```

## 17. Definition of Done

A change is done when:

1. `npm run build` and `npm test` pass with no credentials and no network.
2. New behavior has tests in the right category, including failure paths.
3. Documentation reflects the change and cites sources for external claims.
4. No secret, token, or real customer data appears anywhere in the diff.
5. The boundary rules in this file still hold.
6. If a provider capability is added, `docs/provider-matrix.md` and
   `docs/tool-spec.md` are updated in the same change.

## 18. Adding a provider

A new provider is normally added by implementing the capability interfaces and
registering the adapter - never by editing unrelated providers.

1. Create `src/providers/<id>/` with `manifest.ts`, `config.ts`, `auth.ts`,
   `client.ts`, `normalize.ts`, `types.ts`, `tools.ts` (+ `routes.ts` for fixture
   mode).
2. Implement only the capability interfaces the upstream supports.
3. Verify every endpoint, parameter and auth behavior against official docs first.
   Record the sources in `docs/providers/<id>.md`.
4. Add fixture routes and synthetic fixtures; add provider, MCP, security and
   evaluation tests.
5. Add one line to the registration list in `src/providers/index.ts`.
6. Update `docs/provider-matrix.md`, `docs/tool-spec.md`, and `README.md`.

No existing provider file should need to change.