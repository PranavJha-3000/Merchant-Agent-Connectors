# Unicommerce

Status: **designed; deliberately not implemented**. UNVERIFIED areas are called out
explicitly rather than guessed at.

## Source

| What | Source | Checked |
|---|---|---|
| OAuth / token documentation | https://documentation.unicommerce.com/docs/oauth.html | 2026-10-02 |

## Authentication - PARTIALLY VERIFIED

The official documentation describes an OAuth token endpoint where a grant is
exchanged for an access token (with a refresh token and expiry), and subsequent
calls are authenticated with a bearer token. Some details (for example the exact
client identifier used by the endpoint) are prescribed by Unicommerce's client
documentation and should be treated as tenant-specific configuration.

Access prerequisites are documented: the API user needs appropriate
administrative/facility access.

**What this means for implementation**: only the token mechanism described in the
official documentation would be implemented. No alternative credential scheme will
be invented, and no endpoint will be called before its path is verified.

## UNVERIFIED - blocks implementation

The following could not be verified from official documentation during this work
and are therefore **not implemented**:

- exact path, HTTP method and request body for **sale-order search**
- exact path and method for **sale-order retrieval by id**
- pagination contract for these endpoints (page/size fields, cursors, totals)
- filtering/search fields and their accepted values
- response schema for sale-order objects (fields to normalize)
- error envelope shape and status-code meanings
- documented rate limits and retry behavior
- precise token refresh/renewal semantics and expiry handling

## Planned tools (design intent only, not implemented)

`unicommerce_search_sale_orders`, `unicommerce_get_sale_order`.

## Why nothing was written

Every other provider in this repository follows the rule in AGENTS.md §6: only
verified endpoints and parameters are sent. Unicommerce's publicly available
documentation did not allow that verification for the read paths above, so shipping
guessed paths would have produced exactly the failure mode this project is meant to
prevent - a connector that looks complete and breaks in production.

If access to a Unicommerce sandbox or its full client documentation becomes
available, the work is bounded: verify the paths and schemas, then follow
`docs/adding-a-provider.md`. The shared HTTP, auth, error, testing and evaluation
infrastructure is already in place and would be reused unchanged.