import { z } from 'zod';

/**
 * Raw Zoho Inventory response schemas (validation layer).
 *
 * Only VERIFIED fields from https://www.zoho.com/inventory/api/v1/items/ and
 * https://www.zoho.com/inventory/api/v1/salesorders/ (checked 2026-10-02) are
 * declared. Unknown fields are preserved via .passthrough() and ignored during
 * normalization (schema-drift tolerance). Only the resource id is required for
 * structure; everything else degrades safely (.catch) so a missing, null or
 * unexpected field never crashes a read.
 *
 * Ids arrive as large numeric-looking values (e.g. 4815000000044208) and are
 * accepted as number OR string, then normalized to strings so no value is ever
 * altered by float handling. Money is a NUMBER upstream here (unlike WooCommerce
 * strings), which is why the sales-order model keeps numbers.
 */

/** Zoho ids: numeric strings are the documented wire format; numbers are tolerated. */
const zohoIdSchema = z.union([z.string(), z.number()]).nullable().catch(null);

/**
 * A resource's own id is the one structurally required field (same rule as the
 * Freshdesk/WooCommerce validators): if upstream returns 200 without it, that is
 * drift and must surface as UpstreamResponseError rather than an empty record.
 */
const zohoRequiredIdSchema = z.union([z.string(), z.number()]);

export const rawItemSchema = z
  .object({
    item_id: zohoRequiredIdSchema,
    name: z.string().nullable().catch('(unnamed item)'),
    sku: z.string().nullable().catch(null),
    status: z.string().nullable().catch(null),
    item_type: z.string().nullable().catch(null),
    product_type: z.string().nullable().catch(null),
    group_name: z.string().nullable().catch(null),
    group_id: zohoIdSchema,
    rate: z.number().nullable().catch(null),
    stock_on_hand: z.number().nullable().catch(null),
    reorder_level: z.number().nullable().catch(null),
    is_taxable: z.boolean().nullable().catch(null),
    description: z.string().nullable().catch(null),
    purchase_description: z.string().nullable().catch(null),
    purchase_rate: z.number().nullable().catch(null),
    tax_name: z.string().nullable().catch(null),
    tax_percentage: z.number().nullable().catch(null),
    upc: z.string().nullable().catch(null),
    ean: z.string().nullable().catch(null),
    isbn: z.string().nullable().catch(null),
    part_number: z.string().nullable().catch(null),
    image_name: z.string().nullable().catch(null),
    created_time: z.string().nullable().catch(null),
    last_modified_time: z.string().nullable().catch(null),
  })
  .passthrough();
export type RawItem = z.infer<typeof rawItemSchema>;

export const rawSalesOrderLineItemSchema = z
  .object({
    item_id: zohoIdSchema,
    line_item_id: zohoIdSchema,
    name: z.string().nullable().catch('(unnamed line item)'),
    quantity: z.number().nullable().catch(null),
    rate: z.number().nullable().catch(null),
    item_total: z.number().nullable().catch(null),
    unit: z.string().nullable().catch(null),
    tax_name: z.string().nullable().catch(null),
    tax_percentage: z.number().nullable().catch(null),
    quantity_shipped: z.number().nullable().catch(null),
    quantity_invoiced: z.number().nullable().catch(null),
    quantity_packed: z.number().nullable().catch(null),
  })
  .passthrough();
export type RawSalesOrderLineItem = z.infer<typeof rawSalesOrderLineItemSchema>;

export const rawSalesOrderSchema = z
  .object({
    salesorder_id: zohoRequiredIdSchema,
    salesorder_number: z.string().nullable().catch(null),
    reference_number: z.string().nullable().catch(null),
    status: z.string().nullable().catch(null),
    customer_name: z.string().nullable().catch(null),
    customer_id: zohoIdSchema,
    date: z.string().nullable().catch(null),
    expected_shipment_date: z.string().nullable().catch(null),
    shipment_date: z.string().nullable().catch(null),
    shipment_days: z.number().nullable().catch(null),
    quantity: z.number().nullable().catch(null),
    quantity_invoiced: z.number().nullable().catch(null),
    quantity_packed: z.number().nullable().catch(null),
    quantity_shipped: z.number().nullable().catch(null),
    currency_code: z.string().nullable().catch(null),
    total: z.number().nullable().catch(null),
    bcy_total: z.number().nullable().catch(null),
    sales_channel: z.string().nullable().catch(null),
    is_emailed: z.boolean().nullable().catch(null),
    is_drop_shipment: z.boolean().nullable().catch(null),
    is_backorder: z.boolean().nullable().catch(null),
    created_time: z.string().nullable().catch(null),
    last_modified_time: z.string().nullable().catch(null),
    line_items: z.array(rawSalesOrderLineItemSchema).catch([]),
  })
  .passthrough();
export type RawSalesOrder = z.infer<typeof rawSalesOrderSchema>;

/** VERIFIED pagination node: { "page": 2, "per_page": 25, "has_more_page": false }. */
export const rawPageContextSchema = z
  .object({
    page: z.number().nullable().catch(null),
    per_page: z.number().nullable().catch(null),
    has_more_page: z.boolean().nullable().catch(null),
  })
  .passthrough();
export type RawPageContext = z.infer<typeof rawPageContextSchema>;

/**
 * List envelope. VERIFIED shape: { "code": 0, "message": "success",
 * "<items|salesorders>": [...], "page_context": {...} }. The resource array is
 * REQUIRED (not defaulted): a 200 whose body lacks the documented array is
 * drift, and reporting it as "no results" would silently lie to the agent.
 */
export const rawItemListSchema = z
  .object({
    code: z.number().nullable().catch(null),
    message: z.string().nullable().catch(null),
    items: z.array(rawItemSchema),
    page_context: rawPageContextSchema.nullable().catch(null),
  })
  .passthrough();
export type RawItemList = z.infer<typeof rawItemListSchema>;

export const rawSalesOrderListSchema = z
  .object({
    code: z.number().nullable().catch(null),
    message: z.string().nullable().catch(null),
    salesorders: z.array(rawSalesOrderSchema),
    page_context: rawPageContextSchema.nullable().catch(null),
  })
  .passthrough();
export type RawSalesOrderList = z.infer<typeof rawSalesOrderListSchema>;