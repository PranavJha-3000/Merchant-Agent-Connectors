# Demo

```bash
npm run demo            # deterministic, zero credentials, zero network
npm run inspect:tools   # print the MCP tool surface
```

The demo runs the real pipeline (MCP tool definitions -> adapter -> shared HTTP
client -> fixture upstream -> normalization -> agent payload). Only the upstream is
stubbed, and it is stubbed at the `fetch` boundary, so auth headers, retries,
`Retry-After`, validation and error mapping all execute for real.

Run time is about one second. Only `fetchedAt`/`ts` fields differ between runs.

## Transcript outline

**STEP 1 - Tool discovery.** Lists the eight tools (4 Freshdesk +
4 WooCommerce) with their first description line and read-only annotations,
i.e. exactly what `tools/list` advertises.

**STEP 2 - Search.** `freshdesk_search_tickets({ query: 'status:2 AND priority:3' })`
returns `total: 1` with normalized `status: {code: 2, label: 'Open'}` and
`priority: {code: 3, label: 'High'}`.

**STEP 3 - Get.** `freshdesk_get_ticket({ ticketId: 101 })` returns the detail
model including `descriptionText` and allowlisted `customFields`.

**STEP 4 - Thread.** `freshdesk_list_ticket_conversations({ ticketId: 101 })`
returns three messages oldest-first; the third has `isPrivate: true`.

**STEP 5 - Email lookup.** `freshdesk_list_tickets({ requesterEmail: ... })` shows
the list endpoint being used for the job search would do less well.

**STEP 6 - Failure (404).**

```json
{
  "code": "NOT_FOUND",
  "message": "Upstream 404 on freshdesk.getTicket: Resource not found",
  "provider": "freshdesk",
  "operation": "freshdesk_get_ticket",
  "retryable": false,
  "correlationId": "...",
  "status": 404,
  "attempts": 1,
  "hint": "The resource does not exist. Do not retry with the same ID."
}
```

Note `operation` is the tool the agent called; the finer adapter operation stays in
logs, joinable by `correlationId`.

**STEP 7 - Failure (429): recovery, then exhaustion.** The first call is answered
with 429 and `Retry-After: 0`; the client retries internally and the agent still
sees success. The demo prints the operator-side structured logs for that call -
note that the retry and the success share one correlation id:

```json
{"msg":"http_retry","provider":"freshdesk","operation":"freshdesk.listTickets","correlationId":"...","attempt":1,"delayMs":0,"status":429,"rateLimited":true,"retryAfterMs":0}
{"msg":"http_success","provider":"freshdesk","operation":"freshdesk.listTickets","correlationId":"...","attempts":2,"latencyMs":1,"statusCategory":"2xx","queryKeys":["page","per_page","filter","email","updated_since","order_by","order_type"]}
```

A second call is then answered with 429 forever plus `Retry-After: 3600`. Because
the wait exceeds the 60-second bound, the connector does **not** sleep for an hour
inside a tool call - it stops after one attempt and reports the wait:

```json
{
  "code": "RATE_LIMITED",
  "provider": "freshdesk",
  "operation": "freshdesk_list_tickets",
  "status": 429,
  "retryable": true,
  "retryAfterMs": 3600000,
  "attempts": 1,
  "hint": "Rate limited. Wait 3600s before retrying."
}
```

**STEP 8 - Failure (401).** Returns `AUTHENTICATION_ERROR`, `retryable: false`,
single attempt - an agent should stop and report a configuration problem rather
than retry.

**STEP 9 - WooCommerce (second provider, same architecture).**
`woocommerce_list_orders({ status: 'processing' })` returns the fixture order 42
with `status: {code: 'processing', label: 'Processing'}` and `total: '48.00'`
(money stays a string), and `woocommerce_list_products({ sku: 'ACC-BLUE-M' })`
narrows the catalog to one product. Both flows pass through the identical
registry -> adapter -> HTTP pipeline, only the provider module differs.

**STEP 10 - WooCommerce failure (404).** `woocommerce_get_order({ orderId: 999999 })`
returns the same `NOT_FOUND` / `retryable: false` envelope shape as Freshdesk's
404, with `provider: "woocommerce"` - identical failure contract across
providers.

## Reviewer script

```bash
npm install
npm test                # passing, 1 skipped (live), no credentials
npm run demo            # the walkthrough above
npm run inspect:tools   # confirm the tool surface matches docs/tool-spec.md
```

## Live mode (optional)

```bash
CONNECTOR_MODE=live FRESHDESK_DOMAIN=acme FRESHDESK_API_KEY=xxxx npm run serve:stdio
```

All tool calls then hit the real endpoints documented in
`docs/providers/freshdesk.md` (read-only). The live smoke test is opt-in:

```bash
FRESHDESK_DOMAIN=acme FRESHDESK_API_KEY=xxxx npx vitest run test/integration
```