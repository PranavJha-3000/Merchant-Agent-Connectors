import { z } from 'zod';

/**
 * Raw WooCommerce response schemas (validation layer).
 *
 * Only VERIFIED fields from
 * https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/ and
 * .../products/ are declared (checked 2026-10-02); unknown fields are
 * preserved via .passthrough() and ignored during normalization
 * (schema-drift tolerance). Required for structure: top-level `id`.
 * Everything else degrades safely (.catch) so a missing/null/unexpected field
 * never crashes a read - normalization maps it to null/'unknown'.
 *
 * Money values are STRINGS upstream (e.g. "58.00") - preserved as strings.
 * Dates come in two flavors: site-local (date_created) and GMT
 * (date_created_gmt); both are ISO-8601-shaped strings.
 */

const rawAddressSchema = z
  .object({
    first_name: z.string().nullish().catch(null),
    last_name: z.string().nullish().catch(null),
    email: z.string().nullish().catch(null),
    city: z.string().nullish().catch(null),
    state: z.string().nullish().catch(null),
    postcode: z.string().nullish().catch(null),
    country: z.string().nullish().catch(null),
    address_1: z.string().nullish().catch(null),
    company: z.string().nullish().catch(null),
  })
  .passthrough();

const rawLineItemSchema = z
  .object({
    id: z.number().nullish().catch(null),
    name: z.string().nullish().catch('(unnamed item)'),
    product_id: z.number().nullish().catch(null),
    variation_id: z.number().nullish().catch(null),
    quantity: z.number().nullish().catch(null),
    subtotal: z.string().nullish().catch(null),
    total: z.string().nullish().catch(null),
  })
  .passthrough();

export const rawOrderSchema = z
  .object({
    id: z.number(),
    number: z.string().nullish().catch(null),
    status: z.string().nullish().catch(null),
    currency: z.string().nullish().catch(null),
    total: z.string().nullish().catch(null),
    customer_id: z.number().nullish().catch(null),
    date_created: z.string().nullish().catch(null),
    date_created_gmt: z.string().nullish().catch(null),
    date_modified: z.string().nullish().catch(null),
    date_paid: z.string().nullish().catch(null),
    date_completed: z.string().nullish().catch(null),
    payment_method_title: z.string().nullish().catch(null),
    customer_note: z.string().nullish().catch(null),
    billing: rawAddressSchema.nullish().catch(null),
    shipping: rawAddressSchema.nullish().catch(null),
    line_items: z.array(rawLineItemSchema).catch([]),
  })
  .passthrough();
export type RawOrder = z.infer<typeof rawOrderSchema>;

export const rawOrderListSchema = z.array(rawOrderSchema);

const rawTermSchema = z
  .object({
    id: z.number().nullish().catch(null),
    name: z.string().nullish().catch(''),
    slug: z.string().nullish().catch(null),
  })
  .passthrough();

export const rawProductSchema = z
  .object({
    id: z.number(),
    name: z.string().nullish().catch('(unnamed product)'),
    slug: z.string().nullish().catch(null),
    permalink: z.string().nullish().catch(null),
    type: z.string().nullish().catch(null),
    status: z.string().nullish().catch(null),
    featured: z.boolean().nullish().catch(null),
    catalog_visibility: z.string().nullish().catch(null),
    description: z.string().nullish().catch(null),
    short_description: z.string().nullish().catch(null),
    sku: z.string().nullish().catch(null),
    price: z.string().nullish().catch(null),
    regular_price: z.string().nullish().catch(null),
    sale_price: z.string().nullish().catch(null),
    on_sale: z.boolean().nullish().catch(null),
    manage_stock: z.boolean().nullish().catch(null),
    stock_quantity: z.number().nullish().catch(null),
    stock_status: z.string().nullish().catch(null),
    total_sales: z.number().nullish().catch(null),
    date_created: z.string().nullish().catch(null),
    date_modified: z.string().nullish().catch(null),
    categories: z.array(rawTermSchema).catch([]),
    tags: z.array(rawTermSchema).catch([]),
    images: z.array(z.object({ id: z.number().nullish().catch(null) }).passthrough()).catch([]),
  })
  .passthrough();
export type RawProduct = z.infer<typeof rawProductSchema>;

export const rawProductListSchema = z.array(rawProductSchema);