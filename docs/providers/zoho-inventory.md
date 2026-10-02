# Zoho Inventory

Status: **implemented (Phase 5)** - four read-only tools, fixtures, evals, demo,
all tests green. Depends on the Freshdesk quality gate (passed first).

## Sources

| What | Source | Checked |
|---|---|---|
| OAuth flow, token endpoint, data-center table, scopes, header format | https://www.zoho.com/inventory/api/v1/oauth/ | 2026-10-02 |
| Organization ID, multiple data centers, **API call limits** | https://www.zoho.com/inventory/api/v1/introduction/ | 2026-10-02 |
| Pagination + `page_context` | https://www.zoho.com/inventory/api/v1/pagination/ | 2026-10-02 |
| HTTP status codes + error body | https://www.zoho.com/inventory/api/v1/errors/ | 2026-10-02 |
| Items list/retrieve + all list parameters | https://www.zoho.com/inventory/api/v1/items/ | 2026-10-02 |
| Sales orders list/retrieve + fields | https://www.zoho.com/inventory/api/v1/salesorders/ | 2026-10-02 |

## Authentication - VERIFIED

OAuth 2.0. Verified facts this connector relies on:

- Access tokens are sent as `Authorization: Zoho-oauthtoken {access_token}`
  ("Header name should be `Authorization`, header value should be
  `Zoho-oauthtoken {access_token}`").
- The access token comes from `https://accounts.<dc>/oauth/v2/token` with
  `grant_type=refresh_token` plus `refresh_token`, `client_id`, `client_secret`
  (and `redirect_uri` for apps configured with one).
- `access_type=offline` is what returns a `refresh_token` ("The offline
  access_type will give the application an access_token as well as a
  refresh_token"); the refresh token is "permanent" and is used "to regenerate
  new access_token" when the current one expires.
- Access-token lifetime is `expires_in` in the response ("The access_token will
  expire after a particular period (as given in expires_in param in the
  response)"); the docs describe online access as valid for one hour.
- Required read scopes: `ZohoInventory.items.READ` and
  `ZohoInventory.salesorders.READ`.

**What V1 implements**: the refresh-token flow only. Obtaining the initial
refresh token requires the browser-based authorization-code step, a one-time
operator action (documented in `.env.example` and the README), not something the
connector automates. Access tokens live in memory only, refresh proactively
before expiry, collapse concurrent refreshes into a single exchange
(singleflight), and a 401 triggers exactly one refresh + one replay - the
documented `"401 Unauthorized (Invalid AuthToken)"` case.

**Token exchange is sent as an RFC 6749 form body, not a query string.** Zoho's
docs show the same parameters in the URL; using the body keeps `client_secret`
and `refresh_token` out of anything a proxy or log could capture. This is the one
place where our wire format is an RFC-conformant variant rather than a literal
copy of the doc example.

### Data centers - VERIFIED

| Data center | API base | OAuth host |
|---|---|---|
| US `.com` | `https://www.zohoapis.com/inventory/v1` | `https://accounts.zoho.com` |
| India `.in` | `https://www.zohoapis.in/inventory/v1` | `https://accounts.zoho.in` |
| Europe `.eu` | `https://www.zohoapis.eu/inventory/v1` | `https://accounts.zoho.eu` |
| Australia `.com.au` | `https://www.zohoapis.com.au/inventory/v1` | `https://accounts.zoho.com.au` |
| Canada `.ca` | `https://www.zohoapis.ca/inventory/v1` | `https://accounts.zohocloud.ca` |

Canada's OAuth host is `accounts.zohocloud.ca`, **not** `accounts.zoho.ca` - the
hosts are therefore spelled out in code rather than interpolated from the TLD.
`.jp`, `.sa` and `.com.cn` appear in the API-host table but their accounts hosts
were not documented on the pages verified, so they are rejected at config
validation with a `ConfigurationError` rather than guessed.

## `organization_id` - VERIFIED

"The parameter `organization_id` along with the organization ID should be sent in
with every API request to identify the organization." It is obtained from
`GET /organizations` or the admin console's **Manage Organizations** page.

Because it identifies the tenant it is **configuration**, appended to every
request by the adapter and deliberately **not** a tool argument - an agent must
never be able to aim the connector at another organization.

## Verified endpoints and parameters

| Tool | Endpoint | Verified parameters used |
|---|---|---|
| `zoho_list_items` | `GET /inventory/v1/items?organization_id=..` | `page` (default 1), `per_page` (default 200), `search_text` ("Search items by name, SKU, or other searchable fields"), `sku` (exact), `filter_by` (Status.* / ItemType.*), `sort_column` (name, sku, rate, purchase_rate, created_time, last_modified_time, reorder_level, stock_on_hand), `sort_order` (`A`/`D`) |
| `zoho_get_item` | `GET /inventory/v1/items/{item_id}?organization_id=..` | - |
| `zoho_list_sales_orders` | `GET /inventory/v1/salesorders?organization_id=..` | `page` (default 1), `per_page` (default 200) |
| `zoho_get_sales_order` | `GET /inventory/v1/salesorders/{salesorder_id}?organization_id=..` | - |

Filter exposure is deliberate: `filter_by` is offered only for the documented
`Status.*` values (`All`, `Active`, `Inactive`, `Lowstock`, `Unmapped`,
`Uncategorized`, `Grouped`). The documented `ItemType.*` values are **not**
exposed - they would overlap confusingly with `status` for an agent, and stock
workflows need the status views.

Pagination (docs "Pagination Overview", VERIFIED): lists are "paginated to 200
items by default"; `page` and `per_page` control paging; the response carries
`page_context: { page, per_page, has_more_page }`. There is **no total count**,
so `total` is always `null` in connector output and `hasMore` is only ever true
when `has_more_page` says so.

Errors (docs "Errors Overview", VERIFIED): 400 "Bad request ... malformed
parameter or missing parameter", 401 "Unauthorized (Invalid AuthToken)", 404,
405, 429 "Too many requests within a certain time frame", 500; body is
`{ "code": <int>, "message": "<text>" }` (e.g. `{ "code": 1002, "message":
"Invoice does not exist." }`). The adapter maps by HTTP status and borrows
`code`/`message` for detail only.

## API limits - VERIFIED

- **100 requests per minute per organization.**
- Per day, by plan: Free 1000, Standard 2000, Professional 5000,
  Premium 10000, Enterprise 10000.
- Concurrent calls: 5 (Free), 10 (paid, soft limit).
- Over-limit responses are HTTP **429** with `code` 45 (daily quota), 44 (account
  or organization blocked) or 1070 (concurrent limit).

Consequences in this connector: live mode paces requests at ~700ms (comfortably
inside 100/min), the shared retry layer handles 429 with backoff, and the error
mapper replaces the generic hint with the documented quota numbers so the agent
knows a daily budget - not a transient blip - was hit. Zoho sends no
`Retry-After` header on the checked pages, so the connector never claims a
server-provided wait time.

## UNVERIFIED / deliberate gaps

| Item | Status | Consequence |
|---|---|---|
| Sales-order status enum | Not enumerated on the checked pages (only `"fulfilled"` appears in an example) | `status.label` is a humanized form of whatever code upstream sends; no membership list is invented |
| `salesorder_ids` marked **Required** on the list endpoint | Present in the same parameter table as `page`/`per_page`, but a plain list has no ids to supply and the documented response returns the full list plus `page_context` | The adapter sends only `organization_id`, `page`, `per_page` and documents this decision; no bulk-fetch style tool is exposed |
| Maximum `per_page` | Not documented (default 200 only) | Tool caps `perPage` at 500 as a **connector-imposed** bound, labelled as such |
| Data centers `.jp` / `.sa` / `.com.cn` | API hosts documented, OAuth hosts not | Rejected at config validation instead of guessed |
| Access-token lifetime | `expires_in` documented; "one hour" stated for online access | Refresh uses `expires_in` from the response with a 60s safety margin and a conservative fallback |
| Whether `search_text` also matches group/SKU variants | Docs say only "name, SKU, or other searchable fields" | Tool description says match behavior is store-defined; exact lookups should use `sku` |
| Re-consent / refresh-token rotation | Not described for Inventory | Not implemented; a revoked grant surfaces as `AUTHENTICATION_ERROR` telling the operator to re-authorize |

## Explicitly out of scope for V1

Write endpoints (create/update/confirm/void sales orders, item mutations),
contacts, invoices, composite items, item variants, bulk endpoints, the
authorization-code browser flow, token persistence, and any non-read scope.

## Models (why they are not the WooCommerce ones)

Zoho's sales order is a fulfilment document (`shipment_date`, `shipment_days`,
`quantity_packed/shipped/invoiced`, `sales_channel`, `reference_number`,
`bcy_total`) whose `total` is a **number**, not a string decimal. Overlaying it
on the WooCommerce order shape would either misreport money or drop the
fulfilment state, so sales orders live in their own model
(`src/capabilities/salesOrders.ts`). Items are likewise separate from the
WooCommerce product (`src/capabilities/inventory.ts`) because `stock_on_hand` /
`reorder_level` / `item_type` are the fields a merchant actually asks about.
Ids are kept as **strings**: Zoho ids are 16-digit values and string handling
guarantees they survive round-tripping unchanged.
