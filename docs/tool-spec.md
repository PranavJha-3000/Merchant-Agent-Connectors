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

## woocommerce_list_orders

**Purpose** - list a store's orders with pagination and optional filters
(status, customer, product, date range, free-form search).

**Use when** - browsing recent orders; finding a customer's orders by numeric
customer id; filtering unfulfilled work (status); locating an order id first.

**Do NOT use when** - you already have an order id (`woocommerce_get_order`).

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `page` | integer >= 1 | no (default 1) | 1-based |
| `perPage` | integer 1..100 | no (default 10) | WooCommerce default is 10; 100 is a **connector cap**, not a documented WooCommerce maximum |
| `status` | enum | no | `pending`, `processing`, `on-hold`, `completed`, `cancelled`, `refunded`, `failed`, `trash` - ONE value per call; omit for all |
| `search` | string 1..200 | no | Free-form; match behavior is store-defined - not an exact email lookup |
| `customerId` | integer >= 0 | no | WordPress user id; `0` = guest orders. No documented email filter exists |
| `productId` | integer >= 1 | no | Orders containing this product |
| `after` / `before` | ISO-8601 datetime | no | Published-date bounds (docs: "ISO8601 compliant date") |

**Output** - `{ provider, fetchedAt, page, perPage, hasMore, total, items[] }`
where `total` comes from the `X-WP-Total` header (null when a proxy strips it)
and `hasMore` from `X-WP-TotalPages` (Link `rel="next"` as fallback). Items are
`OrderSummary`: `{ provider, id, number, status{code,label}, currency, total,
customerId, createdAt, updatedAt }`; `total` stays a string decimal.

**Failure semantics** - 401 `AUTHENTICATION_ERROR`; 403 `AUTHORIZATION_ERROR`;
400/422 `VALIDATION_ERROR` with the upstream envelope message; 429
`RATE_LIMITED` (retryable, honors `Retry-After`); 5xx `UPSTREAM_UNAVAILABLE`
(retried internally first). Empty match = success with `items: []`.

**Security** - read-only; data scope equals the API key's WordPress role.

**Kind** - provider-specific tool wrapping the shared `OrderListable`
capability (semantics align with future sales-order providers).

---

## woocommerce_get_order

**Purpose** - fetch exactly one order by numeric id with line items, totals,
payment dates, customer note, and billing/shipping identifiers.

**Use when** - you already have an order id (from a list result or the user).

**Do NOT use when** - you only have a customer email/name/status - locate the
id with `woocommerce_list_orders` first.

**Input** - `orderId` (integer >= 1, required).

**Output** - `{ provider, fetchedAt, order }` where `order` is `OrderDetail`:
summary fields plus `datePaid, dateCompleted, paymentMethodTitle,
customerNote, billingName, billingEmail, shippingCity, shippingCountry,
lineItems[], itemCount`.

**Failure semantics** - unknown id -> `NOT_FOUND`, `retryable: false`.

**Security** - contains customer PII (name/email/address fragments) because
support workflows need it; the description instructs the agent to keep it
within the merchant context. Fixtures are synthetic.

**Kind** - provider-specific tool wrapping the shared `OrderReadable`
capability.

---

## woocommerce_list_products

**Purpose** - list store products with pagination and filters (search, exact
SKU, status, stock state).

**Use when** - finding a product by SKU or name; checking catalog status or
stock levels; locating a product id first.

**Do NOT use when** - you already have a product id
(`woocommerce_get_product`), or you need orders (`woocommerce_list_orders`).

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `page` | integer >= 1 | no (default 1) | 1-based |
| `perPage` | integer 1..100 | no (default 10) | Same connector cap as orders |
| `search` | string 1..200 | no | Free-form, store-defined match behavior |
| `sku` | string 1..100 | no | Exact SKU match (verified: "Limit result set to products with a specific SKU") |
| `status` | enum | no | `any`, `draft`, `pending`, `private`, `publish` (omit = documented default `any`) |
| `stockStatus` | enum | no | `instock`, `outofstock`, `onbackorder` |

