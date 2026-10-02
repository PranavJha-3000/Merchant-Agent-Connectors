# Unicommerce

Status: **implemented (Phase 6)** - two read-only tools, fixtures, evals, demo,
all tests green. This page replaces the earlier "designed, deliberately not
implemented" note: the sale-order read paths ARE verifiable in the official
documentation (see Sources), so nothing here is guessed.

## Sources

| What | Source | Checked |
|---|---|---|
| Search sale order (endpoint, method, body, response) | https://documentation.unicommerce.com/docs/saleorder-search.html | 2026-10-02 |
| Get sale order (endpoint, method, body, DTO, enums) | https://documentation.unicommerce.com/docs/saleorder-get.html | 2026-10-02 |
| Refresh token ("Renew Access Token") | https://documentation.unicommerce.com/docs/oauth-refreshtoken.html | 2026-10-02 |
| Initial password grant | https://documentation.unicommerce.com/docs/oauth2.html | 2026-10-02 |
| Base URL / tenant host | https://documentation.unicommerce.com/docs/url-details.html | 2026-10-02 |
| Application error-code catalog (362 codes) | https://documentation.unicommerce.com/docs/response-codes.html | 2026-10-02 |

## Authentication - VERIFIED

OAuth 2.0 against the tenant host.

- **Base URL** (`url-details.html`): "Sample URL `https://{tenant}.unicommerce.com/{endpoint}?{query parameters}`"
  where "{tenant}: Uniware account code which comes in URL after login into Uniware".
  Every API page states "Scheme: HTTPS", so the base URL is HTTPS-only and
  tenant-specific - therefore configuration, not a hardcoded host.
- **Password grant** (`oauth2.html`): `GET /oauth/token` with mandatory
  `grant_type=password` and `client_id` ("my-trusted-client"), plus
  `username` and `password` sent as **HTTP headers**. Response:
  `{ access_token, token_type: "bearer", refresh_token, expires_in }`.
- **Refresh grant** (`oauth-refreshtoken.html`): `GET /oauth/token` with
  `grant_type=refresh_token`, `client_id` ("my-trusted-client") and
  `refresh_token`. Response adds `scope`; `expires_in` is documented as the
  "valid time of access_token in seconds".
- **Refresh-token lifetime**: "used to re-validate access_token, **can only be
  used till 30 days of first issuance of access_token**".
- **API header**: every endpoint documents
  `Header (Authorization): bearer {access-token}` (lowercase scheme, as written).

**What V1 implements**: the refresh grant only. Tokens live in memory, are
refreshed proactively before `expires_in` (60s skew), concurrent refreshes
collapse into one request (singleflight), and a rejected token triggers exactly
one refresh + one replay. The 30-day refresh-token window is surfaced in the
failure hint because that is the documented way this integration dies.

**Deliberately not implemented**: the password grant. It is documented, but it
requires storing a Uniware login password in the connector. Making the operator
perform that single documented call once - and configuring only the resulting
refresh token - is a strictly better credential story (see `docs/limitations.md`).

Because the documented token endpoint is a **GET with query parameters**, the
refresh token necessarily appears in that request URL. That is upstream's
documented design, not a choice; the connector therefore never logs the token
URL or response, and a test asserts the URL never reaches a log line.

## Endpoints - VERIFIED

| Tool | Endpoint | Method | Notes |
|---|---|---|---|
| `unicommerce_search_sale_orders` | `/services/rest/v1/oms/saleOrder/search` | **POST** | Level: Tenant, `Content-Type: application/json` |
| `unicommerce_get_sale_order` | `/services/rest/v1/oms/saleorder/get` | **POST** | Request field `code` is the only **Mandatory** one |

Both take a JSON request body, which is why the shared `HttpClient` gained a
generic `postJson()` (same reliability pipeline as `get()`; no provider-local
`fetch`, no duplicated retry/auth/logging code).

### Search request fields (all documented)

`displayOrderCode`, `status`, `channel`, `customerEmailOrMobile`,
`customerName`, `cashOnDelivery`, `fromDate`, `toDate`, `dateType`
(`CREATED` | `UPDATED` | `FULFILLMENT_TAT`), `facilityCodes`,
`returnStatuses`, `onHold`, `updatedSinceInMinutes`, and `searchOptions`
(`searchKey`, `displayStart`, `displayLength`, `columns`, `sortingCols`,
`sortColumnIndex`, `sortDirection`, `columnNames`, `getCount`).

Only the merchant-relevant subset is exposed. Deliberately **not** exposed:
`columns`, `columnNames`, `sortingCols`, `sortColumnIndex`, `sortDirection`
(UI-column plumbing with tenant-specific column sets), `updatedSinceInMinutes`
and `returnStatuses` (incidental). They are documented but would add tool
surface without adding a merchant capability.

### Pagination - VERIFIED mechanism

Unicommerce pages by **offset**, not by page number: `searchOptions.displayStart`
plus `searchOptions.displayLength`, with `totalRecords` returned when
`getCount` is requested. The adapter maps the connector's 1-based `page`/`perPage`
onto `displayStart = (page-1) * perPage` and reports `total` from
`totalRecords`; `hasMore` is derived from those two documented values.

Neither a default nor a maximum for `displayLength` is documented, so the
connector's `perPage` default of 50 and cap of 100 are **connector-imposed**
values, labelled as such in the tool description.

### Get response fields used - VERIFIED

`saleOrderDTO`: `code`, `displayOrderCode`, `channel`, `source`, `status`,
`displayOrderDateTime`, `channelProcessingTime`, `created`, `updated`,
`fulfillmentTat`, `notificationEmail`, `notificationMobile`, `customerGSTIN`,
`cod`, `thirdPartyShipping`, `priority`, `currencyCode` (documented default
INR), `customerCode`, `billingAddress`, `cancellable`, `reversePickable`,
`totalDiscount`, `totalShippingCharges`, `additionalInfo`, `saleOrderItems`.

