# Merchant Agent Connectors

An MCP connector platform that gives AI agents secure, semantic access to merchant
systems. **Freshdesk is the reference implementation**; **WooCommerce**,
**Zoho Inventory** and **Unicommerce** are additional providers plugged into the
same architecture via the same extension seam, with no shared code duplicated.

The whole test suite and demo run with **zero credentials** (deterministic fixture
mode).

```
AI Agent / MCP Host
  -> MCP Server (stdio transport)
    -> Semantic tools (freshdesk_search_tickets, ...) - validated, schema'd
      -> Provider registry -> Provider adapter (routes, params, normalize, error map)
        -> Shared HTTP runtime (timeout, bounded retry, Retry-After, pacing, correlation IDs)
          -> External merchant APIs
```

## Quick start (zero credentials, no network)

```bash
npm install
npm test        # 249 pass, 1 skipped (the skip is the opt-in live smoke test)
npm run demo    # deterministic 15-step walkthrough incl. failure paths
```

## How this satisfies the brief

Each mandatory requirement, with the artifact that proves it:

| Requirement | Where it is satisfied |
|---|---|
| Authentication | Freshdesk HTTP Basic (`API_KEY:X`), verified at `docs/providers/freshdesk.md`; OAuth 2.0 (Zoho, Unicommerce) and HTTPS Basic (WooCommerce) for the others. Keys live only in env vars |
| List / get / search primitives | Four Freshdesk tools: `freshdesk_list_tickets`, `freshdesk_get_ticket`, `freshdesk_search_tickets`, `freshdesk_list_ticket_conversations` (`docs/tool-spec.md`) |
| Rate-limit handling | `Retry-After` (seconds + HTTP-date) honored and bounded, exponential backoff with jitter, in-process pacing, `RATE_LIMITED` + `retryAfterMs` surfaced to the agent (`docs/reliability.md`) |
| MCP tool specification | Semantic `provider_snake_case_operation` names, zod `inputSchema`/`outputSchema`, read-only annotations, `structuredContent` on success and `isError` on failure (`docs/tool-spec.md`) |
| Agent capability / limitation documentation | What the agent can and cannot do, and every UNVERIFIED behavior (`docs/agent-capabilities.md`, `docs/limitations.md`) |
| Setup and run instructions | This file: install, four commands, MCP host config, live mode (below) |
| Working demonstration | `npm run demo` - 15 steps covering all four providers, including retries, 401/429 handling and a rejected Unicommerce request (`docs/demo.md`) |
| Safe synthetic data | Fixtures use reserved domains (`example.test`, `example.com`) and fabricated values; no customer data, no credentials in the repo (`npm test -- test/security`) |

## Why this shape

| Decision | Rationale |
|---|---|
| Provider-prefixed semantic tools (`freshdesk_get_ticket`) | An agent picks the right tool from the name alone; raw paths and generic `get(resource, id)` routers are never exposed. |
| Capability interfaces (`TicketListable`, `TicketReadable`, ...) | Providers implement only what upstream truly supports. No fake universal schema across tickets/orders/items. |
| Plugin registry (no central provider enum) | Adding a provider = one new folder + one line in `src/providers/index.ts`. |
| Shared reliability layer | Retry, backoff, `Retry-After`, timeouts, pacing and correlation live in one tested place. |
| Read-only V1 | Every merchant-support task here is satisfiable with reads; writes add blast radius and scope risk with no assignment requirement. |
| Fixture-first | Reviewers can run everything immediately; live mode is opt-in. |

## Supported providers

| Provider | Status | Auth | Read capabilities |
|---|---|---|---|
| **Freshdesk** | reference implementation | API key (HTTP Basic) | tickets: list, get, search, conversations |
| **WooCommerce** | implemented (Phase 4) | REST API key (HTTPS Basic) | orders: list, get  - products: list, get |
| **Zoho Inventory** | implemented (Phase 5) | OAuth 2.0 (refresh token, in-memory) | items: list, get  - sales orders: list, get |
| **Unicommerce** | implemented (Phase 6) | OAuth 2.0 refresh grant (tenant host) | sale orders: search, get |

Full matrix and verification status: [`docs/provider-matrix.md`](docs/provider-matrix.md).
Honest gaps: [`docs/limitations.md`](docs/limitations.md).

## Requirements

- **Node.js >= 22.18** (LTS 22; verified on Node 24). The scripts run the
  TypeScript sources directly (`node src/demo/runDemo.ts`) using Node's built-in
  type stripping, which is **on by default from v22.18 / v23.6** - it does not
  exist on Node 20, which is why the floor is 22.18 rather than 20.
  Verified against https://nodejs.org/api/typescript.html (checked 2026-10-03).
- No API keys, accounts, or network access required for tests or the demo

## Install and run

```bash
npm install

npm test                 # full suite, no credentials, no network (1 skipped: live smoke)
npm run demo             # deterministic end-to-end demo incl. failure paths
npm run inspect:tools    # print the exact MCP tool surface
npm run build            # typecheck (tsc)
```

## Use it as an MCP server

```bash
# fixture mode (default) - safe, deterministic, no credentials
npm run serve:stdio
```

Point any MCP host (Claude Desktop, MCP Inspector, a custom client) at that command.
Wire it into a host config like:

```json
{
  "mcpServers": {
    "merchant-agent-connectors": {
      "command": "node",
      "args": ["src/mcp/mainStdio.ts"],
      "cwd": "/absolute/path/to/merchant-agent-connectors"
    }
  }
}
```

### Live mode (optional, explicit)

