import { z } from 'zod';
import type { ToolDefinition } from '../../core/tools.ts';
import { inventoryItemDetailSchema, inventoryItemSummarySchema } from '../../capabilities/inventory.ts';
import { salesOrderDetailSchema, salesOrderSummarySchema } from '../../capabilities/salesOrders.ts';
import { ZohoInventoryAdapter, ZOHO_DEFAULT_PER_PAGE, ZOHO_MAX_PER_PAGE } from './client.ts';

/**
 * Zoho Inventory MCP tool definitions - the agent-facing contract.
 *
 * Rules applied (docs/tool-spec.md):
 * - provider-prefixed semantic names, never raw paths;
 * - descriptions explicitly disambiguate sibling tools (when to use / NOT use);
 * - inputs strictly validated BEFORE any network call;
 * - outputs schema'd (structuredContent) and machine-predictable;
 * - errors are agent-safe normalized payloads (see core/tools.ts execute).
 *
 * Only VERIFIED Zoho Inventory parameters are exposed (verified 2026-10-02
 * against https://www.zoho.com/inventory/api/v1/items/ and .../salesorders/):
 * organization_id, page, per_page, search_text, sku, filter_by, sort_column,
 * sort_order. Nothing unverified is faked - notably there is NO documented
 * status/date/customer filter on sales orders, so none is offered.
 *
 * `organization_id` is deliberately NOT a tool argument: it is tenant
 * configuration that the connector appends to every request.
 */

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const now = (): string => new Date().toISOString();

/** Documented filter_by Status.* values (items docs). ItemType.* not exposed. */
const ITEM_FILTERS = [
  'Status.All',
  'Status.Active',
  'Status.Inactive',
  'Status.Lowstock',
  'Status.Unmapped',
  'Status.Uncategorized',
  'Status.Grouped',
] as const;

/** Documented sort_column values (items docs). */
const ITEM_SORT_COLUMNS = ['name', 'sku', 'rate', 'purchase_rate', 'created_time', 'last_modified_time', 'reorder_level', 'stock_on_hand'] as const;

const PER_PAGE_DESC =
  `Records per page. Default ${ZOHO_DEFAULT_PER_PAGE} (Zoho's documented default of 200); `
  + `max ${ZOHO_MAX_PER_PAGE} is a connector cap (Zoho documents no maximum).`;

const listItemsInputSchema = z.object({
  page: z.number().int().min(1).default(1).describe('Page number, starts at 1.'),
  perPage: z.number().int().min(1).max(ZOHO_MAX_PER_PAGE).default(ZOHO_DEFAULT_PER_PAGE).describe(PER_PAGE_DESC),
  searchText: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Zoho `search_text`: searches item name, SKU and other searchable fields. Free-form - match behavior beyond name/SKU is store-defined."),
  sku: z.string().min(1).max(100).optional().describe('Zoho `sku`: EXACT SKU match. Prefer this when the SKU is known.'),
  filterBy: z
    .enum(ITEM_FILTERS)
    .optional()
    .describe(
      'Zoho `filter_by` status views. Status.Lowstock finds items at or below their reorder level; '
        + 'Status.Inactive finds items no longer sold. Item-type filters are intentionally not exposed.',
    ),
  sortColumn: z.enum(ITEM_SORT_COLUMNS).optional().describe('Zoho `sort_column`, e.g. stock_on_hand or name.'),
  sortOrder: z.enum(['A', 'D']).optional().describe("Zoho `sort_order`: 'A' ascending, 'D' descending."),
});

const getItemInputSchema = z.object({
  itemId: z
    .union([z.string().regex(/^\d{1,20}$/, 'must be the numeric item_id'), z.number().int().positive()])
    .transform((v) => String(v))
    .describe('The Zoho item_id (16-digit id from zoho_list_items or the user).'),
});

const listSalesOrdersInputSchema = z.object({
  page: z.number().int().min(1).default(1).describe('Page number, starts at 1.'),
  perPage: z.number().int().min(1).max(ZOHO_MAX_PER_PAGE).default(ZOHO_DEFAULT_PER_PAGE).describe(PER_PAGE_DESC),
});

const getSalesOrderInputSchema = z.object({
  salesOrderId: z
    .union([z.string().regex(/^\d{1,20}$/, 'must be the numeric salesorder_id'), z.number().int().positive()])
    .transform((v) => String(v))
    .describe('The Zoho salesorder_id (16-digit id from zoho_list_sales_orders or the user).'),
});

const listItemsOutputSchema = z.object({
  provider: z.literal('zoho-inventory'),
  fetchedAt: z.string(),
  page: z.number(),
  perPage: z.number(),
  hasMore: z.boolean(),
  total: z.number().nullable(),
  items: z.array(inventoryItemSummarySchema),
});

const getItemOutputSchema = z.object({
  provider: z.literal('zoho-inventory'),
  fetchedAt: z.string(),
  item: inventoryItemDetailSchema,
});

