# Limitations and Known Unknowns

This file is the honest counterweight to the rest of the documentation. Anything
unverified is labelled UNVERIFIED and is deliberately **not** implemented.

## 1. Two providers are implemented; two are not

Freshdesk (reference) and WooCommerce (Phase 4) are complete. Zoho Inventory and
Unicommerce are **designed but not implemented**. Adding a provider is a
deliberate, gated step (`docs/adding-a-provider.md`), not a matter of dropping
in a URL.

Rationale: one reference-quality vertical slice is more valuable than four
shallow connectors; expansion proceeds only while quality holds. See
`docs/provider-matrix.md` for status.

## 2. Read-only

No create/update/delete/reply tools exist. Merchant writes require scope decisions,
idempotency, confirmation UX and destructive-action semantics that the assignment
does not require, and getting them half-right is worse than not shipping them.

## 3. Freshdesk behaviors that remain UNVERIFIED

The following are **not** implemented because they could not be confirmed from
official documentation during this work:

| Item | Status | Consequence |
|---|---|---|
| Search pagination beyond `page` (e.g. custom page size) | Documented behavior verified (`page` 1-10, fixed 30/page); no other knobs exposed | Only `page` is exposed |
| Concrete rate-limit numbers per plan | Verified conceptually (per account, plan-based, `429` + retry-after per docs) | Not hardcoded; rely on pacing + `Retry-After` |
| `filter_name` / custom ticket-view filters | Documented as a separate "Filter Tickets"/custom-views concept; only presets exposed | Custom views not exposed |
| `company_id` / `unique_external_id` list filters | Present in the adapter's internal parameter support but not exposed as tool inputs | Add after verifying field semantics |
| Attachment download URLs | Not needed for read-only ticket triage | Out of scope |

## 4. WooCommerce behaviors that remain UNVERIFIED

Full table with consequences: `docs/providers/woocommerce.md`. Summary:

- **`per_page` maximum** - not documented upstream; the tool's 100 cap is a
  connector-imposed safety bound, explicitly not a claimed WooCommerce limit.
- **Rate limits** - the checked WooCommerce docs contain no rate-limit or 429
  text; the shared 429/`Retry-After` pipeline still applies generically, but no
  quota is claimed.
- **`search` match semantics** - documented only as "Limit results to those
  matching a string"; the agent-facing description says behavior is
  store-defined instead of promising email/id matching.
- **Multi-value `status` filters** - one value per call; comma-separated
  arrays were not verified for the orders list and are not sent.
- **OAuth 1.0a / plain-HTTP stores** - documented upstream, deliberately not
  implemented; `http://` origins fail configuration validation.
- **Query-string credentials** - documented upstream as a server fallback,
  deliberately never used (keeps keys out of URLs).

## 5. Deliberate non-goals

Per AGENTS.md §3: no frontend, database, user accounts, billing, Kubernetes,
microservices, cloud deployment, webhooks, background jobs, distributed queues,
dashboards, model hosting, or complex caching.

## 6. Accepted trade-offs

| Trade-off | Why accepted |
|---|---|
| In-process pacing/concurrency only | A distributed limiter needs Redis or a queue; single-process deployment is the stated assumption. Nothing is shared across processes. |
| Freshdesk list `total` is `null` | The endpoint does not report it (verified). `hasMore` comes from the link header instead. Search does report `total`. |
| Ticket list defaults to a 30-day window | Freshdesk's own default (verified). `updatedSince` is exposed to reach older tickets. |
| Unknown enum codes map to `label: 'unknown'` | Freshdesk supports custom statuses; hardcoding a closed set would break on them. |
| Only stdio transport is wired | Streamable HTTP is designed for (`createConnectorServer` is transport-agnostic) but no host requires it yet. |
| Unicommerce API paths | Token endpoint verified from official docs; sale-order search/get paths are **UNVERIFIED**, so no code was written. See `docs/providers/unicommerce.md`. |

## 7. What a reviewer should not assume

- The connector does not retry non-idempotent or semantic failures, and never
  writes merchant state.
- It does not cache merchant data. Every read hits the upstream (pacing applies).
- It does not persist tokens. Zoho/Unicommerce support in V1 would keep them in
  memory only.
- It does not validate business semantics (e.g. "is this refund legitimate"); it
  returns normalized merchant data and clear failures.