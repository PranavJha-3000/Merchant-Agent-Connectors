# Security

Security here is implemented and tested, not just documented. The rules are in
`AGENTS.md` §9; the enforcement is in `src/core/redact.ts`, the loggers, the error
classes, and `test/security/secrets.test.ts`.

## Credential handling

| Concern | Implementation |
|---|---|
| Where secrets live | Environment variables only. `.env` is git-ignored; `.env.example` holds placeholders |
| Where secrets are used | Only inside `AuthStrategy.headers()` at request time (e.g. `Basic base64(apiKey:X)`) |
| Where secrets are stored | Nowhere on disk. V1 keeps token state in memory only |
| Failure to configure | `ConfigurationError` before any network call; the message names missing variables, never values |

## Redaction

`src/core/redact.ts` provides three layers of defense:

1. **Key-based** - any key matching `api_key|apikey|token|secret|password|authorization|credential|cookie|private_key|access_key`
   has its value replaced with `[REDACTED]`, at any depth.
2. **Value-based** - credential-shaped strings are scrubbed even without a telling
   key: `Basic …`, `Bearer …`, `Zoho-oauthtoken …`, `Token …`.
3. **Structural** - the JSON logger and the memory logger both funnel fields
   through redaction, and `ConnectorError` sanitizes its own message (control
   characters stripped, length capped, secrets scrubbed).

Correlation ids are always included so a sanitized error is still debuggable.

## What is deliberately never emitted

- `Authorization` header values, API keys, access/refresh tokens
- Raw upstream response bodies (only a short, allowlisted error detail string)
- Customer PII beyond what the tool is explicitly asked to return
- Internal stack traces (they stay server-side; the agent gets a code and hint)

## Fixture data

All fixtures are synthetic:

- emails use reserved domains (`@example.test`)
- names and order references are fictional (`ORD-7734`, `mia.torres@example.test`)
- the fixture API key is an obvious non-secret
  (`fd_fixture_key_not_a_real_secret`)

`test/security/secrets.test.ts` scans the fixture files and fails if an email uses
a real domain or a JWT-shaped string appears.

## Least privilege

- V1 is read-only on every provider; no tool can mutate merchant state.
- `docs/providers/freshdesk.md` notes which agent role/permission the API key
  needs (an agent that can read tickets; no admin requirement).
- Planned providers document their minimal scopes (WooCommerce read-only key;
  Zoho `ZohoInventory.*.READ`; Unicommerce read-capable user).

## What the security tests prove

`npm test -- test/security` asserts, across success, retry, 401, 429 and
malformed-payload flows:

1. no secret or base64 `Basic` payload appears in any log entry;
2. no secret appears in any tool error payload;
3. no `authorization` field is ever logged;
4. fixtures contain no real-domain email and no JWT-shaped string;
5. `.env` is git-ignored and absent from the working tree;
6. `.env.example` contains no real-looking secret.

## Reporting

This is a portfolio/assessment repository with no live deployments. If you find a
credential-handling defect, the correct fix is a failing test in
`test/security/` plus the code change - that is the repository's own bar.