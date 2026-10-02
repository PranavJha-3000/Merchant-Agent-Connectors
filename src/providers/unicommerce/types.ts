import { z } from 'zod';

/**
 * Raw Unicommerce response schemas (validation layer).
 *
 * Only VERIFIED fields (https://documentation.unicommerce.com/, checked
 * 2026-10-02: `/docs/saleorder-search.html`, `/docs/saleorder-get.html`,
 * `/docs/response-codes.html`) are declared. Unknown fields are preserved via
 * .passthrough() and ignored during normalization (schema-drift tolerance).
 *
 * Two Unicommerce quirks are handled here rather than in the adapter:
 * 1. Every response is wrapped in `{ successful, message, errors[], warnings[],
 *    ... }`, so failures arrive as HTTP 200 with `successful: false`.
 * 2. Timestamps appear as **epoch-millisecond numbers** (e.g. 1598293800000) in
 *    the docs examples, while the search `elements[]` example shows ISO text -
 *    both are accepted and normalized to ISO-8601.
 */

/** Epoch-millis number or ISO text, both documented forms. */
const timestampSchema = z.union([z.number(), z.string()]).nullable().catch(null);

/** Documented `errors[]` entry: { code, fieldName, description, message }. */
export const rawApiErrorSchema = z
  .object({
    code: z.number().nullable().catch(null),
    message: z.string().nullable().catch(null),
    description: z.string().nullable().catch(null),
    fieldName: z.string().nullable().catch(null),
  })
  .passthrough();
export type RawApiError = z.infer<typeof rawApiErrorSchema>;

/** VERIFIED envelope keys shared by search and get. */
const envelopeBase = {
  successful: z.boolean().nullable().catch(null),
  message: z.string().nullable().catch(null),
  errors: z.array(rawApiErrorSchema).catch([]),
  warnings: z.array(rawApiErrorSchema).catch([]),
};

/**
 * Minimal documented envelope, used FIRST so a rejected request is classified
 * before any resource-specific validation: a failure response legitimately
 * omits `elements` / `saleOrderDTO`, so validating those first would report
 * "unexpected payload shape" instead of the documented error.
 */
export const rawEnvelopeSchema = z
  .object({ ...envelopeBase })
  .passthrough();
export type RawEnvelope = z.infer<typeof rawEnvelopeSchema>;

/** Search `elements[]` row - the only per-order fields search returns. */
export const rawSaleOrderSearchRowSchema = z
  .object({
    code: z.string(),
    displayOrderCode: z.string().nullable().catch(null),
    channel: z.string().nullable().catch(null),
    status: z.string().nullable().catch(null),
    displayOrderDateTime: timestampSchema,
    created: timestampSchema,
    updated: timestampSchema,
    notificationEmail: z.string().nullable().catch(null),
    notificationMobile: z.string().nullable().catch(null),
  })
  .passthrough();
export type RawSaleOrderSearchRow = z.infer<typeof rawSaleOrderSearchRowSchema>;

export const rawSaleOrderSearchSchema = z
  .object({
    ...envelopeBase,
    totalRecords: z.number().nullable().catch(null),
    // Required: a search response without its documented array is drift, and
    // reporting that as "no results" would silently lie to the agent.
    elements: z.array(rawSaleOrderSearchRowSchema),
  })
  .passthrough();
export type RawSaleOrderSearch = z.infer<typeof rawSaleOrderSearchSchema>;

const rawAddressSchema = z
  .object({
    id: z.string().nullable().catch(null),
    name: z.string().nullable().catch(null),
    city: z.string().nullable().catch(null),
    state: z.string().nullable().catch(null),
    country: z.string().nullable().catch(null),
    pincode: z.string().nullable().catch(null),
  })
  .passthrough();

const rawSaleOrderItemSchema = z
  .object({
    id: z.string().nullable().catch(null),
    code: z.string().nullable().catch(null),
    itemName: z.string().nullable().catch('(unnamed item)'),
    itemSku: z.string().nullable().catch(null),
    sellerSkuCode: z.string().nullable().catch(null),
    statusCode: z.string().nullable().catch(null),
    facilityCode: z.string().nullable().catch(null),
    facilityName: z.string().nullable().catch(null),
    shelfCode: z.string().nullable().catch(null),
    shippingPackageCode: z.string().nullable().catch(null),
    shippingPackageStatus: z.string().nullable().catch(null),
    shippingMethodCode: z.string().nullable().catch(null),
    sellingPrice: z.number().nullable().catch(null),
    totalPrice: z.number().nullable().catch(null),
    discount: z.number().nullable().catch(null),
    taxPercentage: z.number().nullable().catch(null),
    cancellable: z.boolean().nullable().catch(null),
    onHold: z.boolean().nullable().catch(null),
    cancellationReason: z.string().nullable().catch(null),
    created: timestampSchema,
    updated: timestampSchema,
  })
  .passthrough();
export type RawSaleOrderItem = z.infer<typeof rawSaleOrderItemSchema>;

export const rawSaleOrderDtoSchema = z
  .object({
    code: z.string(),
    displayOrderCode: z.string().nullable().catch(null),
    channel: z.string().nullable().catch(null),
    source: z.string().nullable().catch(null),
    status: z.string().nullable().catch(null),
    displayOrderDateTime: timestampSchema,
    created: timestampSchema,
    updated: timestampSchema,
    channelProcessingTime: timestampSchema,
    fulfillmentTat: timestampSchema,
    notificationEmail: z.string().nullable().catch(null),
    notificationMobile: z.string().nullable().catch(null),
    customerGSTIN: z.string().nullable().catch(null),
    cod: z.boolean().nullable().catch(null),
    thirdPartyShipping: z.boolean().nullable().catch(null),
    priority: z.number().nullable().catch(null),
    currencyCode: z.string().nullable().catch(null),
    customerCode: z.string().nullable().catch(null),
    billingAddress: rawAddressSchema.nullable().catch(null),
    saleOrderItems: z.array(rawSaleOrderItemSchema).catch([]),
    cancellable: z.boolean().nullable().catch(null),
    reversePickable: z.boolean().nullable().catch(null),
    totalDiscount: z.number().nullable().catch(null),
    totalShippingCharges: z.number().nullable().catch(null),
    additionalInfo: z.string().nullable().catch(null),
  })
  .passthrough();
export type RawSaleOrderDto = z.infer<typeof rawSaleOrderDtoSchema>;

export const rawSaleOrderGetSchema = z
  .object({
    ...envelopeBase,
    // Required for the same reason as `elements` above.
    saleOrderDTO: rawSaleOrderDtoSchema,
  })
  .passthrough();
export type RawSaleOrderGet = z.infer<typeof rawSaleOrderGetSchema>;