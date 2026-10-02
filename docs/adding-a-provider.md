# Adding a Provider

The architecture is designed so that adding a provider means **adding files**, not
editing shared code. No existing provider is touched, and `src/core/**` is not
modified.

Worked example: the Freshdesk reference implementation (`src/providers/freshdesk/`).

## Step 0 - Verify before you write

Read the provider's official documentation and confirm:

- authentication mechanism and header format
- base URL / data-center variants
- exact endpoint paths for each resource
- query parameters (names, defaults, maximums)
- pagination semantics (`page`/`perPage`, cursors, link headers, totals)
- rate limiting and any `Retry-After` behavior
- error response shape and status meanings

Record every claim with its source and check date in `docs/providers/<id>.md`.
Anything you cannot verify is labelled UNVERIFIED and is not implemented.

## Step 1 - Create the provider folder

```
src/providers/<id>/
  manifest.ts    ProviderModule: id, displayName, capabilities, configKeys, buildTools
  config.ts      config schema + env loader (throws ConfigurationError)
  auth.ts        (or inline in manifest.ts) AuthStrategy: headers(), optional refresh()
  client.ts      adapter: implements capability interfaces; owns routes + params
  normalize.ts   raw -> domain models
  types.ts       zod schemas for raw payloads
  errors.ts      provider-specific HTTP error translation (optional)
  tools.ts       ToolDefinition[] (name, schemas, description, annotations, handler)
  routes.ts      fixture routes for deterministic fixture mode
```

## Step 2 - Implement only real capabilities

Implement the interfaces in `src/capabilities/` that the upstream genuinely
supports (`TicketListable`, `TicketReadable`, `TicketSearchable`,
`ConversationReadable`, and future order/product/inventory interfaces). Do not
register a tool for a capability the API lacks.

## Step 3 - Write the tools

Each tool must have:

- a `provider_snake_case_operation` name
- a description that says purpose, when to use, when NOT to use, and the
  empty/failure semantics
- a zod `inputSchema` (strict; reject anything the API does not accept)
- a zod `outputSchema` validated by the framework
- `readOnlyHint: true` (V1) plus truthful `destructiveHint`/`idempotentHint`
- a handler that returns normalized data and never throws raw errors

Copy the shape from `src/providers/freshdesk/tools.ts`.

## Step 4 - Fixtures and tests

- Add synthetic fixtures under `src/fixtures/<id>/*.json` (reserved domains only).
- Add fixture routes so the demo and tests can run offline.
- Add `test/providers/<id>/` covering success, empty, invalid input, 401, 403, 404,
  422, 429 (+`Retry-After`), 5xx recovery, retry exhaustion, malformed JSON, and
  schema drift.
- Add evaluation tasks in `test/eval/`.
- Extend the security tests if the provider introduces new secret shapes.

## Step 5 - Register

```ts
// src/providers/index.ts
export const providerModules = [freshdeskModule, wooCommerceModule]; // one line
```

Run `npm run inspect:tools` to confirm the surface.

## Step 6 - Documentation

Update, in the same change:

- `docs/provider-matrix.md`
- `docs/tool-spec.md`
- `docs/providers/<id>.md` (new)
- `README.md` supported-providers table

`test/unit/registry.test.ts` fails if a registered provider is missing from
`docs/provider-matrix.md`, so documentation drift is caught by the build.

## Definition of done for a new provider

- `npm run build` and `npm test` pass with no credentials
- fixture mode works end to end (`npm run demo`)
- no secret or real customer data anywhere in the diff
- existing providers untouched

## Anti-patterns to avoid

- Adding `if (provider === 'x')` branches to `src/core/**`
- A generic `get(resource, provider, id)` tool
- Sending parameters that are not verified as documented
- Swallowing an upstream error shape instead of translating it
- Registering a capability the API does not have