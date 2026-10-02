import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../../src/core/http.ts';
import { createMemoryLogger } from '../../../src/core/logger.ts';
import { ZohoInventoryAdapter, ZOHO_DEFAULT_PER_PAGE, ZOHO_MAX_PER_PAGE } from '../../../src/providers/zoho/client.ts';
import { FIXTURE_ZOHO_CONFIG, zohoApiBaseUrl } from '../../../src/providers/zoho/config.ts';
import { mapZohoHttpError } from '../../../src/providers/zoho/errors.ts';
import { ZohoTokenStrategy } from '../../../src/providers/zoho/auth.ts';
import type { FetchLike } from '../../../src/core/http.ts';

/**
 * Zoho adapter wiring tests: request construction and auth header format.
 *
 * Asserts the two VERIFIED facts that must hold on EVERY call:
 * - `Authorization: Zoho-oauthtoken <token>` (oauth/ "OAuth Overview");
 * - `organization_id` present (introduction "Organization ID": it "should be
 *   sent in with every API request").
 */

interface Seen {
  url: string;
  authorization: string | undefined;
}

function recordingFetch(): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init.headers);
    seen.push({ url, authorization: headers.get('authorization') ?? undefined });
    if (url.includes('/oauth/v2/token')) {
      return new Response(JSON.stringify({ access_token: '1000.header_test_token', expires_in: 3600 }), { status: 200 });
    }
    // Single-resource calls must still satisfy the required-id rule.
    // (Match on pathname: the URL carries ?organization_id=...)
    const path = new URL(url).pathname;
    if (/\/items\/\d+$/.test(path)) {
      return new Response(JSON.stringify({ code: 0, item_id: '4815000000044208', name: 'Stub item' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (/\/salesorders\/\d+$/.test(path)) {
      return new Response(JSON.stringify({ code: 0, salesorder_id: '4815000000045208', salesorder_number: 'SO-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ code: 0, message: 'success', items: [], salesorders: [], page_context: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, seen };
}

function buildAdapter(fetchImpl: FetchLike) {
  const auth = new ZohoTokenStrategy({ config: FIXTURE_ZOHO_CONFIG, fetchImpl });
  const http = new HttpClient({
    provider: 'zoho-inventory',
    baseUrl: zohoApiBaseUrl(FIXTURE_ZOHO_CONFIG.dataCenter),
    auth,
    logger: createMemoryLogger(),
    fetchImpl,
    mapError: mapZohoHttpError,
    minIntervalMs: 0,
  });
  return new ZohoInventoryAdapter(http, FIXTURE_ZOHO_CONFIG.organizationId);
}

describe('Zoho adapter request construction', () => {
  it('uses the data-center base URL and appends organization_id everywhere', async () => {
    const { fetchImpl, seen } = recordingFetch();
    const adapter = buildAdapter(fetchImpl);

    await adapter.listItems({ page: 1, perPage: ZOHO_DEFAULT_PER_PAGE });
    await adapter.getItem('4815000000044208');
    await adapter.listSalesOrders({ page: 2, perPage: 50 });
    await adapter.getSalesOrder('4815000000045208');

    const dataCalls = seen.filter((s) => s.url.includes('zohoapis.com'));
    expect(dataCalls).toHaveLength(4);
    for (const call of dataCalls) {
      expect(call.url.startsWith('https://www.zohoapis.com/inventory/v1/')).toBe(true);
      expect(call.url).toContain('organization_id=10234695');
      // VERIFIED header format on every data call.
      expect(call.authorization).toBe('Zoho-oauthtoken 1000.header_test_token');
      // Never a bearer/basic variant, never the refresh token.
      expect(call.authorization).not.toContain('Bearer');
      expect(call.url).not.toContain(FIXTURE_ZOHO_CONFIG.refreshToken);
    }
    expect(seen[0]!.url).toContain('accounts.zoho.com/oauth/v2/token');
  });

  it('sends only VERIFIED query parameters', async () => {
    const { fetchImpl, seen } = recordingFetch();
    const adapter = buildAdapter(fetchImpl);

    await adapter.listItems({
      page: 3,
      perPage: ZOHO_MAX_PER_PAGE,
      searchText: 'bottle',
      sku: 'ACC-BLUE-M',
      filterBy: 'Status.Lowstock',
      sortColumn: 'stock_on_hand',
      sortOrder: 'D',
    });

    const url = new URL(seen.at(-1)!.url);
    expect(url.pathname).toBe('/inventory/v1/items');
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('per_page')).toBe('500');
    expect(url.searchParams.get('search_text')).toBe('bottle');
    expect(url.searchParams.get('sku')).toBe('ACC-BLUE-M');
    expect(url.searchParams.get('filter_by')).toBe('Status.Lowstock');
    expect(url.searchParams.get('sort_column')).toBe('stock_on_hand');
    expect(url.searchParams.get('sort_order')).toBe('D');

    // Sales orders get page/per_page ONLY - no invented status/date/customer filter.
    await adapter.listSalesOrders({ page: 1, perPage: 200 });
    const soUrl = new URL(seen.at(-1)!.url);
    expect([...soUrl.searchParams.keys()].sort()).toEqual(['organization_id', 'page', 'per_page']);
  });

  it('reads hasMore from the documented page_context, never a guess', async () => {
    const makeFetch = (context: unknown): FetchLike => async (url) => {
      if (url.includes('/oauth/v2/token')) {
        return new Response(JSON.stringify({ access_token: '1000.t', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, message: 'success', items: [], page_context: context }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const more = await buildAdapter(makeFetch({ page: 2, per_page: 25, has_more_page: true })).listItems({
      page: 2,
      perPage: 25,
    });
    expect(more.hasMore).toBe(true);
    expect(more.page).toBe(2);
    expect(more.perPage).toBe(25);
    expect(more.total).toBeNull(); // Zoho reports no total

    // Missing page_context falls back to the requested values and never claims more pages.
    const unknown = await buildAdapter(makeFetch(null)).listItems({ page: 4, perPage: 10 });
    expect(unknown.hasMore).toBe(false);
    expect(unknown.page).toBe(4);
    expect(unknown.perPage).toBe(10);
  });
});