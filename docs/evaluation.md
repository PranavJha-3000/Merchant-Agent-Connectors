# Agent Evaluation

API unit tests prove the connector works. They do not prove an agent can *use* it.
The evaluation layer closes that gap deterministically, without putting an LLM in
the test suite.

## Model

Each evaluation task is expressed as:

```
business scenario -> expected tool -> expected arguments -> expected result class
                  -> expected failure behavior -> success criterion
```

"Result class" is one of: `success` (optionally with a minimum/exact item count or
`empty`), or `error` with a specific `code` and `retryable` flag. Those are the
contracts an agent depends on when it decides whether to retry, report, or move on.

## Tasks (Freshdesk, all deterministic)

| # | Task id | Scenario | Tool | Expected outcome |
|---|---|---|---|---|
| 1 | `find-unresolved-ticket` | Find open high-priority tickets to triage | `freshdesk_search_tickets` | success, >= 1 item |
| 2 | `retrieve-known-ticket` | Details for a known id | `freshdesk_get_ticket` | success |
| 3 | `find-by-customer-email` | Customer emails in; find their tickets | `freshdesk_list_tickets` (`requesterEmail`) | success, >= 1 item |
| 4 | `browse-recent-tickets` | Browse the recent queue | `freshdesk_list_tickets` | success, >= 1 item |
| 5 | `read-ticket-conversation` | Read the reply history before responding | `freshdesk_list_ticket_conversations` | success, >= 3 items |
| 6 | `empty-search-is-not-an-error` | Nothing matches the search | `freshdesk_search_tickets` | success with `items: []` |
| 7 | `unknown-id-is-not-found` | Id does not exist | `freshdesk_get_ticket` | `NOT_FOUND`, `retryable: false` |
| 8 | `stop-after-auth-failure` | Credentials rejected | `freshdesk_list_tickets` | `AUTHENTICATION_ERROR`, `retryable: false` |
| 9 | `respect-rate-limit` | Upstream rate-limits the call | `freshdesk_list_tickets` | `RATE_LIMITED`, `retryable: true` |
| 10 | `recover-from-transient-5xx` | One transient 500 | `freshdesk_get_ticket` | success (recovery is invisible to the agent) |
| 11 | `reject-invalid-arguments-pre-network` | Malformed input | `freshdesk_get_ticket` | `VALIDATION_ERROR`, and **no upstream call** |

Task 11 additionally asserts a request counter did not move, encoding
"validation happens before the network" as a testable property.

## Tasks (WooCommerce, all deterministic)

| # | Task id | Scenario | Tool | Expected outcome |
|---|---|---|---|---|
| 1 | `browse-recent-orders` | See recent orders to triage fulfilment work | `woocommerce_list_orders` | success, >= 1 item |
| 2 | `find-unfulfilled-orders` | List orders awaiting fulfilment | `woocommerce_list_orders` (`status: 'processing'`) | success, 1 item |
| 3 | `retrieve-known-order` | Line items and payment dates for id 42 | `woocommerce_get_order` | success |
| 4 | `find-customer-orders-by-id` | Customer's orders by numeric customer id | `woocommerce_list_orders` (`customerId`) | success, 2 items |
| 5 | `find-product-by-sku` | Warehouse asks about a SKU | `woocommerce_list_products` (`sku`) | success, 1 item |
| 6 | `check-stock-levels` | Which products are out of stock | `woocommerce_list_products` (`stockStatus`) | success, 1 item |
| 7 | `empty-filter-is-not-an-error` | No refunded orders exist | `woocommerce_list_orders` (`status: 'refunded'`) | success with `items: []` |
| 8 | `unknown-order-id-is-not-found` | Order id does not exist | `woocommerce_get_order` | `NOT_FOUND`, `retryable: false` |
| 9 | `stop-after-auth-failure` | Store rejects the API key | `woocommerce_list_orders` | `AUTHENTICATION_ERROR`, `retryable: false` |
| 10 | `reject-invalid-arguments-pre-network` | `productId: 0` | `woocommerce_get_product` | `VALIDATION_ERROR`, and **no upstream call** |

## Tasks (Zoho Inventory, all deterministic)

