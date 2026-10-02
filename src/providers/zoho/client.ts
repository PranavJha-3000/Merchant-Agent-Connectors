import type { z } from 'zod';
import { UpstreamResponseError } from '../../core/errors.ts';
import type { HttpClient, HttpResult } from '../../core/http.ts';
import type { PageEnvelope } from '../../core/pagination.ts';
import type { InventoryListable, InventoryItemDetail, InventoryItemSummary, InventoryReadable, ListItemsParams } from '../../capabilities/inventory.ts';
import type {
  ListSalesOrdersParams,
  SalesOrderDetail,
  SalesOrderListable,
  SalesOrderReadable,
  SalesOrderSummary,
} from '../../capabilities/salesOrders.ts';
import {
  normalizeItemDetail,
  normalizeItemSummary,
  normalizeSalesOrderDetail,
  normalizeSalesOrderSummary,
  paginationFromPageContext,
} from './normalize.ts';
import { rawItemListSchema, rawItemSchema, rawSalesOrderListSchema, rawSalesOrderSchema } from './types.ts';

/**
 * Zoho Inventory adapter: implements the inventory + sales-order capabilities.
 *
 * Owns route construction, query-parameter mapping (VERIFIED parameters only),
 * raw-payload validation and normalization. Contains no MCP types and no
 * retry/auth logic (core owns those).
 *
 * Verified endpoints (https://www.zoho.com/inventory/api/v1/, checked 2026-10-02):
 *   GET /inventory/v1/items?organization_id=..            "List all the items"
 *     page (default 1), per_page (default 200), search_text
 *     ("Search items by name, SKU, or other searchable fields"), sku (exact),
 *     filter_by (Status.* / ItemType.*), sort_column, sort_order (A/D)
 *   GET /inventory/v1/items/{item_id}?organization_id=.. "Retrieve an item"
 *   GET /inventory/v1/salesorders?organization_id=..     "List all Sales Orders"
 *     page (default 1), per_page (default 200)
 *   GET /inventory/v1/salesorders/{salesorder_id}?organization_id=..
 *     "Retrieve a Sales Order"
 *
 * `organization_id` is required on EVERY request (docs: "The parameter
 * organization_id along with the organization ID should be sent in with every
 * API request"), so it is configuration this adapter appends itself - never an
 * agent-supplied argument (AGENTS.md §8).
 *
 * Pagination comes from the VERIFIED `page_context` node
 * ({page, per_page, has_more_page}); Zoho reports no total count, so `total`
 * stays null rather than being inferred.
 */
export class ZohoInventoryAdapter implements InventoryListable, InventoryReadable, SalesOrderListable, SalesOrderReadable {
  private readonly http: HttpClient;
  private readonly organizationId: string;

  constructor(http: HttpClient, organizationId: string) {
    this.http = http;
    this.organizationId = organizationId;
  }

  async listItems(params: ListItemsParams): Promise<PageEnvelope<InventoryItemSummary>> {
    const res = await this.http.get({
      path: '/items',
      operation: 'zoho.listItems',
      query: {
        organization_id: this.organizationId,
        page: params.page,
        per_page: params.perPage,
        search_text: params.searchText,
        sku: params.sku,
        filter_by: params.filterBy,
        sort_column: params.sortColumn,
        sort_order: params.sortOrder,
      },
    });
    const raw = this.parse(res, rawItemListSchema, 'zoho.listItems');
    const page = paginationFromPageContext(raw.page_context, params.page, params.perPage);
    return { items: raw.items.map(normalizeItemSummary), ...page, total: null };
  }

  async getItem(itemId: string): Promise<InventoryItemDetail> {
    const res = await this.http.get({
      path: `/items/${encodeURIComponent(itemId)}`,
      operation: 'zoho.getItem',
      query: { organization_id: this.organizationId },
    });
    return normalizeItemDetail(this.parse(res, rawItemSchema, 'zoho.getItem'));
  }

  async listSalesOrders(params: ListSalesOrdersParams): Promise<PageEnvelope<SalesOrderSummary>> {
    const res = await this.http.get({
      path: '/salesorders',
      operation: 'zoho.listSalesOrders',
      // Only page/per_page are sent: the docs table also marks `salesorder_ids`
      // as required, but a plain list has no ids to supply and the documented
      // response returns the full list plus page_context (docs/limitations.md).
      query: { organization_id: this.organizationId, page: params.page, per_page: params.perPage },
    });
    const raw = this.parse(res, rawSalesOrderListSchema, 'zoho.listSalesOrders');
    const page = paginationFromPageContext(raw.page_context, params.page, params.perPage);
    return { items: raw.salesorders.map(normalizeSalesOrderSummary), ...page, total: null };
  }

  async getSalesOrder(salesOrderId: string): Promise<SalesOrderDetail> {
    const res = await this.http.get({
      path: `/salesorders/${encodeURIComponent(salesOrderId)}`,
      operation: 'zoho.getSalesOrder',
      query: { organization_id: this.organizationId },
    });
    return normalizeSalesOrderDetail(this.parse(res, rawSalesOrderSchema, 'zoho.getSalesOrder'));
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
        provider: 'zoho-inventory',
        operation,
        correlationId: res.correlationId,
        status: res.status,
        attempts: res.attempts,
        message: `Zoho Inventory returned an unexpected payload shape for ${operation}${paths ? ` at ${paths}` : ''} (not retried)`,
        hint: 'The response no longer matches the documented schema. Do not retry; report with the correlationId.',
      });
    }
    return result.data;
  }
}

/**
 * Connector-imposed cap. Zoho documents "paginated to 200 items by default" and
 * no maximum, so 200 is the documented default while 500 bounds outbound page
 * size - NOT a claimed Zoho limit.
 */
export const ZOHO_DEFAULT_PER_PAGE = 200;
export const ZOHO_MAX_PER_PAGE = 500;