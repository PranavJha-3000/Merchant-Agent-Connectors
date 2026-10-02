# Agent Capabilities

What the connector lets an agent do today, and how it is steered.

## Available tools

| Tool | One-line purpose |
|---|---|
| `freshdesk_list_tickets` | Browse tickets (paging, preset views, requester email, updated-since) |
| `freshdesk_get_ticket` | Fetch one ticket by id |
| `freshdesk_search_tickets` | Find tickets by field conditions |
| `freshdesk_list_ticket_conversations` | Read a ticket's reply/note thread |

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

- Create, update, close, reply to, or delete anything
- Access attachments or contact records
- Reach any provider other than Freshdesk today
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

These flows are also expressed as deterministic tests in `docs/evaluation.md`.