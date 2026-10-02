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