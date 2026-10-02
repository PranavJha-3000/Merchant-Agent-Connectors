# Agent Capabilities

What the connector lets an agent do today, and how it is steered.

## Available tools

| Tool | One-line purpose |
|---|---|
| `freshdesk_list_tickets` | Browse tickets (paging, preset views, requester email, updated-since) |
| `freshdesk_get_ticket` | Fetch one ticket by id |
| `freshdesk_search_tickets` | Find tickets by field conditions |
| `freshdesk_list_ticket_conversations` | Read a ticket's reply/note thread |
| `woocommerce_list_orders` | Browse orders (paging, status, customer, product, date range) |
| `woocommerce_get_order` | Fetch one order by id (line items, payment, customer note) |
| `woocommerce_list_products` | Find products (search, exact SKU, status, stock state) |
| `woocommerce_get_product` | Fetch one product by id (price, stock, categories) |
| `zoho_list_items` | Find inventory items (SKU, search, low-stock/inactive views, sorting) |
| `zoho_get_item` | Fetch one item by id (stock on hand, reorder level, tax, codes) |
| `zoho_list_sales_orders` | Page through Zoho sales orders (shipment state, totals) |
| `zoho_get_sales_order` | Fetch one sales order by id (line items, shipment progress) |

Full contract: `docs/tool-spec.md`.

## Merchant workflows it supports

**Triage the open queue.** `freshdesk_search_tickets` with a status/priority
condition lists what needs attention first; each result carries the id needed for
`freshdesk_get_ticket`.

**Answer "what is happening with this customer?"** `freshdesk_list_tickets` with
`requesterEmail`, then `freshdesk_get_ticket` for the detail, then
`freshdesk_list_ticket_conversations` for the history.

**Check what changed recently.** `freshdesk_list_tickets` with `updatedSince` (and
`orderBy: updated_at`).

**Escalation awareness.** Ticket detail exposes `isEscalated`, `dueBy` and
`firstResponseDueBy`, so an agent can prioritise by deadline.

**Work the fulfilment queue.** `woocommerce_list_orders` with
`status: 'processing'` (or `pending` / `on-hold`) lists unfulfilled work;
`woocommerce_get_order` gives the line items, payment date, and shipping city.

**Answer "where is my order?"** `woocommerce_list_orders` by `customerId` (the
docs have no email filter - the description steers the agent to the numeric id
or `search`), then `woocommerce_get_order` for status and dates.

**Check a SKU or stock.** `woocommerce_list_products` with the exact `sku`
filter (preferred) or `search`, then `woocommerce_get_product` for detail;
`stockStatus: 'outofstock'` answers "what can't we ship?".

**Answer "do we still have it?" (Zoho).** `zoho_list_items` with `sku` for an
exact lookup, or `filterBy: 'Status.Lowstock'` for "what needs reordering?" -
each item carries `stockOnHand` next to `reorderLevel`, which is the comparison a
support agent actually needs.

**Check where an order is.** `zoho_list_sales_orders` pages the order book;
`zoho_get_sales_order` shows shipment progress (`quantityShipped`,
`shipmentDate`, `isBackorder`) plus line items - i.e. "why is SO-00004 late?" is
answerable without leaving the connector.

**Keep tenants separated.** Zoho requests always carry the configured
`organization_id`; an agent cannot query another organization because the tool
schemas do not accept one.

## How the tools steer the agent

- **Names disambiguate siblings.** `list` vs `get` vs `search` vs
  `list_ticket_conversations`; there are no two tools that could do the same job.
- **Descriptions state when NOT to use a tool**, which is what prevents the common
  agent failure of searching for an id it already has, or listing when an email
  filter would be exact.
- **Empty vs missing is explicit.** A search with no matches is a success with
  `items: []`; an unknown id is `NOT_FOUND`. The agent can tell "nothing matched"
  from "this does not exist".
- **Retryability is explicit.** Every error payload carries `retryable` plus a
  short hint, so the agent knows whether to wait, retry, or stop and report.
- **Failure codes are stable** (`AUTHENTICATION_ERROR`, `RATE_LIMITED`, ...), so
  agent logic can branch on `code` rather than parsing prose.
- **Correlation ids** are on every payload for operator hand-off.
- **Private notes are flagged.** `isPrivate: true` marks internal agent notes; the
  description instructs the agent not to quote them to a customer.

## What the agent cannot do (by design)

- Create, update, close, reply to, or delete anything (all providers are read-only)
- Access attachments, contact records, refunds, or order notes
- Reach Unicommerce today (designed, not implemented - see `docs/provider-matrix.md`)
- Filter WooCommerce orders by customer email (upstream documents no such parameter)
- Filter Zoho sales orders by status/date/customer (upstream documents no such parameter)
- Choose which Zoho organization is queried (`organization_id` is configuration)
- Bypass input validation (invalid arguments are rejected before any network call)
- Read another tenant's data (credentials scope every request)

## Example task -> tool mapping

| Merchant request | Tool sequence |
|---|---|
| "Any open high-priority tickets?" | `freshdesk_search_tickets({ query: 'status:2 AND priority:3' })` |
| "What is ticket 101 about?" | `freshdesk_get_ticket({ ticketId: 101 })` |
| "Show me everything from mia.torres@example.test" | `freshdesk_list_tickets({ requesterEmail: 'mia.torres@example.test' })` |
| "What did we tell the customer on ticket 101?" | `freshdesk_list_ticket_conversations({ ticketId: 101 })` |
| "What changed since Monday?" | `freshdesk_list_tickets({ updatedSince: '<iso>', orderBy: 'updated_at' })` |
| "Which orders are waiting to ship?" | `woocommerce_list_orders({ status: 'processing' })` |
| "Show me order 42" | `woocommerce_get_order({ orderId: 42 })` |
| "What has customer 7 ordered?" | `woocommerce_list_orders({ customerId: 7 })` |
| "Do we still have the ACC-BLUE-M bottle?" | `woocommerce_list_products({ sku: 'ACC-BLUE-M' })` |
| "Which products are out of stock?" | `woocommerce_list_products({ stockStatus: 'outofstock' })` |
| "Do we still have ACC-BLUE-M?" | `zoho_list_items({ sku: 'ACC-BLUE-M' })` |
| "What needs reordering?" | `zoho_list_items({ filterBy: 'Status.Lowstock' })` |
| "Why is SO-00004 late?" | `zoho_get_sales_order({ salesOrderId: '4815000000045208' })` |

These flows are also expressed as deterministic tests in `docs/evaluation.md`.