import { readFileSync } from 'node:fs';
import type { FixtureReply, FixtureRoute } from '../../fixtures/transport.ts';

/**
 * Default fixture routes for WooCommerce (fixture mode).
 *
 * Synthetic data only; behavior mirrors VERIFIED API semantics
 * (https://developer.woocommerce.com/docs/apis/rest-api/ checked 2026-10-02):
 * - list endpoints return a bare array with X-WP-Total / X-WP-TotalPages
 *   headers (and Link rel="next" when another page exists);
 * - 1-based pages, default per_page 10;
 * - single-resource GETs return 404 for unknown ids with the documented error
 *   envelope shape `{code, message, data:{status}}` (the message matches the
 *   docs' 404 example; the exact machine `code` string is representative and
 *   is never asserted by tests - the adapter maps by HTTP status).
 *
 * Fixture-specific notes (NOT claimed as WooCommerce behavior):
 * - `search` on orders matches the order number only; on products it matches
 *   name or SKU. Real match behavior is store-defined and UNVERIFIED.
 * - date `after`/`before` filters compare date_created_gmt lexicographically.
 */

function loadFixture<T>(name: string): T {
  const url = new URL(`../../fixtures/woocommerce/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

type OrderRecord = {
  id: number;
  number?: string | null;
  status?: string | null;
  customer_id?: number | null;
  date_created_gmt?: string | null;
  line_items?: Array<{ product_id?: number | null }>;
};
type ProductRecord = { id: number; name?: string | null; sku?: string | null; status?: string | null; stock_status?: string | null };

const NOT_FOUND: FixtureReply = {
  status: 404,
  json: { code: 'woocommerce_rest_invalid_id', message: "Resource doesn't exist.", data: { status: 404 } },
};

function intParam(u: URL, key: string, fallback: number): number {
  const raw = u.searchParams.get(key);
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  return Number(raw);
}

/** Slice the matched records into the requested page and attach verified pagination headers. */
function pagedReply(u: URL, matched: unknown[], base: string): FixtureReply {
  const page = intParam(u, 'page', 1);
  const perPage = intParam(u, 'per_page', 10);
  const totalPages = Math.ceil(matched.length / perPage);
  const slice = matched.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
  const headers: Record<string, string> = {
    'x-wp-total': String(matched.length),
    'x-wp-total-pages': String(totalPages),
  };
  if (page < totalPages) {
    headers['link'] = `<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`;
  }
  return { status: 200, json: slice, headers };
}

function filterOrders(u: URL, orders: OrderRecord[]): OrderRecord[] {
  let matched = orders;
  const status = u.searchParams.get('status');
  if (status !== null && status !== 'any') matched = matched.filter((o) => o.status === status);
  const customer = u.searchParams.get('customer');
  if (customer !== null) matched = matched.filter((o) => String(o.customer_id ?? 0) === customer);
  const product = u.searchParams.get('product');
  if (product !== null) {
    matched = matched.filter((o) => (o.line_items ?? []).some((li) => String(li.product_id ?? 0) === product));
  }
  const search = u.searchParams.get('search');
  if (search !== null && search.length > 0) {
    matched = matched.filter((o) => (o.number ?? String(o.id)).includes(search)); // fixture rule only
  }
  const after = u.searchParams.get('after');
  if (after !== null) matched = matched.filter((o) => (o.date_created_gmt ?? '') > after);
  const before = u.searchParams.get('before');
  if (before !== null) matched = matched.filter((o) => (o.date_created_gmt ?? '') < before);
  return matched;
}

function filterProducts(u: URL, products: ProductRecord[]): ProductRecord[] {
  let matched = products;
  const status = u.searchParams.get('status');
  if (status !== null && status !== 'any') matched = matched.filter((p) => p.status === status);
  const stockStatus = u.searchParams.get('stock_status');
  if (stockStatus !== null) matched = matched.filter((p) => p.stock_status === stockStatus);
  const sku = u.searchParams.get('sku');
  if (sku !== null) matched = matched.filter((p) => p.sku === sku); // exact match (documented)
  const search = u.searchParams.get('search');
  if (search !== null && search.length > 0) {
    const needle = search.toLowerCase();
    matched = matched.filter((p) => {
      const inName = (p.name ?? '').toLowerCase().includes(needle);
      const inSku = (p.sku ?? '').toLowerCase().includes(needle);
      return inName || inSku;
    });
  }
  return matched;
}

export function woocommerceFixtureRoutes(): FixtureRoute[] {
  const orders = loadFixture<OrderRecord[]>('orders.list.json');
  const order42 = loadFixture<unknown>('order.42.json');
  const products = loadFixture<ProductRecord[]>('products.list.json');
  const product17 = loadFixture<unknown>('product.17.json');

  return [
    {
      // GET /wp-json/wc/v3/orders/<id>
      match: (u) => /\/orders\/\d+$/.test(u.pathname),
      respond: (u) => (u.pathname.endsWith('/orders/42') ? { status: 200, json: order42 } : NOT_FOUND),
    },
    {
      // GET /wp-json/wc/v3/products/<id>
      match: (u) => /\/products\/\d+$/.test(u.pathname),
      respond: (u) => (u.pathname.endsWith('/products/17') ? { status: 200, json: product17 } : NOT_FOUND),
    },
    {
      // GET /wp-json/wc/v3/orders (list)
      match: (u) => u.pathname.endsWith('/orders'),
      respond: (u) => pagedReply(u, filterOrders(u, orders), u.toString()),
    },
    {
      // GET /wp-json/wc/v3/products (list)
      match: (u) => u.pathname.endsWith('/products'),
      respond: (u) => pagedReply(u, filterProducts(u, products), u.toString()),
    },
  ];
}