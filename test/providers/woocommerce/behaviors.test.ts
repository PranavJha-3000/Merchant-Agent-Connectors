import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/core/http.ts';
import type { ToolDefinition } from '../../../src/core/tools.ts';
import { executeToolDefinition } from '../../../src/core/tools.ts';
import { woocommerceTools } from '../../helpers.ts';

async function run(tool: ToolDefinition | undefined, args: unknown): Promise<Record<string, any>> {
  expect(tool, 'tool must exist').toBeDefined();
  const result = await executeToolDefinition(tool!, args);
  if (result.isError) return { isError: true, error: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  return { isError: false, data: result.structuredContent as Record<string, unknown> };
}

describe('woocommerce_list_orders', () => {
  it('returns a header-driven page envelope (X-WP-Total / X-WP-TotalPages)', async () => {
    const { byName } = woocommerceTools();
    const out = await run(byName.get('woocommerce_list_orders'), {});
    expect(out.isError).toBe(false);
    const data = out.data!;
    expect(data['provider']).toBe('woocommerce');
    expect((data['items'] as unknown[]).length).toBe(3);
    expect(data['page']).toBe(1);
    expect(data['perPage']).toBe(10); // WooCommerce's documented default
    expect(data['total']).toBe(3); // from X-WP-Total
    expect(data['hasMore']).toBe(false); // 3 records fit in one page of 10
    const first = (data['items'] as Array<Record<string, any>>)[0]!;
    expect(first['id']).toBe(42);
    expect(first['status']).toEqual({ code: 'processing', label: 'Processing' });
    expect(first['number']).toBe('42');
    expect(first['total']).toBe('48.00'); // money stays a string
    expect(typeof data['fetchedAt']).toBe('string');
  });

  it('paginates: perPage=2 page 2 yields the remaining record with correct totals', async () => {
    const { byName } = woocommerceTools();
    const out = await run(byName.get('woocommerce_list_orders'), { page: 2, perPage: 2 });
    expect(out.isError).toBe(false);
    expect((out.data!['items'] as unknown[]).length).toBe(1);
    expect(out.data!['page']).toBe(2);
    expect(out.data!['total']).toBe(3);
    expect(out.data!['hasMore']).toBe(false);
  });

  it('filters by status; unknown status value yields empty (not an error)', async () => {
    const { byName } = woocommerceTools();
    const known = await run(byName.get('woocommerce_list_orders'), { status: 'completed' });
    expect(known.isError).toBe(false);
    expect((known.data!['items'] as unknown[]).length).toBe(1);
    expect(((known.data!['items'] as Array<Record<string, any>>)[0]!)['id']).toBe(43);

    const none = await run(byName.get('woocommerce_list_orders'), { status: 'refunded' });
    expect(none.isError).toBe(false);
    expect(none.data!['items']).toEqual([]);
    expect(none.data!['total']).toBe(0);
  });

  it('filters by customer id (0 = guest) and by product id', async () => {
    const { byName } = woocommerceTools();
    const customer = await run(byName.get('woocommerce_list_orders'), { customerId: 7 });
    expect((customer.data!['items'] as unknown[]).length).toBe(2);
    const guest = await run(byName.get('woocommerce_list_orders'), { customerId: 0 });
    expect((guest.data!['items'] as unknown[]).length).toBe(1);
    const byProduct = await run(byName.get('woocommerce_list_orders'), { productId: 17 });
    expect((byProduct.data!['items'] as unknown[]).length).toBe(1);
    expect(((byProduct.data!['items'] as Array<Record<string, any>>)[0]!)['id']).toBe(42);
  });

  it('filters by published date range (after/before)', async () => {
    const { byName } = woocommerceTools();
    const out = await run(byName.get('woocommerce_list_orders'), { after: '2026-09-24T00:00:00Z' });
    expect(out.isError).toBe(false);
    const ids = (out.data!['items'] as Array<Record<string, any>>).map((o) => o['id']);
    expect(ids).toEqual([42, 43]); // order 44 (2026-09-20) is older than the bound
  });

  it('rejects out-of-range inputs before any network call', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response('[]', { status: 200 });
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await run(byName.get('woocommerce_list_orders'), { perPage: 500 });
    expect(out.isError).toBe(true);
    expect(out.error!['code']).toBe('VALIDATION_ERROR');
    expect(out.error!['retryable']).toBe(false);
    expect(calls).toEqual([]); // no-network-on-validation-error
  });
});