`saleOrderItems[]`: `id`, `code`, `itemName`, `itemSku`, `sellerSkuCode`,
`statusCode`, `facilityCode`, `facilityName`, `shelfCode`,
`shippingPackageCode`, `shippingPackageStatus`, `shippingMethodCode`,
`sellingPrice`, `totalPrice`, `discount`, `taxPercentage`, `cancellable`,
`onHold`, `cancellationReason`, `created`, `updated`.

### Enumerations - VERIFIED (so labels are documented, not invented)

- Sale-order `status` (5): `PENDING_VERIFICATION`, `CANCELLED`, `CREATED`,
  `PROCESSING`, `COMPLETE`.
- Item `statusCode` (12): `CANCELLED`, `FULFILLABLE`, `CREATED`, `PROCESSING`,
  `PACKED`, `READY_TO_DISPATCH`, `DISPATCHED`, `DELIVERED`, `REPLACED`,
  `RETURN_REQUESTED`, `COURIER_RETURN`, `RETURNED`.
- Shipping method (4): `STD` (Standard), `EXP` (Express), `PKP` (Pickup),
  `CHQ` (Standard cheque).
- `dateType` (3): `CREATED`, `UPDATED`, `FULFILLMENT_TAT`.

An unrecognized code keeps its raw value with a humanized label, so a new
Uniware status degrades instead of crashing.

### Timestamps

The docs show **epoch-millisecond numbers** (`1598293800000`) in the DTO and ISO
text in the search example, so both are accepted and normalized to ISO-8601.
An agent never has to know which form a field used.

## Errors - VERIFIED, and Unicommerce-specific

Every response is wrapped in `{ successful, message, errors[], warnings[], ... }`
and `errors[]` entries carry `{ code, fieldName, description, message }`, with
codes catalogued at `response-codes.html` (e.g. `INVALID_TOKEN 100209`,
`INVALID_SALE_ORDER_CODE 40005`, `INVALID_TENANT 100084`).

**The important consequence**: a rejected request is still an **HTTP 200** with
`successful: false`. Validating the payload first would report "unexpected
payload shape", and ignoring `successful` would report "no orders found". The
adapter therefore checks the documented `errors[]` channel **before** the
resource schema:

- documented auth codes (`INVALID_TOKEN`, tenant/credential codes) ->
  `AUTHENTICATION_ERROR`, with the 30-day refresh-token hint;
- any other application error -> `VALIDATION_ERROR`, `retryable: false`, quoting
  the upstream code so the operator can look it up in the catalog. No error class
  is invented for codes whose meaning is not documented.

HTTP-level failures use the shared status mapping; 429 becomes `RATE_LIMITED`
with a hint that states outright that **no rate limit is documented**, rather
than inventing a budget.

## UNVERIFIED / deliberate gaps

| Item | Status | Consequence |
|---|---|---|
| **Rate limits** | Not published on any page checked (searched OAuth, sale order, response codes, URL details) | Live pacing is a conservative connector value (1s) and the 429 hint says the budget is unknown |
| **HTTP status taxonomy** | The catalog documents body codes only; no per-status meaning is published | HTTP failures map by shared status rules; body codes are used for detail |
| **`cashOnDelivery` default** | Documented as "true if COD" with "Default: true"; what the default does when the field is absent is NOT documented | The field is omitted unless the caller sets it explicitly, and the tool description warns that omitting it does not guarantee "all orders" |
| **Code for a non-existent order** | `INVALID_SALE_ORDER_CODE 40005` exists, but the docs do not state that it is what a tenant returns for an unknown code | No NOT_FOUND mapping is invented; the error surfaces as `VALIDATION_ERROR` with the upstream code quoted. The fixture uses 40005 and says so |
| **`searchKey` match behavior** | Documented only as "search keywords" | Tool description says match behavior is undocumented; exact lookups should use `displayOrderCode` |
| **`totalRecords` under filters** | Documented as "Total no. of records found"; the docs do not spell out filtered-vs-unfiltered | Implemented as the filtered total (the only coherent reading) and asserted in fixtures |
| **Password grant automation** | Documented and working, but requires storing a tenant login password | Not implemented; operator performs it once and configures the refresh token |
| **Sorting (`sortColumnIndex`, `sortDirection`, `columns`)** | Documented but tied to tenant-specific UI column sets | Not exposed - no verifiable merchant capability |
| **Facility/search facets beyond the listed filters** | Unicommerce exposes facility, item, invoice and export APIs, none verified here | Out of scope; only sale orders are implemented |

## Explicitly out of scope for V1

Create/update/verify/hold/cancel sale orders, item and inventory APIs, shipping
packages, manifests, invoices, returns, purchase orders, customer APIs, reports
and exports - all of which exist in the documentation but none were verified for
this phase.

## Models (why they are not the WooCommerce or Zoho ones)

A Unicommerce sale order is a warehouse-fulfilment document: per-line
`facilityCode`/`shelfCode`/`shippingPackageCode`, a 12-value item status
taxonomy, `priority`, `cod`/`thirdPartyShipping`, `customerGSTIN`, and
epoch-millisecond timestamps. Overlaying it on the WooCommerce order shape
(string decimals, no fulfilment state) or the Zoho one (ISO dates, shipment
progress) would either misreport money/dates or drop the warehouse dimension,
so the model lives in `src/capabilities/unicommerceOrders.ts` with
`SaleOrderSearchable` / `SaleOrderReadable` capabilities.