Copy `.env.example` to `.env` (git-ignored) and set:

```
CONNECTOR_MODE=live

# Freshdesk
FRESHDESK_DOMAIN=your-subdomain      # "acme" for acme.freshdesk.com
FRESHDESK_API_KEY=your-api-key       # create via Freshdesk Profile > API Key

# WooCommerce (HTTPS store only; use a READ-ONLY key)
WOOCOMMERCE_BASE_URL=https://shop.example.com
WOOCOMMERCE_CONSUMER_KEY=ck_your_key
WOOCOMMERCE_CONSUMER_SECRET=cs_your_secret

# Zoho Inventory (OAuth 2.0 - see docs/providers/zoho-inventory.md)
ZOHO_DATA_CENTER=com                   # com | in | eu | com.au | ca
ZOHO_ORGANIZATION_ID=10234695          # Manage Organizations in the admin console
ZOHO_CLIENT_ID=1000.xxxx               # OAuth app "Client ID"
ZOHO_CLIENT_SECRET=xxxx                # OAuth app "Client Secret"
ZOHO_REFRESH_TOKEN=1000.xxxx.xxxx      # obtained once via the auth-code flow

# Unicommerce (OAuth 2.0 - see docs/providers/unicommerce.md)
UNICOMMERCE_BASE_URL=https://yourtenant.unicommerce.com
UNICOMMERCE_REFRESH_TOKEN=your-refresh-token   # obtained once via the password grant
```

Zoho setup is a one-time operator step (the browser authorization-code flow with
`access_type=offline`), after which only the refresh token is needed. Scopes:
`ZohoInventory.items.READ`, `ZohoInventory.salesorders.READ`. Access tokens are
held **in memory only** and refreshed automatically.

```bash
CONNECTOR_MODE=live npm run serve:stdio

# optional: one live smoke test (skipped unless these are set)
FRESHDESK_DOMAIN=... FRESHDESK_API_KEY=... npx vitest run test/integration
```

Live mode uses read-only endpoints only (Freshdesk tickets; WooCommerce orders
and products; Zoho Inventory items and sales orders). Missing configuration fails
fast with a `ConfigurationError` before any network call, and credentials are
never logged.

## What the agent can do today

| Task | Tool |
|---|---|
| Find open/high-priority tickets to triage | `freshdesk_search_tickets` |
| Find tickets from a customer email | `freshdesk_list_tickets` (`requesterEmail`) |
| Browse the recent queue | `freshdesk_list_tickets` |
| Read one ticket in full | `freshdesk_get_ticket` |
| Read the reply/note thread | `freshdesk_list_ticket_conversations` |
| List unfulfilled / recent / filtered orders | `woocommerce_list_orders` (`status`, `after`, `customerId`, ...) |
| Read one order (line items, payment, customer note) | `woocommerce_get_order` |
| Find a product by exact SKU or name | `woocommerce_list_products` (`sku` / `search`) |
| Check price and stock state of a product | `woocommerce_get_product` |
| Check real stock levels / what needs reordering | `zoho_list_items` (`sku`, `filterBy: 'Status.Lowstock'`) |
| Review the order book and shipment progress | `zoho_list_sales_orders`, `zoho_get_sales_order` |
| Find a sale order by code / status / channel | `unicommerce_search_sale_orders`, `unicommerce_get_sale_order` |
| Check which facility and shelf will fulfil a line | `unicommerce_get_sale_order` |

It cannot write anything, and it is told (in tool descriptions) to never quote
private agent notes to a customer. See [`docs/agent-capabilities.md`](docs/agent-capabilities.md).

## Documentation

| Document | Contents |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Engineering constitution: boundaries, rules, commands, definition of done |
| [`docs/architecture.md`](docs/architecture.md) | Layer-by-layer design and why the proposed diagram was corrected |
| [`docs/tool-spec.md`](docs/tool-spec.md) | Per-tool contract: purpose, when (not) to use, schemas, failures |
| [`docs/reliability.md`](docs/reliability.md) | Retry matrix, backoff formula, `Retry-After`, pacing/concurrency |
| [`docs/security.md`](docs/security.md) | Secret handling, redaction, what the tests prove |
| [`docs/testing.md`](docs/testing.md) | Test categories and what each one demonstrates |
| [`docs/evaluation.md`](docs/evaluation.md) | Agent-task evaluation fixtures and how to add one |
| [`docs/demo.md`](docs/demo.md) | The reproducible reviewer demo, step by step |
| [`docs/adding-a-provider.md`](docs/adding-a-provider.md) | Step-by-step provider extension guide |
| [`docs/providers/freshdesk.md`](docs/providers/freshdesk.md) | Verified Freshdesk behaviors + sources |
| [`docs/providers/woocommerce.md`](docs/providers/woocommerce.md) | Verified WooCommerce endpoints/parameters/auth + UNVERIFIED table |
| [`docs/providers/zoho-inventory.md`](docs/providers/zoho-inventory.md) | Verified Zoho OAuth/data-center/limits facts + UNVERIFIED table |
| [`docs/providers/unicommerce.md`](docs/providers/unicommerce.md) | Verified Unicommerce OAuth/sale-order/error facts + UNVERIFIED table |
| [`docs/limitations.md`](docs/limitations.md) | What is not built, unverified, or intentionally excluded |

## Security

Secrets live only in environment variables; `.env` is git-ignored; all fixture data
is synthetic (`*.test` / `*.example` domains).

```bash
npm test -- test/security     # proves creds cannot leak into logs/errors/responses
```

## License

MIT
