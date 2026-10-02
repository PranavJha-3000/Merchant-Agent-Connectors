# Tool Specification (agent-facing contract)

This is the contract an LLM depends on. It reflects `src/providers/*/tools.ts`;
`npm run inspect:tools` prints the live surface.

Conventions used by every tool:

- **Name** - `provider_semantic_operation`. Names disambiguate siblings; there are
  no redundant tools.
- **Input validation** - zod, enforced before any network call. Invalid input
  returns `VALIDATION_ERROR` and never reaches the merchant API.
- **Success output** - `structuredContent` validated against the tool's
  `outputSchema`, plus a JSON text copy of the same object.
- **Failure output** - `isError: true` with
  `{ code, message, provider, operation, correlationId, retryable, hint, status?, retryAfterMs?, attempts? }`.
  There is no `structuredContent` on failures (schema-compatible by design).
- **Empty results** - lists and searches return `items: []` with `hasMore: false`
  as a *success*. Only a missing single resource is an error (`NOT_FOUND`).
- **Pagination** - `page` is 1-based; `perPage` is clamped to what the provider
  documents; `hasMore` is true only when the upstream itself signals a next page.
- **Provenance** - every success carries `provider` and `fetchedAt` (RFC-3339).

---

## freshdesk_list_tickets

**Purpose** - list tickets with pagination, preset views, requester-email filter,
or an `updated_at` window.

**Use when** - browsing the queue; finding a customer's tickets by email; using a
preset view (`new_and_my_open`, `watching`, `spam`, `deleted`); fetching tickets
changed since a timestamp.

**Do NOT use when** - you already have a ticket id (`freshdesk_get_ticket`), or you
need field conditions like status/priority/tag/date-range
(`freshdesk_search_tickets`).

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `page` | integer >= 1 | no (default 1) | 1-based |
| `perPage` | integer 1..100 | no (default 30) | Freshdesk maximum is 100 |
| `filter` | enum | no | `new_and_my_open`, `watching`, `spam`, `deleted` |
| `requesterEmail` | email | no | Preferred over search when the email is known |
| `updatedSince` | ISO-8601 datetime | no | Required to reach tickets older than the default 30-day window |
| `orderBy` | enum | no | `created_at`, `due_by`, `updated_at`, `status` |
| `orderType` | enum | no | `asc`, `desc` (default `desc`) |

**Output** - `{ provider, fetchedAt, page, perPage, hasMore, total, items[] }` where
`total` is always `null` (Freshdesk does not report it for this endpoint) and
`hasMore` comes from the upstream `Link: rel="next"` header.

**Failure semantics** - 401 `AUTHENTICATION_ERROR`; 403 `AUTHORIZATION_ERROR`;
422/400 `VALIDATION_ERROR`; 429 `RATE_LIMITED` (retryable); 5xx
`UPSTREAM_UNAVAILABLE` (retried internally first).

**Security** - read-only; returns ticket metadata within the configured agent's
visible scope.

**Kind** - provider-specific (the list/get/search shape is shared with future
order/product tools, but the tool itself is Freshdesk's).

---

## freshdesk_get_ticket

**Purpose** - fetch exactly one ticket by numeric id, with description, dates,
escalation flags and custom fields.

**Use when** - you already have the id (from a list/search result or the user).

**Do NOT use when** - you only have an email, subject, keyword or status.

**Input** - `ticketId` (integer >= 1, required).

**Output** - `{ provider, fetchedAt, ticket }` where `ticket` includes
`id, subject, status{code,label}, priority{code,label}, source{code,label}, type,
requesterId, responderId, tags, createdAt, updatedAt, descriptionText, companyId,
groupId, productId, dueBy, firstResponseDueBy, isEscalated, isSpam, customFields`.

**Failure semantics** - unknown id -> `NOT_FOUND`, `retryable: false`
("do not retry the same id"). Enum values that are not documented are returned as
`{ code, label: 'unknown' }` rather than failing.

**Security** - read-only. `customFields` may contain merchant-defined data; it is
passed through as-is and is never a place for credentials.

**Kind** - provider-specific.

---

## freshdesk_search_tickets

**Purpose** - find tickets by structured field conditions using the Freshdesk
query language.

**Use when** - you need conditions (status, priority, type, tag, agent, group,
date ranges, custom fields) and you do not have an id.

**Do NOT use when** - you have a ticket id, want a plain listing, or have a
requester email (use `freshdesk_list_tickets` for those).

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `query` | string 3..510 | yes | Conditions, not sentences. Double quotes are added automatically if missing; the 512-character limit includes them |
| `page` | integer 1..10 | no (default 1) | Freshdesk caps search pagination at 10; page size is fixed at 30 |

**Query language** - `field:value`, `AND` / `OR`, parentheses, `:>` / `:<` for
date and numeric comparisons; string values are quoted; field names are
case-sensitive. Examples: `status:2 AND priority:4`, `tag:'urgent'`,
`created_at:>'2026-01-01'`.

**Output** - `{ provider, fetchedAt, query, page, perPage: 30, total, hasMore, items[] }`
where `total` is the full match count reported by Freshdesk.

**Failure semantics** - no matches is a success with `items: []` and `total: 0`.
Malformed queries surface as `VALIDATION_ERROR` with upstream field detail.
Oversized queries are rejected locally before any network call.

**Security** - read-only. Archived tickets are excluded by Freshdesk.

**Kind** - provider-specific.

---

## freshdesk_list_ticket_conversations

**Purpose** - read the message thread of one ticket: public replies and internal
notes, oldest first.

**Use when** - you have a ticket id and need the messages.

**Do NOT use when** - you do not have a ticket id yet.

**Input** - `ticketId` (integer >= 1, required); `page` (integer >= 1, default 1);
`perPage` (integer 1..100, default 30).

**Output** - `{ provider, fetchedAt, ticketId, page, perPage, hasMore, items[] }`
where each item is
`{ provider, id, ticketId, isPrivate, isIncoming, authorId, bodyText, bodyHtml, createdAt, attachmentCount }`.

**Failure semantics** - unknown ticket -> `NOT_FOUND`. A ticket with no messages
returns an empty `items` array (success).

**Security** - **`isPrivate: true` marks an internal agent note.** The description
instructs the agent to use it for context but never quote it to a customer.
`isIncoming: true` marks a message from the requester.

**Kind** - provider-specific (no other target provider exposes an equivalent
thread resource; it is deliberately not generalized).

---

## Planned tools (not implemented)

Design intent only; each requires verification before implementation. See
`docs/provider-matrix.md`.

| Provider | Planned tools | Source to verify |
|---|---|---|
| WooCommerce | `woocommerce_list_orders`, `woocommerce_get_order`, `woocommerce_list_products`, `woocommerce_get_product` | https://developer.woocommerce.com/docs/apis/rest-api/v3/ |
| Zoho Inventory | `zoho_list_items`, `zoho_get_item`, `zoho_list_sales_orders`, `zoho_get_sales_order` | https://www.zoho.com/inventory/api/v1/ |
| Unicommerce | `unicommerce_search_sale_orders`, `unicommerce_get_sale_order` | https://documentation.unicommerce.com/ |

## Adding a tool

See `docs/adding-a-provider.md`. Every new tool must appear here in the same
change (AGENTS.md §13).