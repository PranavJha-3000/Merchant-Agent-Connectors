import { describe, expect, it } from 'vitest';
import { executeToolDefinition } from '../../src/core/tools.ts';
import type { FetchLike } from '../../src/core/http.ts';
import { createFixtureFetch } from '../../src/fixtures/transport.ts';
import { zohoFixtureRoutes } from '../../src/providers/zoho/routes.ts';
import { zohoTools } from '../helpers.ts';

/**
 * Zoho Inventory agent-evaluation fixtures.
 *
 * Each case is a realistic merchant-support task expressed as the CONTRACT an
 * LLM depends on: which tool should be chosen, which arguments, what result
 * class comes back, and - for failure cases - whether the agent should retry.
 * No LLM is involved; these lock the tool surface so agent behavior stays
 * predictable (see docs/evaluation.md).
 */

async function call(tool: string, args: Record<string, unknown>, fetchImpl?: FetchLike) {
  const { byName } = zohoTools(fetchImpl ? { fetchImpl } : {});
  const result = await executeToolDefinition(byName.get(tool)!, args);
  return {
    isError: result.isError === true,
    data: (result as { structuredContent?: Record<string, unknown> }).structuredContent,
    error: result.isError ? (JSON.parse(result.content[0]!.text) as Record<string, unknown>) : undefined,
  };
}

describe('Zoho Inventory agent evaluation', () => {
  it('1. warehouse asks "do we still have the blue bottle?" -> exact SKU lookup', async () => {
    const r = await call('zoho_list_items', { sku: 'ACC-BLUE-M' });
    expect(r.isError).toBe(false);
    const items = (r.data as { items: Array<{ sku: string; stockOnHand: number }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.stockOnHand).toBeGreaterThan(0);
  });

  it('2. ops asks "which items need reordering?" -> documented low-stock filter', async () => {
    const r = await call('zoho_list_items', { filterBy: 'Status.Lowstock' });
    expect(r.isError).toBe(false);
    const items = (r.data as { items: Array<{ sku: string; stockOnHand: number; reorderLevel: number }> }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.stockOnHand).toBeLessThanOrEqual(item.reorderLevel);
  });

  it('3. support asks for details of a known item id', async () => {
    const r = await call('zoho_get_item', { itemId: '4815000000044208' });
    expect(r.isError).toBe(false);
    expect((r.data as { item: { sku: string } }).item.sku).toBe('ACC-BLUE-M');
  });

  it('4. "review the order book" -> list sales orders', async () => {
    const r = await call('zoho_list_sales_orders', {});
    expect(r.isError).toBe(false);
    const items = (r.data as { items: Array<{ salesOrderNumber: string | null }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.salesOrderNumber !== null)).toBe(true);
  });

  it('5. "why is SO-00004 late?" -> sales order detail with shipment state', async () => {
    const r = await call('zoho_get_sales_order', { salesOrderId: '4815000000045208' });
    expect(r.isError).toBe(false);
    const order = (r.data as { salesOrder: Record<string, unknown> }).salesOrder;
    expect(order['salesOrderNumber']).toBe('SO-00004');
    expect(order['shipmentDate']).toBeNull();
    expect(order['isBackorder']).toBe(true);
  });

  it('6. no matching item is a SUCCESS with zero items, not an error', async () => {
    const r = await call('zoho_list_items', { searchText: 'nonexistent-widget' });
    expect(r.isError).toBe(false);
    expect((r.data as { items: unknown[] }).items).toEqual([]);
    expect(r.error).toBeUndefined();
  });
  it('7. an unknown item id is NOT_FOUND and must not be retried', async () => {
    const r = await call('zoho_get_item', { itemId: '4815000000099999' });
    expect(r.isError).toBe(true);
    expect(r.error!['code']).toBe('NOT_FOUND');
    expect(r.error!['retryable']).toBe(false);
  });

  it('8. invalid arguments are rejected BEFORE any network call', async () => {
    let calls = 0;
    const spy: FetchLike = async (url) => {
      calls += 1;
      if (url.includes('/oauth/v2/token')) {
        return new Response(JSON.stringify({ access_token: '1000.t', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, message: 'success', items: [], page_context: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const bad = await call('zoho_get_item', { itemId: 'not-a-number' }, spy);
    expect(bad.isError).toBe(true);
    expect(bad.error!['code']).toBe('VALIDATION_ERROR');
    expect(calls).toBe(0); // nothing was sent upstream, not even a token request
  });

  it('9. an undocumented filter value cannot be smuggled through', async () => {
    // sortColumn is an enum, so an invented column never reaches the API.
    const bad = await call('zoho_list_items', { sortColumn: 'internal_margin' });
    expect(bad.isError).toBe(true);
    expect(bad.error!['code']).toBe('VALIDATION_ERROR');
  });

  it('10. rate limiting surfaces as retryable with the documented quota context', async () => {
    const throttled: FetchLike = async (url) => {
      if (url.includes('/oauth/v2/token')) {
        return new Response(JSON.stringify({ access_token: '1000.t', expires_in: 3600 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: 45,
          message: 'The API call for this organization has exceeded the maximum call rate limit of 1000.',
        }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } },
      );
    };
    const r = await call('zoho_list_items', {}, throttled);
    expect(r.isError).toBe(true);
    expect(r.error!['code']).toBe('RATE_LIMITED');
    expect(r.error!['retryable']).toBe(true);
    expect(String(r.error!['hint'])).toContain('100 requests/minute');
  });

  it('11. the OAuth token is obtained once and never appears in the response', async () => {
    const urls: string[] = [];
    const fetchImpl = createFixtureFetch({ routes: zohoFixtureRoutes(), onRequest: (u) => urls.push(u.toString()) });
    const r = await call('zoho_list_items', {}, fetchImpl);
    expect(r.isError).toBe(false);
    expect(urls.filter((u) => u.includes('/oauth/v2/token'))).toHaveLength(1); // singleflight
    expect(JSON.stringify(r.data)).not.toContain('fixture_access_token');
    expect(JSON.stringify(r.data)).not.toContain('Zoho-oauthtoken');
  });
});
