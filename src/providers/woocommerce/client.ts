import type { z } from 'zod';
import { parseLinkHeaderNext, type PageEnvelope } from '../../core/pagination.ts';
import { UpstreamResponseError } from '../../core/errors.ts';
import type { HttpClient, HttpResult } from '../../core/http.ts';
import type {
  ListOrdersParams,
  OrderDetail,
  OrderListable,
  OrderReadable,
  OrderSummary,
} from '../../capabilities/orders.ts';
import type {
  ListProductsParams,
  ProductDetail,
  ProductListable,
  ProductReadable,
  ProductSummary,
} from '../../capabilities/catalog.ts';
import { normalizeOrderDetail, normalizeOrderSummary, normalizeProductDetail, normalizeProductSummary } from './normalize.ts';
import { rawOrderListSchema, rawOrderSchema, rawProductListSchema, rawProductSchema } from './types.ts';

/**
 * WooCommerce adapter: implements the order + product capability interfaces.
 *
 * Owns route construction, query-parameter mapping (VERIFIED parameters only -
 * see docs/providers/woocommerce.md), raw-payload validation, and
 * normalization. Contains no MCP types and no retry/auth logic (core owns those).
 *
 * Verified endpoints (https://developer.woocommerce.com/docs/apis/rest-api/v3/,
 * checked 2026-10-02):
 *   GET /wp-json/wc/v3/orders            list   (page default 1, per_page default 10,
 *     search, after, before, status, customer, product - "Available parameters")
 *   GET /wp-json/wc/v3/orders/<id>       "Retrieve an order"
 *   GET /wp-json/wc/v3/products          list   (page, per_page, search, sku, status,
 *     stock_status - "Available parameters")
 *   GET /wp-json/wc/v3/products/<id>     "Retrieve a product"
 * Pagination (docs/apis/rest-api/ "Pagination"): 1-based pages, default 10 per
 * page, totals ALWAYS in X-WP-Total/X-WP-TotalPages, next page in Link rel="next".
 */

/**
 * Connector-imposed cap. WooCommerce documents NO maximum for per_page (only
 * the default of 10), so 100 is a deliberate safety bound on outbound page
 * size - NOT a claimed WooCommerce limit.
 */
export const WOOCOMMERCE_MAX_PER_PAGE = 100;
export const WOOCOMMERCE_DEFAULT_PER_PAGE = 10;

function headerInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export class WooCommerceAdapter implements OrderListable, OrderReadable, ProductListable, ProductReadable {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async listOrders(params: ListOrdersParams): Promise<PageEnvelope<OrderSummary>> {
    const res = await this.http.get({
      path: '/orders',
      operation: 'woocommerce.listOrders',
      query: {
        page: params.page,
        per_page: params.perPage,
        status: params.status,
        search: params.search,
        customer: params.customerId,
        product: params.productId,
        after: params.after,
        before: params.before,
      },
    });
    const raw = this.parse(res, rawOrderListSchema, 'woocommerce.listOrders');
    return {
      items: raw.map(normalizeOrderSummary),
      page: params.page,
      perPage: params.perPage,
      hasMore: this.hasMore(res, params.page),
      total: headerInt(res.headers, 'x-wp-total'),
    };
  }

  async getOrder(orderId: number): Promise<OrderDetail> {
    const res = await this.http.get({ path: `/orders/${orderId}`, operation: 'woocommerce.getOrder' });
    const raw = this.parse(res, rawOrderSchema, 'woocommerce.getOrder');
    return normalizeOrderDetail(raw);
  }

  async listProducts(params: ListProductsParams): Promise<PageEnvelope<ProductSummary>> {
    const res = await this.http.get({
      path: '/products',
      operation: 'woocommerce.listProducts',
      query: {
        page: params.page,
        per_page: params.perPage,
        search: params.search,
        sku: params.sku,
        status: params.status,
        stock_status: params.stockStatus,
      },
    });
    const raw = this.parse(res, rawProductListSchema, 'woocommerce.listProducts');
    return {
      items: raw.map(normalizeProductSummary),
      page: params.page,
      perPage: params.perPage,
      hasMore: this.hasMore(res, params.page),
      total: headerInt(res.headers, 'x-wp-total'),
    };
  }

  async getProduct(productId: number): Promise<ProductDetail> {
    const res = await this.http.get({ path: `/products/${productId}`, operation: 'woocommerce.getProduct' });
    const raw = this.parse(res, rawProductSchema, 'woocommerce.getProduct');
    return normalizeProductDetail(raw);
  }

  /**
   * `hasMore` from the store's own X-WP-TotalPages header (docs: totals are
   * "always included" there). When a proxy strips headers, falls back to the
   * documented Link rel="next"; with no signal at all, reports false rather
   * than guessing.
   */
  private hasMore(res: HttpResult, page: number): boolean {
    const totalPages = headerInt(res.headers, 'x-wp-totalpages');
    if (totalPages !== null) return page < totalPages;
    return parseLinkHeaderNext(res.headers.get('link')) !== null;
  }

  /** Validate payload shape; drift -> UpstreamResponseError (never a crash, raw body never leaked). */
  private parse<T>(res: HttpResult, schema: z.ZodType<T>, operation: string): T {
    const result = schema.safeParse(res.json);
    if (!result.success) {
      const paths = result.error.issues
        .slice(0, 3)
        .map((i) => i.path.join('.') || '(root)')
        .join(', ');
      throw new UpstreamResponseError({
        provider: 'woocommerce',
        operation,
        correlationId: res.correlationId,
        status: res.status,
        attempts: res.attempts,
        message: `WooCommerce returned an unexpected payload shape for ${operation}${paths ? ` at ${paths}` : ''} (not retried)`,
        hint: 'The response no longer matches the documented schema. Do not retry; report with the correlationId.',
      });
    }
    return result.data;
  }
}
