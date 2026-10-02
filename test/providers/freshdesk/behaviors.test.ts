import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/core/http.ts';
import type { ToolDefinition } from '../../../src/core/tools.ts';
import { executeToolDefinition } from '../../../src/core/tools.ts';
import { createFixtureFetch } from '../../../src/fixtures/transport.ts';
import { freshdeskFixtureRoutes } from '../../../src/providers/freshdesk/routes.ts';
import { freshdeskTools } from '../../helpers.ts';

const fixtureFetch = (): FetchLike => createFixtureFetch({ routes: freshdeskFixtureRoutes() });

async function run(tool: ToolDefinition | undefined, args: unknown): Promise<Record<string, any>> {
  expect(tool, 'tool must exist').toBeDefined();
  const result = await executeToolDefinition(tool!, args);
  if (result.isError) return { isError: true, error: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  return { isError: false, data: result.structuredContent as Record<string, unknown> };
}

describe('freshdesk_list_tickets', () => {
  it('returns a page envelope with link-based hasMore', async () => {
    const { byName } = freshdeskTools();
    const out = await run(byName.get('freshdesk_list_tickets'), {});
    expect(out.isError).toBe(false);
    const data = out.data!;
    expect(data['provider']).toBe('freshdesk');
    expect((data['items'] as unknown[]).length).toBe(2);
    expect(data['page']).toBe(1);
    expect(data['perPage']).toBe(30);
    expect(data['hasMore']).toBe(true); // fixture sets Link rel="next" on page 1
    expect(data['total']).toBeNull();
    const first = (data['items'] as Array<Record<string, unknown>>)[0]!;
    expect(first['id']).toBe(101);
    expect(first['status']).toEqual({ code: 2, label: 'Open' });
    expect(typeof data['fetchedAt']).toBe('string');
  });

  it('returns an empty page (success) on page 2', async () => {
    const { byName } = freshdeskTools();
    const out = await run(byName.get('freshdesk_list_tickets'), { page: 2 });
    expect(out.isError).toBe(false);
    expect(out.data!['items']).toEqual([]);
    expect(out.data!['hasMore']).toBe(false);
  });

  it('filters by requester email; unknown email yields empty (not an error)', async () => {
    const { byName } = freshdeskTools();
    const known = await run(byName.get('freshdesk_list_tickets'), { requesterEmail: 'mia.torres@example.test' });
    expect(known.isError).toBe(false);
    expect((known.data!['items'] as unknown[]).length).toBe(1);
    const unknown = await run(byName.get('freshdesk_list_tickets'), { requesterEmail: 'nobody@example.test' });
    expect(unknown.isError).toBe(false);
    expect(unknown.data!['items']).toEqual([]);
  });

  it('rejects out-of-range inputs before any network call', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response('[]', { status: 200 });
    };
    const { byName } = freshdeskTools({ fetchImpl });
    const out = await run(byName.get('freshdesk_list_tickets'), { perPage: 500 });
    expect(out.isError).toBe(true);
    expect(out.error!['code']).toBe('VALIDATION_ERROR');
    expect(out.error!['retryable']).toBe(false);
    expect(calls).toEqual([]); // no-network-on-validation-error
  });
});

describe('freshdesk_get_ticket', () => {
  it('returns a normalized detail with preserved custom fields', async () => {
    const { byName } = freshdeskTools();
    const out = await run(byName.get('freshdesk_get_ticket'), { ticketId: 101 });
    expect(out.isError).toBe(false);
    const ticket = out.data!['ticket'] as Record<string, unknown>;
    expect(ticket['id']).toBe(101);
    expect(ticket['status']).toEqual({ code: 2, label: 'Open' });
    expect(ticket['priority']).toEqual({ code: 3, label: 'High' });
    expect(ticket['descriptionText']).toContain('ORD-7734');
    expect(ticket['customFields']).toEqual({ cf_order_id: 'ORD-7734', cf_channel: 'web' });
    expect(ticket['isEscalated']).toBe(true);
  });

  it('maps unknown ids to NOT_FOUND (not retryable)', async () => {
    const { byName } = freshdeskTools();
    const out = await run(byName.get('freshdesk_get_ticket'), { ticketId: 999999 });
    expect(out.isError).toBe(true);
    expect(out.error!['code']).toBe('NOT_FOUND');
    expect(out.error!['retryable']).toBe(false);
    expect(out.error!['provider']).toBe('freshdesk');
    expect(out.error!['operation']).toBe('freshdesk_get_ticket');
    expect(out.error!['correlationId']).toBeTruthy();
    expect(out.error!['hint']).toContain('Do not retry');
  });
});