| # | Task id | Scenario | Tool | Expected outcome |
|---|---|---|---|---|
| 1 | `stock-lookup-by-sku` | Warehouse asks about a known SKU | `zoho_list_items` (`sku`) | success, 1 item with `stockOnHand` |
| 2 | `find-low-stock-items` | Ops asks what needs reordering | `zoho_list_items` (`filterBy: 'Status.Lowstock'`) | success, every item has `stockOnHand <= reorderLevel` |
| 3 | `retrieve-known-item` | Item detail for a given id | `zoho_get_item` | success |
| 4 | `review-order-book` | Page through sales orders | `zoho_list_sales_orders` | success, `total: null`, `hasMore` from `page_context` |
| 5 | `explain-late-order` | Shipment state of one order | `zoho_get_sales_order` | success, `shipmentDate: null` + `isBackorder: true` |
| 6 | `empty-stock-search-is-not-an-error` | Nothing matches the search | `zoho_list_items` | success with `items: []` |
| 7 | `unknown-item-id-is-not-found` | Item id does not exist | `zoho_get_item` | `NOT_FOUND`, `retryable: false` |
| 8 | `reject-invalid-arguments-pre-network` | Non-numeric `itemId` | `zoho_get_item` | `VALIDATION_ERROR`, and **no upstream call at all** (not even a token request) |
| 9 | `undocumented-filter-is-rejected` | Invented `sortColumn` | `zoho_list_items` | `VALIDATION_ERROR` - unverified parameters cannot reach the API |
| 10 | `respect-quota-rate-limit` | 429 with documented quota code 45 | `zoho_list_items` | `RATE_LIMITED`, `retryable: true`, hint names the 100/min + daily quotas |
| 11 | `token-never-leaks-to-the-agent` | Normal read | `zoho_list_items` | exactly ONE token exchange (singleflight) and no token in the response |

Task 8 asserts the call counter never moves, encoding "validation happens before
any network I/O - including OAuth" as a testable property. Task 11 asserts the
token lifecycle is invisible to the agent.

## Cross-provider routing (all three implemented)

| Merchant request | Correct tool | Why not the others |
|---|---|---|
| "Any urgent support tickets?" | `freshdesk_search_tickets` | tickets are a different resource |
| "Which orders are waiting to ship?" | `woocommerce_list_orders` (`status: 'processing'`) | Zoho has no documented status filter; Freshdesk has no orders |
| "Where is order SO-00004?" | `zoho_get_sales_order` | WooCommerce ids are numeric store ids, not `SO-…` numbers |
| "Is ACC-BLUE-M in stock?" | `zoho_list_items` (`sku`) | WooCommerce products carry `stockStatus`, not `stockOnHand` |
| "What did we tell the customer?" | `freshdesk_list_ticket_conversations` | only Freshdesk exposes a conversation thread |

Both suites live in `test/eval/` and assert tool selection, argument shapes,
result classes, empty-vs-missing discrimination, and retryable signalling -
the deterministic contract an LLM depends on.

## Why there is no LLM in the loop

Evaluations test the *contract an agent relies on* - tool existence and naming,
argument shapes, result shapes, empty-vs-missing distinction, and retryable
signalling. Those are deterministic properties. Adding a model would make the
suite non-deterministic, slow, and dependent on a provider, while testing the model
rather than the connector.

An end-to-end agent loop is instead available as an interactive demonstration:
`npm run demo` and the stdio server.

## Signals captured for cross-provider comparison

Every error payload carries `provider`, `operation`, `code`, `retryable`,
`attempts`, and `correlationId`. That yields comparable per-provider metrics for a
future harness:

- tool-selection correctness (#1 vs #3 vs #4, #2 vs #7)
- empty-vs-error discrimination (#6 vs #7)
- failure reaction: stop vs retry (#8 vs #9 vs #10)
- upstream efficiency: attempts per successful task

## Adding an evaluation task

1. Add a `{ id, scenario, tool, args, expect }` entry in
   `test/eval/freshdesk.eval.test.ts` (or the provider's eval file).
2. Prefer realistic merchant phrasing in `scenario`.
3. Assert on the agent-visible result class, not internals.
4. If the task needs a specific upstream failure, supply a `fetchImpl` stub.