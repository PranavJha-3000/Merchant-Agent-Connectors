import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/core/http.ts';
import type { ToolDefinition } from '../../../src/core/tools.ts';
import { executeToolDefinition } from '../../../src/core/tools.ts';
import { createFixtureFetch } from '../../../src/fixtures/transport.ts';
import { unicommerceFixtureRoutes } from '../../../src/providers/unicommerce/routes.ts';
import { unicommerceTools } from '../../helpers.ts';

/**
 * Unicommerce behavior tests (fixture transport).
 *
 * These lock the VERIFIED contract (https://documentation.unicommerce.com/,
 * checked 2026-10-02): POST-with-JSON-body endpoints, the
 * `{successful, message, errors[], warnings[]}` envelope, `totalRecords` paging,
 * epoch-millisecond timestamps normalized to ISO, and the documented status /
 * item-status / shipping-method enumerations.
 */

async function run(tool: ToolDefinition | undefined, args: unknown): Promise<Record<string, any>> {
  expect(tool, 'tool must exist').toBeDefined();
  const result = await executeToolDefinition(tool!, args);
  if (result.isError) return { isError: true, error: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  return { isError: false, data: result.structuredContent as Record<string, unknown> };
}

/** Spy that records POST bodies for search calls, then delegates to the fixtures. */
function bodySpy(): { fetchImpl: FetchLike; bodies: string[]; paths: string[] } {
  const bodies: string[] = [];
  const paths: string[] = [];
  const inner = createFixtureFetch({ routes: unicommerceFixtureRoutes() });
  const fetchImpl: FetchLike = async (url, init) => {
    paths.push(new URL(url).pathname);
    if (typeof init.body === 'string' && url.includes('saleOrder/search')) bodies.push(init.body);
    return inner(url, init);
  };
  return { fetchImpl, bodies, paths };
}

describe('Unicommerce happy paths (fixtures)', () => {
  it('searches sale orders with the documented envelope and totalRecords', async () => {
    const spy = bodySpy();
    const { byName } = unicommerceTools({ fetchImpl: spy.fetchImpl });
    const result = await run(byName.get('unicommerce_search_sale_orders'), { status: 'PROCESSING' });
    expect(result.isError).toBe(false);

    const data = result.data as { items: Array<Record<string, unknown>>; total: number | null; hasMore: boolean };
    expect(data.items).toHaveLength(1);
    expect(data.total).toBe(1); // documented totalRecords counts the FILTERED matches
    expect(data.hasMore).toBe(false);
    const first = data.items[0]!;
    expect(first['provider']).toBe('unicommerce');
    expect(first['code']).toBe('SO1016233');
    // VERIFIED enum -> documented label, not a guess.
    expect(first['status']).toEqual({ code: 'PROCESSING', label: 'Processing' });
    // Epoch millis 1598293800000 normalized to ISO-8601.
    expect(first['orderDate']).toBe(new Date(1598293800000).toISOString());

    // VERIFIED endpoint + POST + documented body keys.
    expect(spy.paths.at(-1)).toBe('/services/rest/v1/oms/saleOrder/search');
    const body = JSON.parse(spy.bodies.at(-1)!) as Record<string, unknown>;
    expect(body['status']).toBe('PROCESSING');
    const options = body['searchOptions'] as Record<string, unknown>;
    expect(options['displayStart']).toBe(0);
    expect(options['displayLength']).toBe(50);
    expect(options['getCount']).toBe(true);
    // Undocumented/defaulted fields are NOT invented into the body.
    expect(body).not.toHaveProperty('cashOnDelivery');
    expect(body).not.toHaveProperty('returnStatuses');
  });

  it('maps page/perPage onto the documented offset pair', async () => {
    const spy = bodySpy();
    const { byName } = unicommerceTools({ fetchImpl: spy.fetchImpl });
    const result = await run(byName.get('unicommerce_search_sale_orders'), { page: 2, perPage: 2 });
    expect(result.isError).toBe(false);
    const options = (JSON.parse(spy.bodies.at(-1)!) as { searchOptions: Record<string, unknown> }).searchOptions;
    expect(options['displayStart']).toBe(2); // (page 2 - 1) * perPage 2
    expect(options['displayLength']).toBe(2);
    // Paging actually happened: the second page holds the remaining row.
    expect((result.data as { items: unknown[] }).items).toHaveLength(1);
    expect((result.data as { hasMore: boolean }).hasMore).toBe(false);
  });

  it('fetches one sale order with items, facility and documented enums', async () => {
    const { byName } = unicommerceTools();
    const result = await run(byName.get('unicommerce_get_sale_order'), { code: 'SO1016233' });
    expect(result.isError).toBe(false);
    const order = (result.data as { saleOrder: Record<string, any> }).saleOrder;
    expect(order['code']).toBe('SO1016233');
    expect(order['status']).toEqual({ code: 'PROCESSING', label: 'Processing' });
    expect(order['priority']).toBe(2);
    expect(order['thirdPartyShipping']).toBe(true);
    expect(order['currencyCode']).toBe('INR');
    expect(order['billingCity']).toBe('New Delhi');
    // Epoch millis -> ISO on every timestamp field.
    expect(order['createdAt']).toBe(new Date(1598335400000).toISOString());
    expect(order['fulfillmentTat']).toBe(new Date(1598335500000).toISOString());

    expect(order['items']).toHaveLength(2);
    expect(order['itemCount']).toBe(2);
    const packed = order['items'][0];
    expect(packed['itemSku']).toBe('SKU-BTL-750');
    expect(packed['status']).toEqual({ code: 'PACKED', label: 'Packed' }); // documented item enum
    expect(packed['shippingMethodCode']).toEqual({ code: 'STD', label: 'Standard' }); // documented method enum
    expect(packed['facilityCode']).toBe('DELHI6');
    expect(packed['sellingPrice']).toBe(499); // money is a number
    // Order-level onHold is derived from the documented per-item flag.
    expect(order['onHold']).toBe(true);
  });
  it('passes documented filters through to the request body', async () => {
    const spy = bodySpy();
    const { byName } = unicommerceTools({ fetchImpl: spy.fetchImpl });
    const result = await run(byName.get('unicommerce_search_sale_orders'), {
      displayOrderCode: 'SO1016402',
      channel: 'FLIPKART',
      customerName: 'Buyer Two',
      dateType: 'CREATED',
      fromDate: '2026-09-01T00:00:00Z',
      toDate: '2026-10-01T00:00:00Z',
      facilityCodes: ['DELHI6'],
      onHold: false,
      searchKey: 'SO1016402',
    });
    expect(result.isError).toBe(false);
    const body = JSON.parse(spy.bodies.at(-1)!) as Record<string, any>;
    expect(body['displayOrderCode']).toBe('SO1016402');
    expect(body['channel']).toBe('FLIPKART');
    expect(body['customerName']).toBe('Buyer Two');
    expect(body['dateType']).toBe('CREATED');
    expect(body['fromDate']).toBe('2026-09-01T00:00:00Z');
    expect(body['facilityCodes']).toEqual(['DELHI6']);
    expect(body['onHold']).toBe(false);
    expect(body['searchOptions']['searchKey']).toBe('SO1016402');
  });

  it('treats "no match" as success with zero items', async () => {
    const { byName } = unicommerceTools();
    const result = await run(byName.get('unicommerce_search_sale_orders'), { displayOrderCode: 'SO-DOES-NOT-EXIST' });
    expect(result.isError).toBe(false);
    expect((result.data as { items: unknown[] }).items).toEqual([]);
  });

  it('sends an explicit cashOnDelivery filter only when asked', async () => {
    const spy = bodySpy();
    const { byName } = unicommerceTools({ fetchImpl: spy.fetchImpl });
    await run(byName.get('unicommerce_search_sale_orders'), { cod: true });
    expect(JSON.parse(spy.bodies.at(-1)!)['cashOnDelivery']).toBe(true);
    await run(byName.get('unicommerce_search_sale_orders'), {});
    expect(JSON.parse(spy.bodies.at(-1)!)).not.toHaveProperty('cashOnDelivery');
  });
});
