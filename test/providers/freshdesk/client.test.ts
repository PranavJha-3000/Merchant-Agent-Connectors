import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from '../../../src/core/auth.ts';
import type { FetchLike } from '../../../src/core/http.ts';
import { executeToolDefinition, type ToolDefinition } from '../../../src/core/tools.ts';
import { freshdeskTools } from '../../helpers.ts';

/**
 * Request construction: proves only VERIFIED Freshdesk parameters are ever
 * sent, auth is Basic(apiKey:X), and correlation ids are attached.
 * Docs: https://developers.freshdesk.com/api/ (List/View/Search/Conversations).
 */

const FIXTURE_KEY = 'fd_fixture_key_not_a_real_secret';
const VERIFIED_LIST_PARAMS = new Set([
  'page',
  'per_page',
  'filter',
  'email',
  'updated_since',
  'order_by',
  'order_type',
  // client also supports company_id/unique_external_id internally; only
  // tool-exposed params matter here.
]);

function capture(): { urls: URL[]; headers: Array<Record<string, string>>; fetchImpl: FetchLike } {
  const urls: URL[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(new URL(url));
    headers.push((init.headers ?? {}) as Record<string, string>);
    const isSearch = new URL(url).pathname.endsWith('/search/tickets');
    const body = isSearch ? '{"total":0,"results":[]}' : '[]';
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { urls, headers, fetchImpl };
}

describe('Freshdesk request construction', () => {
  it('builds the verified base URL with Basic api-key auth and correlation header', async () => {
    const cap = capture();
    const { byName } = freshdeskTools({ fetchImpl: cap.fetchImpl });
    await execute(byName.get('freshdesk_list_tickets'));
    const url = cap.urls[0]!;
    expect(url.origin).toBe('https://fixture-helpdesk.freshdesk.com');
    expect(url.pathname).toBe('/api/v2/tickets');
    const h = cap.headers[0]!;
    expect(h['authorization']).toBe(basicAuthHeader(FIXTURE_KEY, 'X'));
    expect(h['authorization']?.startsWith('Basic ')).toBe(true);
    expect(h['x-correlation-id']).toBeTruthy();
  });

  it('never sends parameters that are not documented for list', async () => {
    const cap = capture();
    const { byName } = freshdeskTools({ fetchImpl: cap.fetchImpl });
    await execute(byName.get('freshdesk_list_tickets'));
    for (const key of cap.urls[0]!.searchParams.keys()) {
      expect(VERIFIED_LIST_PARAMS.has(key), `unexpected query param: ${key}`).toBe(true);
    }
    expect(cap.urls[0]!.searchParams.get('page')).toBe('1');
    expect(cap.urls[0]!.searchParams.get('per_page')).toBe('30');
  });

  it('sends search queries URL-encoded inside double quotes', async () => {
    const cap = capture();
    const { byName } = freshdeskTools({ fetchImpl: cap.fetchImpl });
    await execute(byName.get('freshdesk_search_tickets'), { query: "tag:'urgent' AND status:2" });
    const url = cap.urls[0]!;
    expect(url.pathname).toBe('/api/v2/search/tickets');
    expect(url.searchParams.get('query')).toBe('"tag:\'urgent\' AND status:2"');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.search).toContain('query='); // encoded on the wire
  });

  it('routes conversations through the ticket-scoped path', async () => {
    const cap = capture();
    const { byName } = freshdeskTools({ fetchImpl: cap.fetchImpl });
    await execute(byName.get('freshdesk_list_ticket_conversations'), { ticketId: 101 });
    expect(cap.urls[0]!.pathname).toBe('/api/v2/tickets/101/conversations');
  });

  it('serializes updatedSince and order params exactly as documented', async () => {
    const cap = capture();
    const { byName } = freshdeskTools({ fetchImpl: cap.fetchImpl });
    await execute(byName.get('freshdesk_list_tickets'), {
      updatedSince: '2026-01-01T00:00:00Z',
      orderBy: 'updated_at',
      orderType: 'asc',
      filter: 'new_and_my_open',
    });
    const params = cap.urls[0]!.searchParams;
    expect(params.get('updated_since')).toBe('2026-01-01T00:00:00Z');
    expect(params.get('order_by')).toBe('updated_at');
    expect(params.get('order_type')).toBe('asc');
    expect(params.get('filter')).toBe('new_and_my_open');
  });
});

async function execute(tool: ToolDefinition | undefined, args: unknown = {}): Promise<void> {
  const result = await executeToolDefinition(tool!, args);
  expect(result.isError, `tool failed: ${result.isError ? result.content[0]!.text : ''}`).toBeUndefined();
}
