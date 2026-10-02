import { z } from 'zod';
import type { PageEnvelope } from '../core/pagination.ts';
import { enumValueSchema } from './common.ts';

/**
 * Unicommerce sale-order domain: normalized models + capability interfaces.
 *
 * Deliberately its own model - not the WooCommerce `OrderSummary` and not the
 * Zoho `SalesOrderSummary`. Unicommerce's sale order is a warehouse-fulfilment
 * document: per-item `facilityCode`/`shelfCode`/`shippingPackageCode`, a 12-value
 * item status taxonomy, `cod` / `thirdPartyShipping` flags, `customerGSTIN`,
 * and timestamps that arrive as **epoch-millisecond numbers** (Zoho gets ISO
 * text). Forcing an existing shape onto it would lose fulfilment state or
 * misreport dates, so this file is its own seam (AGENTS.md §6).
 *
 * Field sources (VERIFIED 2026-10-02, https://documentation.unicommerce.com/):
 * `/docs/saleorder-search.html` (search envelope, `elements[]`, `totalRecords`,
 * `searchOptions`) and `/docs/saleorder-get.html` (`saleOrderDTO`, the status
 * enum, `saleOrderItems[]` incl. the `statusCode` enum and `shippingMethodCode`).
 *
 * Nullable = upstream sends null; optional = upstream may omit the field.
 */

export const unicommerceSaleOrderSummarySchema = z.object({
  provider: z.string(),
  /** Provider-native sale order code (e.g. "SO1016233") for follow-up calls. */
  code: z.string(),
  /** Customer-facing order code shown in the UI (may differ from `code`). */
  displayOrderCode: z.string().nullable(),
  /** Channel code (tenant-specific: AMAZON, FLIPKART, CUSTOM, ...). */
  channel: z.string().nullable(),
  /** Source code - a VERIFIED field, distinct from channel. */
  source: z.string().nullable(),
  /** PENDING_VERIFICATION | CANCELLED | CREATED | PROCESSING | COMPLETE (VERIFIED). */
  status: enumValueSchema.nullable(),
  /** Order date, normalized to ISO-8601 from the upstream epoch-millis value. */
  orderDate: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Fulfilment turn-around time as an ISO timestamp. */
  fulfillmentTat: z.string().nullable(),
  isCashOnDelivery: z.boolean().nullable(),
  currencyCode: z.string().nullable(),
  /** Notification contacts - customer data, never a secret. */
  notificationEmail: z.string().nullable(),
  notificationMobile: z.string().nullable(),
});
export type UnicommerceSaleOrderSummary = z.infer<typeof unicommerceSaleOrderSummarySchema>;

export const unicommerceSaleOrderItemSchema = z.object({
  /** Line id within the order. */
  id: z.string().nullable(),
  code: z.string().nullable(),
  itemName: z.string(),
  itemSku: z.string().nullable(),
  sellerSkuCode: z.string().nullable(),
  /** CANCELLED, FULFILLABLE, CREATED, PROCESSING, PACKED, READY_TO_DISPATCH,
   * DISPATCHED, DELIVERED, REPLACED, RETURN_REQUESTED, COURIER_RETURN, RETURNED
   * (VERIFIED enum). */
  status: enumValueSchema.nullable(),
  /** Facility that will fulfil this line - the warehouse dimension Uniware adds. */
  facilityCode: z.string().nullable(),
  facilityName: z.string().nullable(),
  shelfCode: z.string().nullable(),
  shippingPackageCode: z.string().nullable(),
  shippingPackageStatus: z.string().nullable(),
  /** STD | EXP | PKP | CHQ (VERIFIED). */
  shippingMethodCode: enumValueSchema.nullable(),
  /** Money is a NUMBER upstream (unlike WooCommerce string decimals). */
  sellingPrice: z.number().nullable(),
  totalPrice: z.number().nullable(),
  discount: z.number().nullable(),
  taxPercentage: z.number().nullable(),
  cancellable: z.boolean().nullable(),
  onHold: z.boolean().nullable(),
  cancellationReason: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type UnicommerceSaleOrderItem = z.infer<typeof unicommerceSaleOrderItemSchema>;

export const unicommerceSaleOrderDetailSchema = unicommerceSaleOrderSummarySchema.extend({
  customerCode: z.string().nullable(),
  customerGstin: z.string().nullable(),
  /** Fulfilment priority integer (VERIFIED `priority`). */
  priority: z.number().nullable(),
  /** true when the marketplace handles shipping to the end customer. */
  thirdPartyShipping: z.boolean().nullable(),
  /** Derived from the documented per-item `onHold`: true when any line is held. */
  onHold: z.boolean().nullable(),
  cancellable: z.boolean().nullable(),
  reversePickable: z.boolean().nullable(),
  channelProcessingTime: z.string().nullable(),
  additionalInfo: z.string().nullable(),
  totalDiscount: z.number().nullable(),
  totalShippingCharges: z.number().nullable(),
  /** Billing address fragments - customer data, keep in the merchant context. */
  billingCity: z.string().nullable(),
  billingState: z.string().nullable(),
  billingCountry: z.string().nullable(),
  billingPincode: z.string().nullable(),
  items: z.array(unicommerceSaleOrderItemSchema),
  /** Derived: number of line items (not a raw upstream field). */
  itemCount: z.number(),
});
export type UnicommerceSaleOrderDetail = z.infer<typeof unicommerceSaleOrderDetailSchema>;

/**
 * Params map 1:1 to VERIFIED `POST /services/rest/v1/oms/saleOrder/search`
 * request fields only (checked 2026-10-02); anything undocumented is absent.
 *
 * Pagination: Unicommerce's documented paging mechanism is the offset pair
 * `searchOptions.displayStart` / `searchOptions.displayLength`, and the
 * documented total is `totalRecords` (requested with `getCount`). The adapter
 * maps 1-based `page`/`perPage` onto that pair.
 */
export interface SearchSaleOrdersParams {
  page: number;
  perPage: number;
  /** `displayOrderCode`: order code to be displayed. */
  displayOrderCode?: string;
  /** `status`: VERIFIED enum values only. */
  status?: string;
  /** `channel`: channel code (tenant-specific). */
  channel?: string;
  customerEmailOrMobile?: string;
  customerName?: string;
  /** `cashOnDelivery` - see the UNVERIFIED note in docs/providers/unicommerce.md. */
  cod?: boolean;
  /** `fromDate` / `toDate` (ISO-8601 date-time). */
  fromDate?: string;
  toDate?: string;
  /** `dateType`: CREATED | UPDATED | FULFILLMENT_TAT (VERIFIED enum). */
  dateType?: string;
  facilityCodes?: string[];
  /** `searchOptions.searchKey`: free-text search key. */
  searchKey?: string;
  onHold?: boolean;
}

/** Capabilities a provider may implement. Tools are only registered for implemented capabilities. */
export interface SaleOrderSearchable {
  searchSaleOrders(params: SearchSaleOrdersParams): Promise<PageEnvelope<UnicommerceSaleOrderSummary>>;
}
export interface SaleOrderReadable {
  getSaleOrder(code: string): Promise<UnicommerceSaleOrderDetail>;
}