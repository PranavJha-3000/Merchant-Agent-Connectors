# Freshdesk (reference connector)

Status: **implemented and tested**. This is the quality bar every other provider
must clear.

## Sources

| What | Source | Checked |
|---|---|---|
| API reference (endpoints, fields, Ticket Properties, Pagination, Errors) | https://developers.freshdesk.com/api/ | 2026-10-02 |
| Rate limits (per account, plan-based) | https://support.freshdesk.com/support/solutions/articles/225439 | 2026-10-02 |
| Status codes and meanings | https://support.freshdesk.com/support/solutions/articles/225440 | 2026-10-02 |

## Authentication - VERIFIED

HTTP Basic where the username is the API key and the password is any string:

```
GET https://{domain}.freshdesk.com/api/v2/tickets
Authorization: Basic base64(API_KEY:X)
```

Implemented as `basicAuthHeader(apiKey, 'X')` in `src/providers/freshdesk/manifest.ts`.
The key is read from `FRESHDESK_API_KEY` and exists only inside header
construction; it never reaches logs or errors.

Permission note: the key inherits the associated agent's permissions. Reading
tickets requires an agent who can see those tickets; no admin key is required.

## Base URL - VERIFIED

`https://{domain}.freshdesk.com/api/v2`, where `{domain}` is the helpdesk
subdomain (e.g. `acme` for `acme.freshdesk.com`). `FRESHDESK_DOMAIN` is validated
to be a bare subdomain, so a pasted URL fails fast with a clear
`ConfigurationError`.

## Endpoints used - VERIFIED

| Tool | Method and path | Notes from the docs |
|---|---|---|
| `freshdesk_list_tickets` | `GET /tickets` | Bare JSON array; `page` (>=1), `per_page` (default 30, max 100), `filter` (`new_and_my_open`, `watching`, `spam`, `deleted`), `email`, `updated_since`, `order_by`, `order_type`. Defaults to the **last 30 days**; max 300 pages; `Link: <...>; rel="next"` header signals more pages |
| `freshdesk_get_ticket` | `GET /tickets/{id}` | Single object; `include` embeds requester/company/stats/description (extra API credits) |
| `freshdesk_search_tickets` | `GET /search/tickets?query="..."` | Returns `{ total, results[] }`; query must be double-quoted, max 512 chars including quotes, URL-encoded; `page` 1-10; 30 objects per page; `AND`/`OR`, parentheses, `:>`/`:<`; field names case-sensitive; archived tickets excluded |
| `freshdesk_list_ticket_conversations` | `GET /tickets/{id}/conversations` | Bare JSON array; `page`/`per_page`; message fields `body`, `body_text`, `incoming`, `private`, `user_id`, `ticket_id`, `created_at`, `attachments` |

## Enumerations - VERIFIED

| Field | Values |
|---|---|
| Status | 2 Open, 3 Pending, 4 Resolved, 5 Closed |
| Priority | 1 Low, 2 Medium, 3 High, 4 Urgent |
| Source | 1 Email, 2 Portal, 3 Phone, 7 Chat, 9 Feedback Widget, 10 Outbound Email |

Freshdesk supports **custom ticket statuses**, so unknown codes are normalized to
`{ code, label: 'unknown' }` rather than rejected. This is deliberate: a hardcoded
union would break for accounts that use custom statuses.

## Error shape - VERIFIED

```
{
  "description": "Validation failed",
  "errors": [ { "field": "name", "message": "Mandatory attribute missing", "code": "missing_field" } ]
}
```

Status meanings documented by Freshdesk: 400 validation, 401 auth, 403 permission,
404 bad id/domain, 405 method, 406 accept header, 409 conflict, 415 content type,
429 rate limit, 500/502/503/504 server-side.

`src/providers/freshdesk/errors.ts` maps 400/422 to `VALIDATION_ERROR` with the
field-level detail; everything else flows through the shared status mapping.

## Rate limiting - VERIFIED (conceptually)

Limits are **per account, based on plan** (e.g. Growth 100/min, Pro 400/min,
Enterprise 700/min) with lower per-endpoint caps for ticket-list endpoints, and the
docs advise honoring `retry-after` and queuing calls client-side.

Because the applicable number is account-specific, the connector does not hardcode
a budget. It paces requests, honors `Retry-After`, bounds the wait, and reports
`RATE_LIMITED` with `retryAfterMs` when the bound is exceeded. Freshdesk's own
recommendation (queue calls client-side rather than bursting) is reflected in the
100 ms in-process pacing.

## UNVERIFIED / deliberate gaps

| Item | Status | Consequence |
|---|---|---|
| Which rate-limit bucket applies to a given account | Freshdesk states limits are plan-dependent and per-endpoint; the applicable number is not knowable from the docs alone | No hardcoded budget - pace, honor `Retry-After`, bound the wait, and surface `retryAfterMs` |
| Exact numeric `code` values on error bodies | Status codes and the error *shape* are verified; individual machine codes are not enumerated | Mapping keys off HTTP status; the body message is borrowed for detail only |
| Custom ticket statuses | Docs confirm merchants can define their own statuses | Unknown codes normalize to `{ code, label: 'unknown' }` instead of failing |
| Whether `search/tickets` paginates beyond the first page | Verified: the endpoint accepts `page` (max 10) with a fixed 30 per page, and returns `total` | The tool exposes `page` (1-10) and reports `total`; `hasMore` stops at page 10 because the API will not serve more |
| Conversation endpoint paging | `page`/`per_page` accepted, defaults not stated | Tool applies the same 1-based paging contract and never claims a total |

## Implementation map

```
src/providers/freshdesk/
  manifest.ts   registration + Basic auth strategy + fixture/live wiring
  config.ts     env schema + ConfigurationError
  client.ts     FreshdeskAdapter (list/get/search/conversations) + payload validation
  normalize.ts  raw -> TicketSummary / TicketDetail / ConversationMessage
  types.ts      zod schemas for raw responses (passthrough, drift-tolerant)
  errors.ts     Freshdesk 400/422 translation
  tools.ts      the four MCP tools
  routes.ts     fixture routes
```

## Not implemented

`company_id` and `unique_external_id` list filters are supported internally by the
adapter but not exposed as tool inputs pending verification of their semantics.
Custom ticket views and attachment download are out of scope. See
`docs/limitations.md`.