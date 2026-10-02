import { z } from 'zod';
import type { ToolDefinition } from '../../core/tools.ts';
import { orderDetailSchema, orderSummarySchema } from '../../capabilities/orders.ts';
import { productDetailSchema, productSummarySchema } from '../../capabilities/catalog.ts';
import { WooCommerceAdapter, WOOCOMMERCE_DEFAULT_PER_PAGE, WOOCOMMERCE_MAX_PER_PAGE } from './client.ts';

/**
 * WooCommerce MCP tool definitions - the agent-facing contract.
 *
 * Rules applied (docs/tool-spec.md):
 * - provider-prefixed semantic names, never raw paths;
 * - descriptions explicitly disambiguate sibling tools (when to use / NOT use);
 * - inputs are strictly validated BEFORE any network call;
 * - outputs are schema'd (structuredContent) and machine-predictable;
 * - errors are agent-safe normalized payloads (see core/tools.ts execute).
 *
 * Only VERIFIED WooCommerce parameters are exposed (verified 2026-10-02 against
 * https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/ and
 * .../products/ - list "Available parameters" sections + retrieve endpoints).
 * Anything unverified is intentionally absent (e.g. what `search` matches).
 */

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const now = (): string => new Date().toISOString();

const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed', 'trash'] as const;
const PRODUCT_STATUSES = ['any', 'draft', 'pending', 'private', 'publish'] as const;
const STOCK_STATUSES = ['instock', 'outofstock', 'onbackorder'] as const;

const PER_PAGE_DESC =
  `Results per page. Default ${WOOCOMMERCE_DEFAULT_PER_PAGE} (WooCommerce's documented default); `
  + `max ${WOOCOMMERCE_MAX_PER_PAGE} is a connector-imposed cap (WooCommerce documents no maximum).`;

const listOrdersInputSchema = z.object({
  page: z.number().int().min(1).default(1).describe('Page number, starts at 1.'),
  perPage: z.number().int().min(1).max(WOOCOMMERCE_MAX_PER_PAGE).default(WOOCOMMERCE_DEFAULT_PER_PAGE).describe(PER_PAGE_DESC),
  status: z
    .enum(ORDER_STATUSES)
    .optional()
    .describe('Single order status filter. Omit for ALL statuses (the documented default). One value per call.'),
  search: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Free-form string passed to WooCommerce's documented `search` parameter. "
        + 'Match behavior is store-defined - do NOT rely on it for exact email or id lookup.',
    ),
  customerId: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Numeric WordPress user id; 0 matches guest orders. There is NO documented email filter - use the id or search.'),
  productId: z.number().int().min(1).optional().describe('Only orders containing this product id.'),
  after: z.iso.datetime({ offset: true }).optional().describe('Only orders published after this ISO-8601 date, e.g. 2026-09-01T00:00:00Z.'),
  before: z.iso.datetime({ offset: true }).optional().describe('Only orders published before this ISO-8601 date, e.g. 2026-10-01T00:00:00Z.'),
});

const getOrderInputSchema = z.object({
  orderId: z.number().int().min(1).describe('The numeric WooCommerce order id (from a list result or the user).'),
});

const listProductsInputSchema = z.object({
  page: z.number().int().min(1).default(1).describe('Page number, starts at 1.'),
  perPage: z.number().int().min(1).max(WOOCOMMERCE_MAX_PER_PAGE).default(WOOCOMMERCE_DEFAULT_PER_PAGE).describe(PER_PAGE_DESC),
  search: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Free-form string passed to WooCommerce's documented `search` parameter (store-defined match behavior)."),
  sku: z.string().min(1).max(100).optional().describe('Exact SKU match (e.g. "ACC-BLUE-M"). Prefer this over search when you have a SKU.'),
  status: z
    .enum(PRODUCT_STATUSES)
    .optional()
    .describe('Single product status. Omit for the documented default (`any`).'),
  stockStatus: z.enum(STOCK_STATUSES).optional().describe('Only products in this stock state.'),
});

const getProductInputSchema = z.object({
  productId: z.number().int().min(1).describe('The numeric WooCommerce product id (from a list result or the user).'),
});

const PAGE_ENVELOPE_DESCS = {
  page: z.number().describe('Page echoed back from the request (1-based).'),
  perPage: z.number().describe('Page size used for this request.'),
  hasMore: z.boolean().describe('True only when the store reports another page (X-WP-TotalPages / Link rel="next").'),
  total: z.number().nullable().describe('Total matching records per the X-WP-Total header; null when the header is absent.'),
} as const;

const listOrdersOutputSchema = z.object({
  provider: z.literal('woocommerce'),
  fetchedAt: z.string().describe('RFC-3339 timestamp of when this page was fetched.'),
  ...PAGE_ENVELOPE_DESCS,
  items: z.array(orderSummarySchema),
});
const getOrderOutputSchema = z.object({
  provider: z.literal('woocommerce'),
  fetchedAt: z.string().describe('RFC-3339 timestamp of when this order was fetched.'),
  order: orderDetailSchema,
});
const listProductsOutputSchema = z.object({
  provider: z.literal('woocommerce'),
  fetchedAt: z.string().describe('RFC-3339 timestamp of when this page was fetched.'),
  ...PAGE_ENVELOPE_DESCS,
  items: z.array(productSummarySchema),
});
const getProductOutputSchema = z.object({
  provider: z.literal('woocommerce'),
  fetchedAt: z.string().describe('RFC-3339 timestamp of when this product was fetched.'),
  product: productDetailSchema,
});