**Output** - page envelope with `ProductSummary` items:
`{ provider, id, name, slug, sku, type, status, price, regularPrice,
salePrice, onSale, stockStatus, stockQuantity, manageStock, totalSales,
featured, createdAt, updatedAt }`.

**Failure semantics** - same matrix as orders; empty filter match is a success.

**Security** - read-only catalog data; no customer records in this resource.

**Kind** - provider-specific tool wrapping the shared `ProductListable`
capability.

---

## woocommerce_get_product

**Purpose** - fetch exactly one product by numeric id with price, stock state,
description, categories, tags, and permalink.

**Use when** - you already have a product id.

**Do NOT use when** - you only have a SKU or name - use
`woocommerce_list_products` (exact `sku` filter) first.

**Input** - `productId` (integer >= 1, required).

**Output** - `{ provider, fetchedAt, product }` where `product` is
`ProductDetail`: summary plus `permalink, shortDescription, description,
catalogVisibility, categories[], tags[], imageCount`.

**Failure semantics** - unknown id -> `NOT_FOUND`, `retryable: false`.

**Security** - read-only. Stock values are point-in-time; the description tells
the agent to re-fetch before acting on them.

**Kind** - provider-specific tool wrapping the shared `ProductReadable`
capability.

---

## zoho_list_items

**Purpose** - list Zoho Inventory items with pagination and documented filters
(search text, exact SKU, status views, sorting).

