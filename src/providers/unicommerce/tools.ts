import { z } from 'zod';
import type { ToolDefinition } from '../../core/tools.ts';
import {
  unicommerceSaleOrderDetailSchema,
  unicommerceSaleOrderSummarySchema,
} from '../../capabilities/unicommerceOrders.ts';
import {
  UNICOMMERCE_DEFAULT_PER_PAGE,
  UNICOMMERCE_MAX_PER_PAGE,
  UnicommerceAdapter,
} from './client.ts';

/**
 * Unicommerce MCP tool definitions - the agent-facing contract.
 *
 * Rules applied (docs/tool-spec.md): provider-prefixed semantic names, sibling
 * disambiguation in every description, strict input validation before any
 * network call, schema'd output, agent-safe normalized errors.
 *
 * Only VERIFIED fields are exposed (checked 2026-10-02 against
 * https://documentation.unicommerce.com/docs/saleorder-search.html and
 * .../saleorder-get.html). A field whose semantics are NOT documented - notably
 * `cashOnDelivery`, listed as "true if COD" with "Default: true" - is exposed
 * only as an explicit opt-in and labelled in the description, because omitting
 * it could silently change results if the upstream default applies.
 */

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const now = (): string => new Date().toISOString();

/** VERIFIED sale-order status enum (docs/saleorder-get.html, field 5.6). */
const SALE_ORDER_STATUSES = ['PENDING_VERIFICATION', 'CANCELLED', 'CREATED', 'PROCESSING', 'COMPLETE'] as const;

/** VERIFIED `dateType` values (docs/saleorder-search.html, field 9). */
const DATE_TYPES = ['CREATED', 'UPDATED', 'FULFILLMENT_TAT'] as const;

const PER_PAGE_DESC =
  `Results per page, mapped onto the documented offset pair searchOptions.displayStart/displayLength. `
  + `Default ${UNICOMMERCE_DEFAULT_PER_PAGE}, max ${UNICOMMERCE_MAX_PER_PAGE} - both are CONNECTOR values: `
  + 'Unicommerce documents neither a default nor a maximum for displayLength.';

