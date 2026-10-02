import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from '../../../src/core/auth.ts';
import type { FetchLike } from '../../../src/core/http.ts';
import { executeToolDefinition, type ToolDefinition } from '../../../src/core/tools.ts';
import { woocommerceConfigFromEnv } from '../../../src/providers/woocommerce/config.ts';
import { woocommerceTools } from '../../helpers.ts';

/**
 * Request construction: proves only VERIFIED WooCommerce parameters are ever
 * sent, auth is Basic(consumerKey:consumerSecret), and correlation ids are
 * attached. Docs (checked 2026-10-02):
 *   https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/
 *   https://developer.woocommerce.com/docs/apis/rest-api/v3/products/
 *   https://developer.woocommerce.com/docs/apis/rest-api/authentication/
 */

const FIXTURE_KEY = 'ck_fixture_not_a_real_key';
const FIXTURE_SECRET = 'cs_fixture_not_a_real_secret';

const VERIFIED_ORDER_LIST_PARAMS = new Set(['page', 'per_page', 'status', 'search', 'customer', 'product', 'after', 'before']);
const VERIFIED_PRODUCT_LIST_PARAMS = new Set(['page', 'per_page', 'search', 'sku', 'status', 'stock_status']);

function capture(): { urls: URL[]; headers: Array<Record<string, string>>; fetchImpl: FetchLike } {
  const urls: URL[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(new URL(url));
    headers.push((init.headers ?? {}) as Record<string, string>);
    // Single-resource GETs must receive an object, collections an array.
    const single = /\/(orders|products)\/\d+$/.test(new URL(url).pathname);
    return new Response(single ? '{"id":1}' : '[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { urls, headers, fetchImpl };
}

async function execute(tool: ToolDefinition | undefined, args: unknown = {}): Promise<void> {
  const result = await executeToolDefinition(tool!, args);
  expect(result.isError, `tool failed: ${result.isError ? result.content[0]!.text : ''}`).toBeUndefined();
}

describe('WooCommerce request construction', () => {
  it('builds the verified v3 base path with Basic consumer-key auth and correlation header', async () => {
    const cap = capture();
    const { byName } = woocommerceTools({ fetchImpl: cap.fetchImpl });
    await execute(byName.get('woocommerce_list_orders'));
    const url = cap.urls[0]!;
    expect(url.origin).toBe('https://store.fixture.example');
    expect(url.pathname).toBe('/wp-json/wc/v3/orders'); // verified base path
    const h = cap.headers[0]!;
    expect(h['authorization']).toBe(basicAuthHeader(FIXTURE_KEY, FIXTURE_SECRET));
    expect(h['authorization']?.startsWith('Basic ')).toBe(true);
    expect(h['x-correlation-id']).toBeTruthy();
  });

  it('never sends parameters that are not documented for the orders list', async () => {
    const cap = capture();
    const { byName } = woocommerceTools({ fetchImpl: cap.fetchImpl });
    await execute(byName.get('woocommerce_list_orders'));
    for (const key of cap.urls[0]!.searchParams.keys()) {
      expect(VERIFIED_ORDER_LIST_PARAMS.has(key), `unexpected query param: ${key}`).toBe(true);
    }
    expect(cap.urls[0]!.searchParams.get('page')).toBe('1');
    expect(cap.urls[0]!.searchParams.get('per_page')).toBe('10'); // documented default
  });

  it('serializes order filters exactly as documented', async () => {
    const cap = capture();
    const { byName } = woocommerceTools({ fetchImpl: cap.fetchImpl });
    await execute(byName.get('woocommerce_list_orders'), {
      status: 'processing',
      search: '42',
      customerId: 7,
      productId: 17,
      after: '2026-09-01T00:00:00Z',
      before: '2026-10-01T00:00:00Z',
      page: 2,
      perPage: 5,
    });
    const params = cap.urls[0]!.searchParams;
    expect(params.get('status')).toBe('processing');
    expect(params.get('search')).toBe('42');
    expect(params.get('customer')).toBe('7');
    expect(params.get('product')).toBe('17');
    expect(params.get('after')).toBe('2026-09-01T00:00:00Z');
    expect(params.get('before')).toBe('2026-10-01T00:00:00Z');
    expect(params.get('page')).toBe('2');
    expect(params.get('per_page')).toBe('5');
  });

  it('serializes product filters and routes single-resource gets by id', async () => {
    const cap = capture();
    const { byName } = woocommerceTools({ fetchImpl: cap.fetchImpl });
    await execute(byName.get('woocommerce_list_products'), { sku: 'ACC-BLUE-M', status: 'publish', stockStatus: 'instock' });
    const listUrl = cap.urls[0]!;
    expect(listUrl.pathname).toBe('/wp-json/wc/v3/products');
    expect(listUrl.searchParams.get('sku')).toBe('ACC-BLUE-M');
    expect(listUrl.searchParams.get('status')).toBe('publish');
    expect(listUrl.searchParams.get('stock_status')).toBe('instock');
    for (const key of listUrl.searchParams.keys()) {
      expect(VERIFIED_PRODUCT_LIST_PARAMS.has(key), `unexpected query param: ${key}`).toBe(true);
    }

    await execute(byName.get('woocommerce_get_product'), { productId: 17 });
    expect(cap.urls[1]!.pathname).toBe('/wp-json/wc/v3/products/17');
    await execute(byName.get('woocommerce_get_order'), { orderId: 42 });
    expect(cap.urls[2]!.pathname).toBe('/wp-json/wc/v3/orders/42');
  });

  it('rejects non-HTTPS or path-bearing base URLs at configuration time (no network I/O)', () => {
    // V1 implements HTTPS Basic only; plain-HTTP stores would need OAuth 1.0a
    // request signing, which is deliberately not implemented. The config layer
    // must fail fast BEFORE any request is made.
    const env = {
      WOOCOMMERCE_BASE_URL: 'http://shop.example.com',
      WOOCOMMERCE_CONSUMER_KEY: 'ck_x',
      WOOCOMMERCE_CONSUMER_SECRET: 'cs_x',
    };
    expect(() => woocommerceConfigFromEnv(env)).toThrowError(/WOOCOMMERCE_BASE_URL|https/i);

    const withPath = { ...env, WOOCOMMERCE_BASE_URL: 'https://shop.example.com/wp-json/wc/v3' };
    expect(() => woocommerceConfigFromEnv(withPath)).toThrowError(/origin/);

    const good = { ...env, WOOCOMMERCE_BASE_URL: 'https://shop.example.com' };
    expect(woocommerceConfigFromEnv(good).baseUrl).toBe('https://shop.example.com');
  });

  it('fails fast naming missing keys without leaking values', () => {
    expect(() => woocommerceConfigFromEnv({})).toThrowError(/WOOCOMMERCE_BASE_URL, WOOCOMMERCE_CONSUMER_KEY, WOOCOMMERCE_CONSUMER_SECRET/);
    let thrown: unknown;
    try {
      woocommerceConfigFromEnv({ WOOCOMMERCE_BASE_URL: 'https://x.example.com', WOOCOMMERCE_CONSUMER_KEY: 'ck_super_secret_value' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'missing secret must throw').toBeTruthy();
    expect(String(thrown)).not.toContain('ck_super_secret_value');
  });
});