# Provider Capability Matrix

Status of each target provider. ✅ = implemented and tested · ⚠️ = scaffolded/pending verification · ❌ = not attempted.

Legend for verification: **VERIFIED** = confirmed against official documentation before coding (source linked in `docs/providers/<id>.md`); **UNVERIFIED** = not yet confirmed — must not be coded as fact.

| Provider | Status | Auth mechanism | Read capabilities (V1) | Writes | Notes |
|---|---|---|---|---|---|
| `freshdesk` | ✅ reference implementation | API key via HTTP Basic — **VERIFIED** | `tickets.list` `tickets.get` `tickets.search` `tickets.conversations` — **VERIFIED** | ❌ out of scope (read-only V1) | Full vertical slice: tools, fixtures, evals, demo |
| `woocommerce` | ⚠️ designed, not yet implemented | REST API key over HTTPS Basic — **VERIFIED** (docs) | orders, products (planned) | ❌ | Phase 4 — starts only after Freshdesk quality gate |
| `zoho-inventory` | ⚠️ designed, not yet implemented | OAuth 2.0 authorization-code + refresh — **VERIFIED** (docs) | items, sales orders (planned) | ❌ | Phase 5 — per-data-center endpoints required |
| `unicommerce` | ⚠️ designed, not yet implemented | OAuth password-grant token (official docs) — **PARTIAL** | sale orders (planned) | ❌ | Phase 6 — API paths pending verification; will not ship unverified endpoints |

## Capability semantics

- **Common capability**: `list` / `get` / `search` style reads exist for tickets (Freshdesk) and are planned for orders/products/items where upstream supports them. Implemented as opt-in domain interfaces (`src/capabilities/`), never a fake universal `get(resource, provider, id)` runtime.
- **Provider-specific capability**: Freshdesk ticket conversations (thread of replies + private notes) has no equivalent on other providers and is exposed only as `freshdesk_list_ticket_conversations`.
- **Unsupported capability**: writes, webhooks, and deletes are excluded for V1 on every provider (anti-scope-crawl).

## Normalization policy

Normalization happens **within** a semantic domain (tickets, orders, products, inventory items). Provider-native IDs, provider id, and timestamps are always preserved. Unrelated domains are never merged into one schema.