**Use when** - answering stock questions ("do we have X?", "what is below
reorder level?"), locating an item by name or SKU, or finding an item id.

**Do NOT use when** - you already have an item id (`zoho_get_item`), or you need
sales orders (`zoho_list_sales_orders` - items and orders are different
resources). Note Zoho items are NOT the same thing as WooCommerce products: this
is warehouse stock (`stockOnHand`, `reorderLevel`), not a storefront listing.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `page` | integer >= 1 | no (default 1) | 1-based |
| `perPage` | integer 1..500 | no (default 200) | 200 is Zoho's documented default; 500 is a **connector cap** (no maximum documented) |
| `searchText` | string 1..100 | no | Zoho `search_text`: "Search items by name, SKU, or other searchable fields" |
| `sku` | string 1..100 | no | Zoho `sku`: EXACT match - prefer this when the SKU is known |
| `filterBy` | enum | no | Documented `filter_by` status views: `Status.All`, `Status.Active`, `Status.Inactive`, `Status.Lowstock`, `Status.Unmapped`, `Status.Uncategorized`, `Status.Grouped`. ItemType views are deliberately not exposed |
| `sortColumn` | enum | no | `name`, `sku`, `rate`, `purchase_rate`, `created_time`, `last_modified_time`, `reorder_level`, `stock_on_hand` |
| `sortOrder` | enum | no | `A` ascending, `D` descending |

**Output** - page envelope `{ provider, fetchedAt, page, perPage, hasMore, total, items[] }`.
`total` is always `null` (Zoho reports no total) and `hasMore` comes from the
upstream `page_context.has_more_page`. Items are `InventoryItemSummary`:
`{ provider, id, name, sku, status, itemType, productType, groupName, rate,
stockOnHand, reorderLevel, isTaxable, createdAt, updatedAt }` with ids as
**strings** (16-digit Zoho ids preserved exactly) and money as a **number**.

**Failure semantics** - 401 `AUTHENTICATION_ERROR` (after one automatic token
refresh + replay); 400 `VALIDATION_ERROR` (hint names `organization_id`); 404
`NOT_FOUND`; 429 `RATE_LIMITED` (retryable, hint carries the documented
100 req/min + daily plan quotas); 5xx retried then `UPSTREAM_UNAVAILABLE`.
Empty match = success with `items: []`.

**Security** - read-only; requires `ZohoInventory.items.READ`. `organization_id`
is configuration, never an argument.

**Kind** - provider-specific tool wrapping the new `InventoryListable`
capability.

---

## zoho_get_item

**Purpose** - fetch exactly one Zoho item by `item_id`, with stock on hand,
reorder level, tax treatment, purchase data and item codes.

**Use when** - you already have an item id (from `zoho_list_items` or the user).

**Do NOT use when** - you only have a SKU or name - use `zoho_list_items`
(`sku`/`searchText`) first.

**Input** - `itemId` (numeric string or number, 1-20 digits, required).

**Output** - `{ provider, fetchedAt, item }` where `item` is `InventoryItemDetail`
(summary plus `description, purchaseDescription, purchaseRate, taxName,
taxPercentage, upc, ean, isbn, partNumber, attributeNames[], hasImage`).

**Failure semantics** - unknown id -> `NOT_FOUND`, `retryable: false`.

**Security** - read-only; product/catalog data, no customer records.

**Kind** - provider-specific tool wrapping `InventoryReadable`.

---

## zoho_list_sales_orders

**Purpose** - page through Zoho sales orders (shipment state, customer, totals).

**Use when** - reviewing the order book, checking what has shipped vs what is
still open, or locating a sales order id first.

**Do NOT use when** - you already have a sales order id (`zoho_get_sales_order`),
or you need stock data (`zoho_list_items`). Do NOT assume WooCommerce-style
filters: Zoho documents no status/date/customer filter for this endpoint.

**Input** - `page` (>= 1, default 1), `perPage` (1..500, default 200).

**Output** - page envelope with `SalesOrderSummary` items:
`{ provider, id, salesOrderNumber, referenceNumber, status, customerName,
customerId, date, total, currencyCode, baseCurrencyTotal, quantity,
quantityShipped, shipmentDate, createdAt, updatedAt }`. `total` is a **number**
here (unlike the WooCommerce string decimal) and ids are **strings**.
`status.label` is humanized from the raw code because Zoho does not publish the
full status enum.

**Failure semantics** - same matrix as items; empty page = success.

**Security** - read-only; requires `ZohoInventory.salesorders.READ`.
`customerName` is customer data - keep it inside the merchant context.

**Kind** - provider-specific tool wrapping the new `SalesOrderListable`
capability (deliberately NOT the WooCommerce order model - see
`docs/providers/zoho-inventory.md`).

---

## zoho_get_sales_order

**Purpose** - fetch exactly one Zoho sales order by `salesorder_id`, including
line items and shipment/invoicing progress.

**Use when** - you already have a sales order id.

**Do NOT use when** - you only have a customer name or a number fragment - page
through `zoho_list_sales_orders` first.

**Input** - `salesOrderId` (numeric string or number, 1-20 digits, required).

**Output** - `{ provider, fetchedAt, salesOrder }` where `salesOrder` is
`SalesOrderDetail` (summary plus `expectedShipmentDate, shipmentDays,
quantityInvoiced, quantityPacked, salesChannel, isEmailed, isDropShipment,
isBackorder, lineItems[], itemCount`).

**Failure semantics** - unknown id -> `NOT_FOUND`, `retryable: false`.

**Security** - read-only; contains customer name, so treat as customer data.

**Kind** - provider-specific tool wrapping `SalesOrderReadable`.

---

## unicommerce_search_sale_orders

**Purpose** - search Unicommerce sale orders with documented filters and paging.

**Use when** - you need to find an order (no code yet), review the order book, or
filter by status/channel/customer/date.

**DO NOT use when** - you already have a sale order code
(`unicommerce_get_sale_order`); search rows return only a summary.

**Input** - all optional unless noted:

| Field | Type | Notes |
|---|---|---|
| `page` / `perPage` | integer | `page` starts at 1 and maps to the documented offset pair; `perPage` default 50 / max 100 are **connector** values (no documented default or max for `displayLength`) |
| `displayOrderCode` | string | the documented order-code filter - use it for exact lookups |
| `status` | enum | `PENDING_VERIFICATION` \| `CANCELLED` \| `CREATED` \| `PROCESSING` \| `COMPLETE` |
| `channel` | string | tenant-specific channel code |
| `searchKey` | string | `searchOptions.searchKey`; match behavior undocumented |
| `customerEmailOrMobile`, `customerName` | string | documented customer filters |
| `cod` | boolean | documented as "true if COD" with "Default: true" - **UNVERIFIED** default semantics, sent only when explicitly set |
| `fromDate` / `toDate` | ISO-8601 | window, meaningful together with `dateType` |
| `dateType` | enum | `CREATED` \| `UPDATED` \| `FULFILLMENT_TAT` |
| `facilityCodes` | string[] | warehouse facility filter |
| `onHold` | boolean | on-hold filter |

**Output** - page envelope `{ provider, fetchedAt, page, perPage, hasMore, total,
items[] }` where `total` comes from the documented `totalRecords` and `hasMore`
is derived from it. Items are `UnicommerceSaleOrderSummary`: `{ provider, code,
displayOrderCode, channel, source, status, orderDate, createdAt, updatedAt,
fulfillmentTat, isCashOnDelivery, currencyCode, notificationEmail,
notificationMobile }`. Timestamps are ISO-8601 (upstream epoch millis).

**Failure semantics** - HTTP 200 with `successful: false` and `errors[]` (the
documented Unicommerce channel) becomes `VALIDATION_ERROR` with `retryable:
false` and the upstream code quoted; documented auth codes become
`AUTHENTICATION_ERROR`; 429 is `RATE_LIMITED` with a hint that no rate limit is
published. Empty match = success with `items: []`.

**Security** - read-only. Customer contact fields are customer data - keep them
inside the merchant context.

**Kind** - provider-specific tool wrapping the new `SaleOrderSearchable`
capability.

---

## unicommerce_get_sale_order

**Purpose** - fetch one Unicommerce sale order by its code, including line items
with item status, facility, shipping method and prices.

**Use when** - you already have a sale order code.

**DO NOT use when** - you only have a customer email/name, or no code at all.

**Input** - `code` (string, required): the documented **only mandatory** request
field.

**Output** - `{ provider, fetchedAt, saleOrder }` where `saleOrder` is
`UnicommerceSaleOrderDetail` (summary plus `customerCode`, `customerGstin`,
`priority`, `thirdPartyShipping`, `onHold`, `cancellable`, `reversePickable`,
`channelProcessingTime`, `additionalInfo`, `totalDiscount`,
`totalShippingCharges`, billing city/state/country/pincode, `items[]`,
`itemCount`). Items expose `status` (12-value documented enum), `shippingMethodCode`
(`STD`/`EXP`/`PKP`/`CHQ`), `facilityCode`, `shelfCode`, `shippingPackageCode` and
numeric prices.

**Failure semantics** - an unknown code returns the documented application error
as `VALIDATION_ERROR` with `retryable: false` and the Unicommerce error code.

**Security** - read-only; contains customer name/contact/billing fields.

**Kind** - provider-specific tool wrapping `SaleOrderReadable`.

---

## Planned tools (not implemented)

Design intent only; each requires verification before implementation. See
`docs/provider-matrix.md`.

| Provider | Planned tools | Source to verify |
|---|---|---|
| Zoho Inventory | items, sales orders — **VERIFIED** (Phase 5) | https://www.zoho.com/inventory/api/v1/ |
| Unicommerce | `unicommerce_search_sale_orders`, `unicommerce_get_sale_order` | https://documentation.unicommerce.com/ |

## Adding a tool

See `docs/adding-a-provider.md`. Every new tool must appear here in the same
change (AGENTS.md §13).