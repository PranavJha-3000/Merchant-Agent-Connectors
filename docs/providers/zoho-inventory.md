# Zoho Inventory

Status: **designed, not implemented** (Phase 5).

## Sources

| What | Source | Checked |
|---|---|---|
| OAuth 2.0 (scopes, refresh, revoke, headers) | https://www.zoho.com/inventory/api/v1/oauth/ | 2026-10-02 |
| Items API (bulk fetch, organization id, envelope) | https://www.zoho.com/inventory/api/v1/items/ | 2026-10-02 |

## Authentication - VERIFIED (docs), design only

- OAuth 2.0 authorization-code flow, then **refresh tokens** for long-lived access.
- Access tokens are sent as a header: `Authorization: Zoho-oauthtoken {access_token}`.
- Scopes are granular, e.g. `ZohoInventory.items.READ`,
  `ZohoInventory.salesorders.READ`. **V1 will request only `*.READ` scopes.**
- Tokens live in **data-center-specific** domains: both the accounts host used to
  exchange tokens and the API host differ per data center. The data center will be
  an explicit configuration value, not inferred.
- Every data call requires the `organization_id`.

## Design plan

- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_DC`,
  `ZOHO_ORGANIZATION_ID`.
- The refresh-token exchange happens inside the provider's `AuthStrategy.refresh()`,
  which the shared HTTP client already calls after a 401 and replays the request
  exactly once (`src/core/http.ts`). Access tokens are cached in memory only.
- An initial authorization-code bootstrap (browser redirect) is documented but not
  implemented: obtaining a refresh token once is an operator step, not connector
  logic.

## Planned tools (to VERIFY paths and parameters)

`zoho_list_items`, `zoho_get_item`, `zoho_list_sales_orders`,
`zoho_get_sales_order` - all requiring `organization_id`.

## To verify at implementation time

- exact paths and parameters for items and sales orders
- pagination contract (`page` / `per_page` and whether a page-context object is
  returned) and any maximum `per_page`
- documented API call limits and the corresponding header/error behavior
- error envelope fields (a `code` and `message` pair is documented; the full code
  taxonomy is not yet catalogued)

Nothing above is implemented as fact yet.