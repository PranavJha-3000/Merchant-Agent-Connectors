import { z } from 'zod';
import type { PageEnvelope } from '../core/pagination.ts';
import { enumValueSchema } from './common.ts';

/**
 * Product/catalog domain: normalized models + capability interfaces.
 *
 * Normalization happens WITHIN this domain only. Kept separate from orders on
 * purpose: a product and an order are different business concepts even when
 * they come from the same provider.
 *
 * Field sources (VERIFIED 2026-10-02):
 *   https://developer.woocommerce.com/docs/apis/rest-api/v3/products/ — property
 *   table (type options: simple, grouped, external, variable; status options:
 *   draft, pending, private, publish; stock_status options: instock, outofstock,
 *   onbackorder; `price` is READ-ONLY and a string decimal).
 * Nullable = upstream sends null; optional = upstream may omit the field.
 */

const categoryOrTagSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string().nullable(),
});
export type CatalogTerm = z.infer<typeof categoryOrTagSchema>;

export const productSummarySchema = z.object({
  /** Provider id that produced this record. */
  provider: z.string(),
  /** Provider-native ID (kept for direct follow-up calls). */
  id: z.number(),
  name: z.string(),
  slug: z.string().nullable(),
  /** Stock Keeping Unit — the identifier merchants actually search by. */
  sku: z.string().nullable(),
  type: enumValueSchema.nullable(),
  status: enumValueSchema.nullable(),
  /** Current price as reported (string decimal, store currency). */
  price: z.string().nullable(),
  regularPrice: z.string().nullable(),
  salePrice: z.string().nullable(),
  onSale: z.boolean().nullable(),
  stockStatus: enumValueSchema.nullable(),
  stockQuantity: z.number().nullable(),
  manageStock: z.boolean().nullable(),
  totalSales: z.number().nullable(),
  featured: z.boolean().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type ProductSummary = z.infer<typeof productSummarySchema>;

export const productDetailSchema = productSummarySchema.extend({
  /** Store-front URL of the product (null when upstream omits it). */
  permalink: z.string().nullable(),
  shortDescription: z.string().nullable(),
  description: z.string().nullable(),
  catalogVisibility: enumValueSchema.nullable(),
  categories: z.array(categoryOrTagSchema),
  tags: z.array(categoryOrTagSchema),
  /** Derived: number of images (URLs live upstream; not embedded in output). */
  imageCount: z.number(),
});
export type ProductDetail = z.infer<typeof productDetailSchema>;

/** Params map 1:1 to VERIFIED WooCommerce list query parameters only. */
export interface ListProductsParams {
  page: number;
  perPage: number;
  search?: string;
  sku?: string;
  status?: string;
  stockStatus?: string;
}

/** Capabilities a provider may implement. Tools are only registered for implemented capabilities. */
export interface ProductListable {
  listProducts(params: ListProductsParams): Promise<PageEnvelope<ProductSummary>>;
}
export interface ProductReadable {
  getProduct(productId: number): Promise<ProductDetail>;
}