import { executeToolDefinition, type ToolDefinition } from '../core/tools.ts';
import { createMemoryLogger, type MemoryLogger } from '../core/logger.ts';
import type { FetchLike } from '../core/http.ts';
import { buildConnectorTools } from '../mcp/server.ts';
import { providerModules } from '../providers/index.ts';
import { createFixtureFetch } from '../fixtures/transport.ts';
import { freshdeskFixtureRoutes } from '../providers/freshdesk/routes.ts';

/**
 * Deterministic end-to-end demo - zero credentials, zero network.
 *
 *   npm run demo
 *
 * Walks the full path an agent experiences:
 *   tool discovery -> semantic invocation -> validation -> provider adapter ->
 *   shared HTTP layer -> fixture upstream -> normalized result -> agent payload
 * and then deliberately exercises failure behavior:
 *   404 not-found, 429 rate limit (with internal recovery), 401 unauthorized.
 *
 * Output is ASCII-only for terminal portability. Timestamps (fetchedAt, log ts)
 * differ per run by design; everything else is reproducible. Expected
 * transcript: docs/demo.md.
 */

const fixtureFetch: FetchLike = createFixtureFetch({ routes: freshdeskFixtureRoutes() });

function build(fetchImpl?: FetchLike): { tools: Map<string, ToolDefinition>; logger: MemoryLogger } {
  const logger = createMemoryLogger();
  const bundles = buildConnectorTools({
    modules: providerModules,
    mode: 'fixture',
    logger,
    env: {},
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const tools = bundles.flatMap((b) => b.tools);
  return { tools: new Map(tools.map((t) => [t.name, t])), logger };
}

function heading(title: string): void {
  process.stdout.write(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n`);
}

/** Trim the agent-facing payload for readable demo output (full shape stays in structuredContent). */
function summarize(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    provider: data['provider'],
    page: data['page'],
    hasMore: data['hasMore'],
    total: data['total'],
    items: data['items'],
  };
  if (data['ticket']) out['ticket'] = data['ticket'];
  if (data['query']) out['query'] = data['query'];
  if (data['ticketId'] !== undefined) out['ticketId'] = data['ticketId'];
  return out;
}

async function show(label: string, tools: Map<string, ToolDefinition>, name: string, args: unknown): Promise<void> {
  process.stdout.write(`\n$ ${name}(${JSON.stringify(args)})   [${label}]\n`);
  const result = await executeToolDefinition(tools.get(name)!, args);
  const summary = result.isError
    ? (JSON.parse(result.content[0]!.text) as Record<string, unknown>)
    : summarize(result.structuredContent as Record<string, unknown>);
  process.stdout.write(`${result.isError ? 'ERR ' : 'OK  '} ${JSON.stringify(summary, null, 2)}\n`);
}

async function main(): Promise<void> {
  process.stdout.write('Merchant Agent Connectors - deterministic fixture-mode demo (no credentials)\n');

  heading('STEP 1 | Tool discovery (tools/list equivalent)');
  const base = build();
  for (const name of [...base.tools.keys()].sort()) {
    const t = base.tools.get(name)!;
    const firstLine = t.description.split('. ')[0] ?? t.description;
    process.stdout.write(`  ${t.name.padEnd(36)} ${firstLine}\n`);
    process.stdout.write(`    readOnly=${t.annotations.readOnlyHint} destructive=${t.annotations.destructiveHint}\n`);
  }

  heading('STEP 2 | Search tickets (structured query, normalized output)');
  await show('search', base.tools, 'freshdesk_search_tickets', { query: 'status:2 AND priority:3' });

  heading('STEP 3 | Get one ticket by id');
  await show('get', base.tools, 'freshdesk_get_ticket', { ticketId: 101 });

  heading('STEP 4 | Read the conversation thread (private notes are flagged)');
  await show('thread', base.tools, 'freshdesk_list_ticket_conversations', { ticketId: 101 });

  heading('STEP 5 | Find tickets by requester email (list endpoint, not search)');
  await show('list', base.tools, 'freshdesk_list_tickets', { requesterEmail: 'mia.torres@example.test' });

  heading('STEP 6 | Failure: unknown ticket id -> NOT_FOUND (retryable:false)');
  await show('404', base.tools, 'freshdesk_get_ticket', { ticketId: 999999 });

  heading('STEP 7 | Failure: 429 rate limited -> internal retry, then recovery');
  let rateLimited = false;
  const flakyFetch: FetchLike = async (url, init) => {
    if (!rateLimited) {
      rateLimited = true;
      return new Response(JSON.stringify({ description: 'Rate limit exhausted' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return fixtureFetch(url, init);
  };
  const flaky = build(flakyFetch);
  await show('429 then recovered', flaky.tools, 'freshdesk_list_tickets', { perPage: 30 });
  process.stdout.write('\n  operator view (structured logs for that call):\n');
  for (const entry of flaky.logger.entries) {
    if (entry.message === 'http_retry' || entry.message === 'http_success') {
      process.stdout.write(`    ${JSON.stringify({ msg: entry.message, ...entry.fields })}\n`);
    }
  }

  process.stdout.write('\n  same failure, but persistent and with a long Retry-After:\n');
  const permanentlyLimited: FetchLike = async () =>
    new Response(JSON.stringify({ description: 'Rate limit exhausted' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '3600' },
    });
  await show('429 exhausted', build(permanentlyLimited).tools, 'freshdesk_list_tickets', {});
  process.stdout.write(
    '  (the connector will not sleep for an hour inside a tool call: it stops and\n'
      + '   reports the wait so the agent can decide.)\n',
  );

  heading('STEP 8 | Failure: 401 unauthorized -> AUTHENTICATION_ERROR, stop (no retries)');
  const brokenAuth: FetchLike = async () =>
    new Response(JSON.stringify({ description: 'Authentication failed' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  const unauthorized = build(brokenAuth);
  await show('401', unauthorized.tools, 'freshdesk_list_tickets', {});

  heading('DEMO COMPLETE');
  process.stdout.write(
    'Next: npm run inspect:tools  |  npm test  |  CONNECTOR_MODE=live FRESHDESK_DOMAIN=... FRESHDESK_API_KEY=... npm run serve:stdio\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`demo failed: ${String(error)}\n`);
  process.exit(1);
});