const searchInputSchema = z.object({
  page: z.number().int().min(1).default(1).describe('Page number, starts at 1 (converted to the documented displayStart offset).'),
  perPage: z.number().int().min(1).max(UNICOMMERCE_MAX_PER_PAGE).default(UNICOMMERCE_DEFAULT_PER_PAGE).describe(PER_PAGE_DESC),
  displayOrderCode: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Unicommerce `displayOrderCode`: the order code to be displayed. Use this first when the merchant quotes an order code.'),
  status: z.enum(SALE_ORDER_STATUSES).optional().describe('Single documented sale-order status filter. Omit for all statuses.'),
  channel: z.string().min(1).max(50).optional().describe('Channel code (e.g. AMAZON, FLIPKART, CUSTOM). Codes are tenant-specific.'),
  searchKey: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Unicommerce `searchOptions.searchKey`: free-text key. Match behavior is undocumented - use displayOrderCode for exact lookups.'),
  customerEmailOrMobile: z.string().min(3).max(120).optional().describe('Filter by customer email or mobile.'),
  customerName: z.string().min(1).max(120).optional().describe('Filter by customer name.'),
  cod: z
    .boolean()
    .optional()
    .describe(
      'Filter on cash-on-delivery. UNVERIFIED: the docs list `cashOnDelivery` as "true if COD" with "Default: true", so the connector '
        + 'omits it unless set explicitly - leaving it out does not guarantee "all orders" upstream.',
    ),
  fromDate: z.iso.datetime({ offset: true }).optional().describe('Window start, e.g. 2026-09-01T00:00:00Z. Pair with toDate and dateType.'),
  toDate: z.iso.datetime({ offset: true }).optional().describe('Window end, e.g. 2026-10-01T00:00:00Z.'),
  dateType: z
    .enum(DATE_TYPES)
    .optional()
    .describe('Which date fromDate/toDate filters on: CREATED, UPDATED or FULFILLMENT_TAT (documented enum).'),
  facilityCodes: z.array(z.string().min(1).max(20)).max(20).optional().describe('Facility codes to restrict the search to.'),
  onHold: z.boolean().optional().describe('Filter on orders placed on hold.'),
});
export function buildUnicommerceTools(adapter: UnicommerceAdapter): ToolDefinition[] {
  return [
    {
      name: 'unicommerce_search_sale_orders',
      provider: 'unicommerce',
      description:
        'Search Unicommerce sale orders with documented filters and paging (read-only). '
        + 'USE WHEN: finding an order before you have its code, reviewing the order book, or filtering by status/channel/customer/date. '
        + 'DO NOT USE WHEN: you already have a sale order code (unicommerce_get_sale_order - search returns only a summary). '
        + 'Search rows are deliberately thin (code, displayOrderCode, channel, status, dates, notification contacts): for line items, '
        + 'facility, shipping method or money use unicommerce_get_sale_order. '
        + 'Filters map 1:1 to documented fields: displayOrderCode, status (PENDING_VERIFICATION/CANCELLED/CREATED/PROCESSING/COMPLETE), '
        + 'channel, customerEmailOrMobile, customerName, fromDate/toDate with dateType (CREATED/UPDATED/FULFILLMENT_TAT), facilityCodes, '
        + 'onHold, and searchOptions.searchKey. Paging uses the documented offset pair displayStart/displayLength; total comes from the '
        + 'documented totalRecords and hasMore is derived from it. Empty items means no match (success), not an error.',
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (args) => {
        const result = await adapter.searchSaleOrders({
          page: args.page,
          perPage: args.perPage,
          ...(args.displayOrderCode !== undefined ? { displayOrderCode: args.displayOrderCode } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.channel !== undefined ? { channel: args.channel } : {}),
          ...(args.searchKey !== undefined ? { searchKey: args.searchKey } : {}),
          ...(args.customerEmailOrMobile !== undefined ? { customerEmailOrMobile: args.customerEmailOrMobile } : {}),
          ...(args.customerName !== undefined ? { customerName: args.customerName } : {}),
          ...(args.cod !== undefined ? { cod: args.cod } : {}),
          ...(args.fromDate !== undefined ? { fromDate: args.fromDate } : {}),
          ...(args.toDate !== undefined ? { toDate: args.toDate } : {}),
          ...(args.dateType !== undefined ? { dateType: args.dateType } : {}),
          ...(args.facilityCodes !== undefined ? { facilityCodes: args.facilityCodes } : {}),
          ...(args.onHold !== undefined ? { onHold: args.onHold } : {}),
        });
        return { provider: 'unicommerce' as const, fetchedAt: now(), ...result };
      },
    },
    {
      name: 'unicommerce_get_sale_order',
      provider: 'unicommerce',
      description:
        'Fetch ONE Unicommerce sale order by its code, including line items with item status, facility, shipping method and prices (read-only). '
        + 'USE WHEN: you already have a sale order code - from unicommerce_search_sale_orders or the merchant. '
        + 'DO NOT USE WHEN: you only have a customer email or name, or no code at all - search first. '
        + 'A code the tenant does not know comes back through the documented application-error channel as VALIDATION_ERROR with '
        + 'retryable:false and the Unicommerce error code - do not retry the same code. Timestamps are normalized to ISO-8601 from the '
        + 'upstream epoch-millisecond values. Customer fields (notificationEmail/Mobile, billing city/state/pincode) are customer data - '
        + 'keep them inside the merchant context.',
      inputSchema: getInputSchema,
      outputSchema: getOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async ({ code }) => {
        const saleOrder = await adapter.getSaleOrder(code);
        return { provider: 'unicommerce' as const, fetchedAt: now(), saleOrder };
      },
    },
  ];
}

const getInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(100)
    .describe('The Unicommerce sale order code (e.g. "SO1016233") - the only mandatory field of the documented request.'),
});

const searchOutputSchema = z.object({
  provider: z.literal('unicommerce'),
  fetchedAt: z.string(),
  page: z.number(),
  perPage: z.number(),
  hasMore: z.boolean(),
  total: z.number().nullable(),
  items: z.array(unicommerceSaleOrderSummarySchema),
});

const getOutputSchema = z.object({
  provider: z.literal('unicommerce'),
  fetchedAt: z.string(),
  saleOrder: unicommerceSaleOrderDetailSchema,
});