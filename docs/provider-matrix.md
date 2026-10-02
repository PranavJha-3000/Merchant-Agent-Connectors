# Provider Capability Matrix

Status of each target provider. ✅ = implemented and tested · ⚠️ = scaffolded/pending verification · ❌ = not attempted.

Legend for verification: **VERIFIED** = confirmed against official documentation before coding (source linked in `docs/providers/<id>.md`); **UNVERIFIED** = not yet confirmed — must not be coded as fact.

| Provider | Status | Auth mechanism | Read capabilities (V1) | Writes | Notes |
|---|---|---|---|---|---|
| `freshdesk` | ✅ reference implementation | API key via HTTP Basic — **VERIFIED** | `tickets.list` `tickets.get` `tickets.search` `tickets.conversations` — **VERIFIED** | ❌ out of scope (read-only V1) | Full vertical slice: tools, fixtures, evals, demo |
| `woocommerce` | ✅ implemented (Phase 4) | REST API key over HTTPS Basic — **VERIFIED** (docs) | `orders.list` `orders.get` `products.list` `products.get` — **VERIFIED** (endpoints + parameters) | ❌ | Same reliability pipeline as Freshdesk; `per_page` cap is connector-imposed (Woo documents no max); rate limits not documented upstream — generic 429 handling applies |
| `zoho-inventory` | ✅ implemented (Phase 5) | OAuth 2.0 refresh-token, `Authorization: Zoho-oauthtoken …` — **VERIFIED** (docs); in-memory token, singleflight, refresh-on-401-replay | `items.list` `items.get` `salesorders.list` `salesorders.get` — **VERIFIED** (endpoints + parameters) | ❌ | `organization_id` is config, never a tool argument; separate item/sales-order models (money is a number, ids are strings); live pacing 700ms for the documented 100 req/min; sales-order status enum unverified → humanized labels |
| `unicommerce` | ⚠️ designed, not yet implemented | OAuth password-grant token (official docs) — **PARTIAL** | sale orders (planned) | ❌ | Phase 6 — API paths pending verification; will not ship unverified endpoints |

## Capability semantics

- **Common capability**: `list` / `get` / `search` style reads exist for tickets (Freshdesk) and are planned for orders/products/items where upstream supports them. Implemented as opt-in domain interfaces (`src/capabilities/`), never a fake universal `get(resource, provider, id)` runtime.
- **Provider-specific capability**: Freshdesk ticket conversations (thread of replies + private notes) has no equivalent on other providers and is exposed only as `freshdesk_list_ticket_conversations`.
- **Unsupported capability**: writes, webhooks, and deletes are excluded for V1 on every provider (anti-scope-crawl).

## Normalization policy

Normalization happens **within** a semantic domain (tickets, orders, products, inventory items). Provider-native IDs, provider id, and timestamps are always preserved. Unrelated domains are never merged into one schema.