export function buildWooCommerceTools(adapter: WooCommerceAdapter): ToolDefinition[] {
  return [
    {
      name: 'woocommerce_list_orders',
      provider: 'woocommerce',
      description:
        "List a WooCommerce store's orders with pagination and optional filters (read-only). "
        + 'USE WHEN: browsing recent orders, finding a customer\'s orders by numeric customer id, filtering by status '
        + '(e.g. unfulfilled work: pending/processing/on-hold), by date range, or locating an order id first. '
        + 'DO NOT USE WHEN: you already have an order id (woocommerce_get_order). '
        + 'Inputs map 1:1 to documented WooCommerce REST API v3 query parameters; status accepts ONE value per call; '
        + 'customer is the numeric WordPress user id (0 = guest) - there is no documented email filter, so use search as '
        + 'a free-form fallback (its match behavior is store-defined). Pagination: page starts at 1, perPage defaults to 10 '
        + "(WooCommerce's default), max 100 is a connector cap (WooCommerce documents no maximum). total/hasMore come from "
        + 'the store\'s X-WP-Total/X-WP-TotalPages headers. Empty items with total:0 means no match (success).',
      inputSchema: listOrdersInputSchema,
      outputSchema: listOrdersOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (args) => {
        const result = await adapter.listOrders({
          page: args.page,
          perPage: args.perPage,
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.search !== undefined ? { search: args.search } : {}),
          ...(args.customerId !== undefined ? { customerId: args.customerId } : {}),
          ...(args.productId !== undefined ? { productId: args.productId } : {}),
          ...(args.after !== undefined ? { after: args.after } : {}),
          ...(args.before !== undefined ? { before: args.before } : {}),
        });
        return { provider: 'woocommerce' as const, fetchedAt: now(), ...result };
      },
    },
    {
      name: 'woocommerce_get_order',
      provider: 'woocommerce',
      description:
        'Fetch ONE WooCommerce order by its numeric id, including line items, totals, dates, and customer note (read-only). '
        + 'USE WHEN: you already have an order id - from woocommerce_list_orders or the user. '
        + 'DO NOT USE WHEN: you only have a customer email, name, or status - use woocommerce_list_orders to locate the id first. '
        + 'An unknown id returns error code NOT_FOUND with retryable:false - do not retry the same id. '
        + 'Output includes billingName/billingEmail and shipping city/country: treat them as customer data and never expose '
        + 'them beyond the merchant context you were given.',
      inputSchema: getOrderInputSchema,
      outputSchema: getOrderOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async ({ orderId }) => {
        const order = await adapter.getOrder(orderId);
        return { provider: 'woocommerce' as const, fetchedAt: now(), order };
      },
    },
    {
      name: 'woocommerce_list_products',
      provider: 'woocommerce',
      description:
        'List a WooCommerce store\'s products with pagination and optional filters (read-only). '
        + 'USE WHEN: finding a product by SKU or name, checking catalog status or stock levels across products, '
        + 'or locating a product id first. '
        + 'DO NOT USE WHEN: you already have a product id (woocommerce_get_product), or you need an order '
        + '(woocommerce_list_orders - products and orders are different resources). '
        + 'Filters map 1:1 to documented WooCommerce REST API v3 parameters: sku is an EXACT match; search is free-form '
        + 'with store-defined match behavior; status defaults to any; stockStatus is instock/outofstock/onbackorder. '
        + 'Pagination: page starts at 1, perPage defaults to 10 (WooCommerce default), max 100 is a connector cap. '
        + 'total/hasMore come from X-WP-Total/X-WP-TotalPages. Empty items means no match (success).',
      inputSchema: listProductsInputSchema,
      outputSchema: listProductsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (args) => {
        const result = await adapter.listProducts({
          page: args.page,
          perPage: args.perPage,
          ...(args.search !== undefined ? { search: args.search } : {}),
          ...(args.sku !== undefined ? { sku: args.sku } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.stockStatus !== undefined ? { stockStatus: args.stockStatus } : {}),
        });
        return { provider: 'woocommerce' as const, fetchedAt: now(), ...result };
      },
    },
    {
      name: 'woocommerce_get_product',
      provider: 'woocommerce',
      description:
        'Fetch ONE WooCommerce product by its numeric id, including price, stock state, description, and categories (read-only). '
        + 'USE WHEN: you already have a product id - from woocommerce_list_products or the user. '
        + 'DO NOT USE WHEN: you only have a SKU or a name - use woocommerce_list_products (sku or search) to locate the id first. '
        + 'An unknown id returns error code NOT_FOUND with retryable:false - do not retry the same id. '
        + 'stockStatus/stockQuantity reflect the store at fetch time and may change; re-fetch before acting on them.',
      inputSchema: getProductInputSchema,
      outputSchema: getProductOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async ({ productId }) => {
        const product = await adapter.getProduct(productId);
        return { provider: 'woocommerce' as const, fetchedAt: now(), product };
      },
    },
  ];
}