describe('woocommerce_get_order', () => {
  it('returns a normalized detail with line items and derived itemCount', async () => {
    const { byName } = woocommerceTools();
    const out = await run(byName.get('woocommerce_get_order'), { orderId: 42 });
    expect(out.isError).toBe(false);
    const order = out.data!['order'] as Record<string, any>;
    expect(order['id']).toBe(42);
    expect(order['provider']).toBe('woocommerce');
    expect(order['status']).toEqual({ code: 'processing', label: 'Processing' });
    expect(order['billingName']).toBe('Nora Fisher');
    expect(order['billingEmail']).toBe('nora.fisher@example.test');
    expect(order['shippingCity']).toBe('Springfield');
    expect(order['itemCount']).toBe(1);
    expect(order['lineItems'][0]['name']).toBe('Aqua Trail Bottle');
    expect(order['datePaid']).toBe('2026-09-28T10:20:00');
    expect(order['customerNote']).toContain('side door');
  });

  it('maps an unknown order id to NOT_FOUND (retryable:false)', async () => {
    const { byName } = woocommerceTools();
    const out = await run(byName.get('woocommerce_get_order'), { orderId: 999999 });
    expect(out.isError).toBe(true);
    expect(out.error!['code']).toBe('NOT_FOUND');
    expect(out.error!['retryable']).toBe(false);
    expect(out.error!['message']).toContain("Resource doesn't exist."); // upstream detail inside a safe envelope
  });
});

describe('woocommerce_list_products', () => {
  it('returns products with stock state labels and totals from headers', async () => {
    const { byName } = woocommerceTools();
    const out = await run(byName.get('woocommerce_list_products'), {});
    expect(out.isError).toBe(false);
    expect((out.data!['items'] as unknown[]).length).toBe(3);
    expect(out.data!['total']).toBe(3);
    const bottle = (out.data!['items'] as Array<Record<string, any>>).find((p) => p['id'] === 17)!;
    expect(bottle['sku']).toBe('ACC-BLUE-M');
    expect(bottle['stockStatus']).toEqual({ code: 'instock', label: 'In stock' });
    expect(bottle['type']).toEqual({ code: 'simple', label: 'Simple' });
  });

  it('exact SKU filter narrows to one product; no match is empty success', async () => {
    const { byName } = woocommerceTools();
    const hit = await run(byName.get('woocommerce_list_products'), { sku: 'ACC-BLUE-M' });
    expect((hit.data!['items'] as unknown[]).length).toBe(1);
    const miss = await run(byName.get('woocommerce_list_products'), { sku: 'NOPE-000' });
    expect(miss.isError).toBe(false);
    expect(miss.data!['items']).toEqual([]);
  });

  it('filters by stock status and product status', async () => {
    const { byName } = woocommerceTools();
    const out = await run(byName.get('woocommerce_list_products'), { stockStatus: 'outofstock' });
    const ids = (out.data!['items'] as Array<Record<string, any>>).map((p) => p['id']);
    expect(ids).toEqual([18]);
    const all = await run(byName.get('woocommerce_list_products'), { status: 'publish' });
    expect((all.data!['items'] as unknown[]).length).toBe(3);
  });
});

describe('woocommerce_get_product', () => {
  it('returns catalog detail with categories, tags, and derived imageCount', async () => {
    const { byName } = woocommerceTools();
    const out = await run(byName.get('woocommerce_get_product'), { productId: 17 });
    expect(out.isError).toBe(false);
    const product = out.data!['product'] as Record<string, any>;
    expect(product['name']).toBe('Aqua Trail Bottle');
    expect(product['sku']).toBe('ACC-BLUE-M');
    expect(product['price']).toBe('24.00');
    expect(product['stockStatus']).toEqual({ code: 'instock', label: 'In stock' });
    expect(product['categories'][0]['name']).toBe('Drinkware');
    expect(product['permalink']).toBe('https://store.fixture.example/product/aqua-trail-bottle/');
    expect(product['imageCount']).toBe(1);
  });

  it('maps an unknown product id to NOT_FOUND', async () => {
    const { byName } = woocommerceTools();
    const out = await run(byName.get('woocommerce_get_product'), { productId: 424242 });
    expect(out.isError).toBe(true);
    expect(out.error!['code']).toBe('NOT_FOUND');
    expect(out.error!['retryable']).toBe(false);
  });
});