export function buildZohoTools(adapter: ZohoInventoryAdapter): ToolDefinition[] {
  return [
    {
      name: 'zoho_list_items',
      provider: 'zoho-inventory',
      description:
        "List Zoho Inventory items with pagination and optional filters (read-only). "
        + 'USE WHEN: answering stock/restock questions ("do we have X in stock?", "what is below reorder level?"), '
        + 'finding an item by name or SKU, or locating an item id first. '
        + 'DO NOT USE WHEN: you already have an item id (zoho_get_item), or you need sales orders '
        + '(zoho_list_sales_orders - items and orders are different resources). '
        + 'Filters map 1:1 to documented Zoho parameters: sku is an EXACT match, searchText searches name/SKU and other '
        + 'searchable fields, filterBy is a documented Status.* view (Status.Lowstock = at or below reorder level), '
        + 'sortOrder is A/D. Pagination: page starts at 1, perPage defaults to 200 (Zoho default), max 500 is a connector cap. '
        + 'stockOnHand and reorderLevel are live stock figures - compare them before promising availability. '
        + 'Empty items means no match (success), not an error.',
      inputSchema: listItemsInputSchema,
      outputSchema: listItemsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (args) => {
        const result = await adapter.listItems({
          page: args.page,
          perPage: args.perPage,
          ...(args.searchText !== undefined ? { searchText: args.searchText } : {}),
          ...(args.sku !== undefined ? { sku: args.sku } : {}),
          ...(args.filterBy !== undefined ? { filterBy: args.filterBy } : {}),
          ...(args.sortColumn !== undefined ? { sortColumn: args.sortColumn } : {}),
          ...(args.sortOrder !== undefined ? { sortOrder: args.sortOrder } : {}),
        });
        return { provider: 'zoho-inventory' as const, fetchedAt: now(), ...result };
      },
    },
    {
      name: 'zoho_get_item',
      provider: 'zoho-inventory',
      description:
        'Fetch ONE Zoho Inventory item by its item_id, including stock on hand, reorder level, tax treatment and descriptions (read-only). '
        + 'USE WHEN: you already have an item id - from zoho_list_items or the user. '
        + 'DO NOT USE WHEN: you only have a SKU or a name - use zoho_list_items (sku or searchText) to locate the id first. '
        + 'An unknown id returns error code NOT_FOUND with retryable:false - do not retry the same id. '
        + 'stockOnHand reflects the organization at fetch time; re-fetch before acting on it.',
      inputSchema: getItemInputSchema,
      outputSchema: getItemOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async ({ itemId }) => {
        const item = await adapter.getItem(itemId);
        return { provider: 'zoho-inventory' as const, fetchedAt: now(), item };
      },
    },
    {
      name: 'zoho_list_sales_orders',
      provider: 'zoho-inventory',
      description:
        'List Zoho Inventory sales orders with pagination (read-only). '
        + 'USE WHEN: reviewing the order book - shipment status, what has shipped vs what is still open, or locating a sales order id first. '
        + 'DO NOT USE WHEN: you already have a sales order id (zoho_get_sales_order), or you need catalogue/stock data (zoho_list_items). '
        + 'NOTE: Zoho documents NO status, date or customer filter for this endpoint, so this tool only pages through the list; '
        + 'filter the returned items yourself. Pagination: page starts at 1, perPage defaults to 200 (Zoho default). '
        + 'Zoho reports no total count, so total is null and hasMore comes from the upstream page_context. '
        + 'status.label is derived from the raw status code - Zoho does not publish the full status enum.',
      inputSchema: listSalesOrdersInputSchema,
      outputSchema: listSalesOrdersOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (args) => {
        const result = await adapter.listSalesOrders({ page: args.page, perPage: args.perPage });
        return { provider: 'zoho-inventory' as const, fetchedAt: now(), ...result };
      },
    },
    {
      name: 'zoho_get_sales_order',
      provider: 'zoho-inventory',
      description:
        'Fetch ONE Zoho Inventory sales order by its salesorder_id, including line items, shipment progress and totals (read-only). '
        + 'USE WHEN: you already have a sales order id - from zoho_list_sales_orders or the user. '
        + 'DO NOT USE WHEN: you only have a customer name or an order number fragment - page through zoho_list_sales_orders first. '
        + 'An unknown id returns error code NOT_FOUND with retryable:false - do not retry the same id. '
        + 'Line items carry itemId/quantity/shipped/invoiced state, and totals are numeric (not strings). '
        + 'customerName is customer data - keep it inside the merchant context you were given.',
      inputSchema: getSalesOrderInputSchema,
      outputSchema: getSalesOrderOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async ({ salesOrderId }) => {
        const salesOrder = await adapter.getSalesOrder(salesOrderId);
        return { provider: 'zoho-inventory' as const, fetchedAt: now(), salesOrder };
      },
    },
  ];
}
const listSalesOrdersOutputSchema = z.object({
  provider: z.literal('zoho-inventory'),
  fetchedAt: z.string(),
  page: z.number(),
  perPage: z.number(),
  hasMore: z.boolean(),
  total: z.number().nullable(),
  items: z.array(salesOrderSummarySchema),
});

const getSalesOrderOutputSchema = z.object({
  provider: z.literal('zoho-inventory'),
  fetchedAt: z.string(),
  salesOrder: salesOrderDetailSchema,
});