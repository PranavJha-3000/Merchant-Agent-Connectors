import { z } from 'zod';
import type { PageEnvelope } from '../core/pagination.ts';
import { enumValueSchema } from './common.ts';

/**
 * Zoho-Inventory sales-order domain: normalized models + capability interfaces.
 *
 * Why this is NOT the order type in capabilities/orders.ts (WooCommerce):
 * Zoho's sales order is a fulfilment document - it tracks shipment_date,
 * shipment_days, quantity_packed/shipped/invoiced, a `sales_channel`, a
 * `reference_number` and `bcy_total` (base-currency total), and its `total` is a
 * NUMBER, not a string decimal. Overlaying it onto the WooCommerce order shape
 * would either lie about the money type or drop the fulfilment state a support
 * agent needs. Shared concepts live in core (page envelope, enum value), not in
 * a forced union. This is the intended extension seam for Unicommerce too.
 *
 * Field sources (VERIFIED 2026-10-02): https://www.zoho.com/inventory/api/v1/salesorders/
 * - list example: salesorder_id, customer_name, customer_id, status
 *   (observed value "fulfilled"), salesorder_number, reference_number, date,
 *   shipment_date, shipment_days, quantity, quantity_invoiced, quantity_packed,
 *   quantity_shipped, currency_code, total, bcy_total, created_time,
 *   last_modified_time, is_emailed, is_drop_shipment, is_backorder,
 *   sales_channel (observed "direct_sales"), custom_fields.
 * - line_items example: item_id, line_item_id, name, description, item_order,
 *   rate, quantity, quantity_invoiced/packed/shipped, unit, tax_name,
 *   tax_percentage, item_total, is_invoiced.
 *
 * The full status enum is NOT enumerated on the checked pages (only "fulfilled"
 * appears in examples), so `status.label` is a humanized form of whatever code
 * upstream sent and no membership list is invented here (docs/limitations.md).
 */

export const salesOrderLineItemSchema = z.object({
  /** Item id the line refers to (string: Zoho ids are 16-digit). */
  itemId: z.string().nullable(),
  lineItemId: z.string().nullable(),
  name: z.string(),
  quantity: z.number().nullable(),
  /** Unit rate in the transaction currency. */
  rate: z.number().nullable(),
  /** Line total as reported by Zoho. */
  itemTotal: z.number().nullable(),
  unit: z.string().nullable(),
  taxName: z.string().nullable(),
  taxPercentage: z.number().nullable(),
  quantityShipped: z.number().nullable(),
  quantityInvoiced: z.number().nullable(),
  quantityPacked: z.number().nullable(),
});
export type SalesOrderLineItem = z.infer<typeof salesOrderLineItemSchema>;

export const salesOrderSummarySchema = z.object({
  provider: z.string(),
  /** Provider-native salesorder_id, preserved exactly as a string. */
  id: z.string(),
  /** Human-facing document number (e.g. "SO-00003"). */
  salesOrderNumber: z.string().nullable(),
  /** Customer's external reference for this order, when present. */
  referenceNumber: z.string().nullable(),
  status: enumValueSchema.nullable(),
  customerName: z.string().nullable(),
  customerId: z.string().nullable(),
  /** Order date (YYYY-MM-DD upstream). */
  date: z.string().nullable(),
  /** Total in the transaction currency (NUMBER upstream, not a string). */
  total: z.number().nullable(),
  currencyCode: z.string().nullable(),
  /** Total converted into the organization's base currency. */
  baseCurrencyTotal: z.number().nullable(),
  quantity: z.number().nullable(),
  quantityShipped: z.number().nullable(),
  shipmentDate: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type SalesOrderSummary = z.infer<typeof salesOrderSummarySchema>;

export const salesOrderDetailSchema = salesOrderSummarySchema.extend({
  /** Promised/expected shipment date (distinct from `shipmentDate`). */
  expectedShipmentDate: z.string().nullable(),
  /** Difference between expected and actual shipment, in days. */
  shipmentDays: z.number().nullable(),
  quantityInvoiced: z.number().nullable(),
  quantityPacked: z.number().nullable(),
  salesChannel: z.string().nullable(),
  isEmailed: z.boolean().nullable(),
  isDropShipment: z.boolean().nullable(),
  isBackorder: z.boolean().nullable(),
  lineItems: z.array(salesOrderLineItemSchema),
  /** Derived: number of line rows (not a raw upstream field). */
  itemCount: z.number(),
});
export type SalesOrderDetail = z.infer<typeof salesOrderDetailSchema>;

/**
 * Params map 1:1 to VERIFIED parameters only: the sales-orders list documents
 * `organization_id` (Required), `salesorder_ids` (Required in the same table),
 * `page` (default 1) and `per_page` (default 200). No status/date/customer
 * filter is documented for this endpoint, so none is exposed or faked.
 */
export interface ListSalesOrdersParams {
  page: number;
  perPage: number;
}

/** Capabilities a provider may implement. Tools are only registered for implemented capabilities. */
export interface SalesOrderListable {
  listSalesOrders(params: ListSalesOrdersParams): Promise<PageEnvelope<SalesOrderSummary>>;
}
export interface SalesOrderReadable {
  getSalesOrder(salesOrderId: string): Promise<SalesOrderDetail>;
}