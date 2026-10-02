import { z } from 'zod';
import type { PageEnvelope } from '../core/pagination.ts';
import { enumValueSchema } from './common.ts';

/**
 * Order domain: normalized models + capability interfaces.
 *
 * Normalization happens WITHIN this domain only (no fake merge with tickets or
 * inventory items). Semantics genuinely align across providers here: a future
 * Zoho/Unicommerce sales-order adapter can implement these same interfaces.
 *
 * Field sources (VERIFIED 2026-10-02):
 *   https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/ — property
 *   table (status options: pending, processing, on-hold, completed, cancelled,
 *   refunded, failed, trash; totals and prices are STRINGS to preserve decimal
 *   formatting; customer_id is 0 for guests).
 * Nullable = upstream sends null; optional = upstream may omit the field.
 */

export const orderLineItemSchema = z.object({
  /** Line-item id (order-scoped); null when upstream omits it. */
  id: z.number().nullable(),
  name: z.string(),
  productId: z.number().nullable(),
  variationId: z.number().nullable(),
  quantity: z.number().nullable(),
  /** Line subtotal before discounts, as reported (string decimal). */
  subtotal: z.string().nullable(),
  /** Line total after discounts, as reported (string decimal). */
  total: z.string().nullable(),
});
export type OrderLineItem = z.infer<typeof orderLineItemSchema>;

export const orderSummarySchema = z.object({
  /** Provider id that produced this record. */
  provider: z.string(),
  /** Provider-native ID (kept for direct follow-up calls). */
  id: z.number(),
  /** Human-facing order number (may differ from id when stores renumber). */
  number: z.string().nullable(),
  status: enumValueSchema.nullable(),
  /** ISO 4217 currency code the order was created with. */
  currency: z.string().nullable(),
  /** Grand total exactly as the store reports it (string decimal). */
  total: z.string().nullable(),
  /** WordPress user id; 0 = guest checkout. */
  customerId: z.number().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type OrderSummary = z.infer<typeof orderSummarySchema>;

export const orderDetailSchema = orderSummarySchema.extend({
  datePaid: z.string().nullable(),
  dateCompleted: z.string().nullable(),
  paymentMethodTitle: z.string().nullable(),
  /** Customer's own note at checkout — merchant data, never a secret. */
  customerNote: z.string().nullable(),
  billingName: z.string().nullable(),
  billingEmail: z.string().nullable(),
  shippingCity: z.string().nullable(),
  shippingCountry: z.string().nullable(),
  lineItems: z.array(orderLineItemSchema),
  /** Derived: number of line-item rows (not a raw upstream field). */
  itemCount: z.number(),
});
export type OrderDetail = z.infer<typeof orderDetailSchema>;

/** Params map 1:1 to VERIFIED WooCommerce list query parameters only. */
export interface ListOrdersParams {
  page: number;
  perPage: number;
  /** Single status value (docs type `status` as an array; V1 exposes one value). */
  status?: string;
  search?: string;
  customerId?: number;
  productId?: number;
  after?: string;
  before?: string;
}

/** Capabilities a provider may implement. Tools are only registered for implemented capabilities. */
export interface OrderListable {
  listOrders(params: ListOrdersParams): Promise<PageEnvelope<OrderSummary>>;
}
export interface OrderReadable {
  getOrder(orderId: number): Promise<OrderDetail>;
}