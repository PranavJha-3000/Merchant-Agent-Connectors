# Merchant Agent Connectors

An MCP connector platform that gives AI agents secure, semantic access to merchant
systems. **Freshdesk is the reference implementation** and **WooCommerce is a
second provider plugged into the same architecture**; Zoho Inventory and
Unicommerce follow the identical extension seam without touching existing code.

The whole test suite and demo run with **zero credentials** (deterministic fixture
mode).

```
AI Agent / MCP Host
  -> MCP Server (stdio / Streamable HTTP)
    -> Semantic tools (freshdesk_search_tickets, ...) - validated, schema'd
      -> Provider registry -> Provider adapter (routes, params, normalize, error map)
        -> Shared HTTP runtime (timeout, bounded retry, Retry-After, pacing, correlation IDs)
          -> External merchant APIs
```

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
| **WooCommerce** | implemented (Phase 4) | REST API key (HTTPS Basic) | orders: list, get · products: list, get |
| Zoho Inventory | designed, not implemented | OAuth 2.0 (auth code + refresh) | items, sales orders (planned) |
| Unicommerce | designed, not implemented | OAuth token (docs verified in part) | sale orders (planned) |

Full matrix and verification status: [`docs/provider-matrix.md`](docs/provider-matrix.md).
Honest gaps: [`docs/limitations.md`](docs/limitations.md).

## Requirements

- Node.js >= 20 (developed and tested on Node 24)
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
```

```bash
CONNECTOR_MODE=live npm run serve:stdio

# optional: one live smoke test (skipped unless these are set)
FRESHDESK_DOMAIN=... FRESHDESK_API_KEY=... npx vitest run test/integration
```

Live mode uses read-only endpoints only (Freshdesk tickets; WooCommerce orders
and products). Missing configuration fails fast with a `ConfigurationError`
before any network call, and credentials are never logged.

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
| [`docs/providers/zoho-inventory.md`](docs/providers/zoho-inventory.md) | Zoho Inventory OAuth 2.0 plan + verification gaps |
| [`docs/providers/unicommerce.md`](docs/providers/unicommerce.md) | Unicommerce status: what is verified and what is explicitly UNVERIFIED |
| [`docs/limitations.md`](docs/limitations.md) | What is not built, unverified, or intentionally excluded |

## Security

Secrets live only in environment variables; `.env` is git-ignored; all fixture data
is synthetic (`*.test` / `*.example` domains).

```bash
npm test -- test/security     # proves creds cannot leak into logs/errors/responses
```

## License

MIT
