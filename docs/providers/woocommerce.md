# WooCommerce

Status: **implemented (Phase 4)** - four read-only tools, fixtures, evals, all
tests green. Depends on the Freshdesk quality gate, which passed first.

## Sources

| What | Source | Checked |
|---|---|---|
| REST API overview, v3 base path, Pagination, Link header, Errors | https://developer.woocommerce.com/docs/apis/rest-api/ | 2026-10-02 |
| Authentication (keys, HTTPS Basic, OAuth 1.0a) | https://developer.woocommerce.com/docs/apis/rest-api/authentication/ | 2026-10-02 |
| Orders: properties, endpoints, "Available parameters" | https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/ | 2026-10-02 |
| Products: properties, endpoints, "Available parameters" | https://developer.woocommerce.com/docs/apis/rest-api/v3/products/ | 2026-10-02 |

## Authentication - VERIFIED

REST API keys are created in the store admin under **WooCommerce > Settings >
Advanced > REST API** with permissions `Read`, `Write`, or `Read-Write`. Over
HTTPS the key and secret are sent with HTTP Basic; the docs' own troubleshooting
states: *"The username when authenticating is your consumer key. The password
when authenticating is your consumer secret."* Over plain HTTP the API requires
OAuth 1.0a request signing (HMAC-SHA1/SHA256, 15-minute timestamp window).

**V1 implements**: HTTPS + Basic with a **Read-only** key (`.env.example`
steers to this). A plain-HTTP store would need OAuth 1.0a, which is deliberately
NOT implemented: the config layer rejects `http://` origins with a
`ConfigurationError` before any network call. Query-string credentials
(`?consumer_key=...`) are documented upstream as a fallback for servers that
strip the Authorization header; the connector never uses them, so no key can
appear in a URL (asserted by `test/security/secrets.test.ts`).

Authentication is static: no refresh hook exists, so a 401 is final and is
never replayed.

## Verified endpoints and parameters

Base: `{origin}/wp-json/wc/v3` (v3 is documented as "the current WP REST API
integration version").

| Tool | Endpoint | Verified parameters used |
|---|---|---|
| `woocommerce_list_orders` | `GET /wp-json/wc/v3/orders` | `page` (default 1), `per_page` (default 10), `search`, `after`, `before`, `status`, `customer`, `product` |
| `woocommerce_get_order` | `GET /wp-json/wc/v3/orders/<id>` ("Retrieve an order") | - |
| `woocommerce_list_products` | `GET /wp-json/wc/v3/products` | `page`, `per_page`, `search`, `sku`, `status`, `stock_status` |
| `woocommerce_get_product` | `GET /wp-json/wc/v3/products/<id>` ("Retrieve a product") | - |

Order list `status` options (docs type it as an array): `any`, `pending`,
`processing`, `on-hold`, `completed`, `cancelled`, `refunded`, `failed`,
`trash` (default `any`). The tool exposes **one value per call** - the exact
`?status=completed` usage shown in the docs' Parameters section - rather than
guessing at multi-value serialization.

Product list `status` options: `any`, `draft`, `pending`, `private`, `publish`.
`stock_status`: `instock`, `outofstock`, `onbackorder`. `sku` is documented as
"Limit result set to products with a specific SKU" (exact match).

Pagination (docs "Pagination" section, VERIFIED): pages are 1-based, default 10
items per page, `?per_page` sets page size, and *"The total number of resources
and pages are always included in the X-WP-Total and X-WP-TotalPages HTTP
headers."* The Link header carries `rel="next"/"last"/"first"/"prev"`. The
adapter reads `X-WP-Total`/`X-WP-TotalPages` and falls back to `Link rel="next"`
when a proxy strips the headers; `hasMore` is only ever true on an upstream
signal.

Error envelope (docs "Errors", VERIFIED):
`{ "code": "...", "message": "...", "data": { "status": 404 } }` with status
semantics 400 (invalid request), 401 (auth/permission), 404 (missing), 500
(server). The adapter maps by HTTP status and borrows `message`/`code` for
detail only - tests never assert specific machine `code` strings.

Field notes (property tables, VERIFIED): money values are strings (`"58.00"`);
`customer_id` is `0` for guests; order dates come in site-local and GMT
variants; product `price` is READ-ONLY; unknown/plugin-registered statuses
degrade to `label: "unknown"` with the raw code preserved.

## UNVERIFIED (deliberately not implemented or not claimed)

| Item | Status | Consequence |
|---|---|---|
| Maximum `per_page` value | Docs state only the default (10); no maximum documented | Tool caps `perPage` at 100 as a **connector-imposed** bound, documented as such (not a WooCommerce limit) |
| Rate limiting / 429 behavior | Not documented on the checked pages (no rate-limit or 429 text found) | Generic shared 429 + `Retry-After` handling still applies; no quota is claimed |
| What `search` matches (orders/products) | Docs say only "Limit results to those matching a string" | Tool descriptions state match behavior is store-defined; fixtures match order number / product name+SKU (fixture rule, labelled as such) |
| Multi-value `status` (`status=a,b`) | Docs type `status` as an array but show single-value usage only | One value per call; multi-status filtering not exposed |
| What `X-WP-Total` counts with `search`/`status` filters | Not stated | `total` is passed through verbatim; agents should treat it as "records matching this request" |
| Exact per-endpoint error `code` strings | One example verified (`woocommerce_rest_term_invalid`), the rest vary | Mapping keys off HTTP status, never the code string |

## Explicitly out of scope for V1

OAuth 1.0a (plain-HTTP stores), query-string credentials, write operations,
webhooks, batch endpoints, Order Notes/Refunds/Variations resources, Store API.