describe('freshdesk_search_tickets', () => {
  it('auto-wraps the query in quotes and returns {total, results} semantics', async () => {
    const captured: URL[] = [];
    const inner = createFixtureFetch({ routes: freshdeskFixtureRoutes(), onRequest: (u) => captured.push(u) });
    const { byName } = freshdeskTools({ fetchImpl: inner });
    const out = await run(byName.get('freshdesk_search_tickets'), { query: 'status:2' });
    expect(out.isError).toBe(false);
    expect(out.data!['total']).toBe(1);
    expect(out.data!['perPage']).toBe(30);
    expect(captured[0]!.searchParams.get('query')).toBe('"status:2"');
    const items = out.data!['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!['id']).toBe(101);
  });

  it('distinguishes empty search (success) from errors', async () => {
    const { byName } = freshdeskTools();
    const out = await run(byName.get('freshdesk_search_tickets'), { query: 'priority:9' });
    expect(out.isError).toBe(false);
    expect(out.data!['items']).toEqual([]);
    expect(out.data!['total']).toBe(0);
  });

  it('rejects queries over the 512-char Freshdesk limit before networking', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response('{"total":0,"results":[]}', { status: 200 });
    };
    const { byName } = freshdeskTools({ fetchImpl });
    const out = await run(byName.get('freshdesk_search_tickets'), { query: `status:2 AND ${'x'.repeat(520)}` });
    expect(out.isError).toBe(true);
    expect(out.error!['code']).toBe('VALIDATION_ERROR');
    expect(calls).toEqual([]);
  });
});

describe('freshdesk_list_ticket_conversations', () => {
  it('returns the thread oldest-first and flags private notes', async () => {
    const { byName } = freshdeskTools();
    const out = await run(byName.get('freshdesk_list_ticket_conversations'), { ticketId: 101 });
    expect(out.isError).toBe(false);
    const items = out.data!['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]!['isIncoming']).toBe(true);
    expect(items[2]!['isPrivate']).toBe(true);
    expect(items[1]!['isPrivate']).toBe(false);
    expect(items[0]!['ticketId']).toBe(101);
    expect(items[0]!['attachmentCount']).toBe(0);
  });

  it('passes merchant-provided text through verbatim (no mangling)', async () => {
    // Unicode can legitimately appear in merchant content; the connector must
    // never sanitize or re-encode customer text on its way to the agent.
    const unicodeBody = 'Caf\u00e9 \u00fcber alles \u2014 \u4e2d\u6587\u652f\u6301';
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify([
          { id: 1, ticket_id: 101, body_text: unicodeBody, incoming: true, private: false, created_at: '2026-01-01T00:00:00Z' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const { byName } = freshdeskTools({ fetchImpl });
    const result = await executeToolDefinition(byName.get('freshdesk_list_ticket_conversations')!, { ticketId: 101 });
    if (result.isError) throw new Error(result.content[0]!.text);
    const data = result.structuredContent as { items: Array<{ bodyText: string }> };
    expect(data.items[0]!.bodyText).toBe(unicodeBody);
  });

  it('maps conversations on an unknown ticket to NOT_FOUND', async () => {
    const { byName } = freshdeskTools();
    const out = await run(byName.get('freshdesk_list_ticket_conversations'), { ticketId: 424242 });
    expect(out.isError).toBe(true);
    expect(out.error!['code']).toBe('NOT_FOUND');
    expect(out.error!['retryable']).toBe(false);
  });
});
