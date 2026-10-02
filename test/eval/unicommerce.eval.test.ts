import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/core/http.ts';
import { executeToolDefinition } from '../../src/core/tools.ts';
import { createFixtureFetch } from '../../src/fixtures/transport.ts';
import { unicommerceFixtureRoutes } from '../../src/providers/unicommerce/routes.ts';
import { unicommerceTools } from '../helpers.ts';

/**
 * Unicommerce agent-evaluation fixtures.
 *
 * Realistic merchant-support tasks expressed as the CONTRACT an LLM depends on:
 * tool choice, argument shape, result class, and whether a failure is retryable.
 * No LLM involved (docs/evaluation.md).
 */

async function call(tool: string, args: Record<string, unknown>, fetchImpl?: FetchLike) {
  const { byName } = unicommerceTools(fetchImpl ? { fetchImpl } : {});
  const result = await executeToolDefinition(byName.get(tool)!, args);
  return {
    isError: result.isError === true,
    data: (result as { structuredContent?: Record<string, unknown> }).structuredContent,
    error: result.isError ? (JSON.parse(result.content[0]!.text) as Record<string, unknown>) : undefined,
  };
}

describe('Unicommerce agent evaluation', () => {
  it('1. "where is order SO1016233?" -> get by code', async () => {
    const r = await call('unicommerce_get_sale_order', { code: 'SO1016233' });
    expect(r.isError).toBe(false);
    const order = (r.data as { saleOrder: Record<string, unknown> }).saleOrder;
    expect(order['code']).toBe('SO1016233');
    expect((order['items'] as unknown[]).length).toBe(2);
  });

  it('2. "which orders are stuck in processing?" -> documented status filter', async () => {
    const r = await call('unicommerce_search_sale_orders', { status: 'PROCESSING' });
    expect(r.isError).toBe(false);
    const items = (r.data as { items: Array<{ status: { code: string } }> }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.status.code).toBe('PROCESSING');
  });

  it('3. "any Amazon orders today?" -> channel filter + date window', async () => {
    const r = await call('unicommerce_search_sale_orders', {
      channel: 'AMAZON',
      dateType: 'CREATED',
      fromDate: '2020-01-01T00:00:00Z',
      toDate: '2030-01-01T00:00:00Z',
    });
    expect(r.isError).toBe(false);
    const items = (r.data as { items: Array<{ channel: string }> }).items;
    for (const item of items) expect(item.channel).toBe('AMAZON');
  });

  it('4. "is the order on hold and what will ship from where?" -> item-level state', async () => {
    const r = await call('unicommerce_get_sale_order', { code: 'SO1016233' });
    const order = (r.data as { saleOrder: Record<string, any> }).saleOrder;
    expect(order['onHold']).toBe(true);
    const facilities = new Set(order['items'].map((i: { facilityCode: string }) => i.facilityCode));
    expect(facilities.has('DELHI6')).toBe(true);
    // Money stays numeric; no string decimals are invented.
    expect(typeof order['items'][0].sellingPrice).toBe('number');
  });

  it('5. paging returns a real total from totalRecords', async () => {
    const first = await call('unicommerce_search_sale_orders', { page: 1, perPage: 2 });
    const data = first.data as { items: unknown[]; total: number | null; hasMore: boolean };
    expect(data.items).toHaveLength(2);
    expect(data.total).toBe(3);
    expect(data.hasMore).toBe(true);

    const second = await call('unicommerce_search_sale_orders', { page: 2, perPage: 2 });
    expect((second.data as { items: unknown[] }).items).toHaveLength(1);
    expect((second.data as { hasMore: boolean }).hasMore).toBe(false);
  });

  it('6. no matching order is a SUCCESS with zero items', async () => {
    const r = await call('unicommerce_search_sale_orders', { displayOrderCode: 'SO-NOPE' });
    expect(r.isError).toBe(false);
    expect((r.data as { items: unknown[] }).items).toEqual([]);
  });

  it('7. an unknown order code surfaces the documented app error, not an empty result', async () => {
    const r = await call('unicommerce_get_sale_order', { code: 'SO-NOPE' });
    expect(r.isError).toBe(true);
    expect(r.error!['retryable']).toBe(false);
    expect(String(r.error!['message'])).toContain('code 40005');
  });

  it('8. invalid arguments are rejected BEFORE any network call', async () => {
    let calls = 0;
    const spy: FetchLike = async () => {
      calls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const bad = await call('unicommerce_get_sale_order', { code: '' }, spy);
    expect(bad.isError).toBe(true);
    expect(bad.error!['code']).toBe('VALIDATION_ERROR');
    expect(calls).toBe(0); // not even a token request
  });

  it('9. an undocumented status or dateType cannot be smuggled through', async () => {
    const badStatus = await call('unicommerce_search_sale_orders', { status: 'SHIPPED' });
    expect(badStatus.isError).toBe(true);
    const badDateType = await call('unicommerce_search_sale_orders', { dateType: 'DELIVERED' });
    expect(badDateType.isError).toBe(true);
  });

  it('10. the token is obtained once and never leaks into the response', async () => {
    const urls: string[] = [];
    const fetchImpl = createFixtureFetch({ routes: unicommerceFixtureRoutes(), onRequest: (u) => urls.push(u.toString()) });
    const r = await call('unicommerce_search_sale_orders', {}, fetchImpl);
    expect(r.isError).toBe(false);
    expect(urls.filter((u) => u.includes('/oauth/token'))).toHaveLength(1); // singleflight
    expect(JSON.stringify(r.data)).not.toContain('fixture-unicommerce-access-token');
    expect(JSON.stringify(r.data)).not.toContain('bearer');
  });
});