# WooCommerce

Status: **designed, not implemented** (Phase 4). Not gated on Freshdesk quality.

## Sources

| What | Source | Checked |
|---|---|---|
| REST API overview / v3 | https://developer.woocommerce.com/docs/apis/rest-api/ | 2026-10-02 |
| Authentication (keys, HTTPS, OAuth 1.0a) | https://developer.woocommerce.com/docs/apis/rest-api/authentication/ | 2026-10-02 |

## Authentication - VERIFIED (docs), design only

WooCommerce REST keys are created in the store admin under
**WooCommerce > Settings > Advanced > REST API**, with permissions
`Read`, `Write`, or `Read-Write`. Over **HTTPS** the key and secret are sent with
HTTP Basic (or as query parameters); over plain HTTP the API requires OAuth 1.0a
(HMAC-SHA1/SHA256 with consumer key, timestamp, nonce and signature).

**V1 plan**: HTTPS + a **Read-only** key. OAuth 1.0a will not be implemented in V1;
plain-HTTP stores are out of scope because it forces a weaker credential story for
read-only work. This will be documented in `.env.example` as a requirement, not an
option.

## Planned endpoints - to VERIFY before implementation

| Tool | Path (to confirm on the v3 reference) |
|---|---|
| `woocommerce_list_orders` | `GET /wp-json/wc/v3/orders` |
| `woocommerce_get_order` | `GET /wp-json/wc/v3/orders/{id}` |
| `woocommerce_list_products` | `GET /wp-json/wc/v3/products` |
| `woocommerce_get_product` | `GET /wp-json/wc/v3/products/{id}` |

## To verify at implementation time

- `page` / `per_page` semantics and the maximum `per_page` value
- pagination response metadata (header names for total and total-pages)
- order/product response fields to normalize, and which are nullable
- documented error object shape and status codes
- any host-level rate limiting (WooCommerce core does not document one; limits
  typically come from the host or a WAF). The shared client already handles 429 and
  `Retry-After` generically.

Nothing above is implemented as fact yet. See `docs/adding-a-provider.md`.