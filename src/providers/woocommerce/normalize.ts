import type { EnumValue } from '../../capabilities/common.ts';
import type { OrderDetail, OrderSummary } from '../../capabilities/orders.ts';
import type { ProductDetail, ProductSummary } from '../../capabilities/catalog.ts';
import type { RawOrder, RawProduct } from './types.ts';

/**
 * WooCommerce -> normalized domain translation (provider-owned).
 *
 * Enum options VERIFIED from https://developer.woocommerce.com/docs/apis/rest-api/v3/
 * (orders/ and products/ property tables + list parameters), checked 2026-10-02:
 *   Order status: pending, processing, on-hold, completed, cancelled, refunded,
 *                 failed, trash (list filter also accepts `any`)
 *   Product type: simple, grouped, external, variable
 *   Product status: draft, pending, private, publish (list filter also accepts
 *                 `any`; include_status additionally allows future/trash)
 *   Stock status: instock, outofstock, onbackorder
 * Stores can register custom statuses/types via plugins: unknown codes degrade
 * to label 'unknown' with the raw code preserved - never a crash.
 */

const PROVIDER = 'woocommerce';

const ORDER_STATUS_LABELS: Record<string, string> = {
  any: 'Any',
  pending: 'Pending',
  processing: 'Processing',
  'on-hold': 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  failed: 'Failed',
  trash: 'Trash',
};

const PRODUCT_STATUS_LABELS: Record<string, string> = {
  any: 'Any',
  draft: 'Draft',
  pending: 'Pending',
  private: 'Private',
  publish: 'Published',
  future: 'Scheduled',
  trash: 'Trash',
};

const PRODUCT_TYPE_LABELS: Record<string, string> = {
  simple: 'Simple',
  grouped: 'Grouped',
  external: 'External',
  variable: 'Variable',
};

const STOCK_STATUS_LABELS: Record<string, string> = {
  instock: 'In stock',
  outofstock: 'Out of stock',
  onbackorder: 'On backorder',
};

const CATALOG_VISIBILITY_LABELS: Record<string, string> = {
  visible: 'Visible',
  catalog: 'Catalog',
  search: 'Search',
  hidden: 'Hidden',
};

function toEnum(code: string | null | undefined, labels: Record<string, string>): EnumValue | null {
  if (code === null || code === undefined) return null;
  return { code, label: labels[code] ?? 'unknown' };
}

export function normalizeOrderSummary(raw: RawOrder): OrderSummary {
  return {
    provider: PROVIDER,
    id: raw.id,
    number: raw.number ?? null,
    status: toEnum(raw.status, ORDER_STATUS_LABELS),
    currency: raw.currency ?? null,
    total: raw.total ?? null,
    customerId: raw.customer_id ?? null,
    createdAt: raw.date_created_gmt ?? raw.date_created ?? null,
    updatedAt: raw.date_modified ?? null,
  };
}

export function normalizeOrderDetail(raw: RawOrder): OrderDetail {
  const lineItems = raw.line_items.map((li) => ({
    id: li.id ?? null,
    name: li.name ?? '(unnamed item)',
    productId: li.product_id ?? null,
    variationId: li.variation_id ?? null,
    quantity: li.quantity ?? null,
    subtotal: li.subtotal ?? null,
    total: li.total ?? null,
  }));
  return {
    ...normalizeOrderSummary(raw),
    datePaid: raw.date_paid ?? null,
    dateCompleted: raw.date_completed ?? null,
    paymentMethodTitle: raw.payment_method_title ?? null,
    customerNote: raw.customer_note ?? null,
    billingName: [raw.billing?.first_name, raw.billing?.last_name].filter(Boolean).join(' ') || null,
    billingEmail: raw.billing?.email ?? null,
    shippingCity: raw.shipping?.city ?? null,
    shippingCountry: raw.shipping?.country ?? null,
    lineItems,
    itemCount: lineItems.length,
  };
}

export function normalizeProductSummary(raw: RawProduct): ProductSummary {
  return {
    provider: PROVIDER,
    id: raw.id,
    name: raw.name ?? '(unnamed product)',
    slug: raw.slug ?? null,
    sku: raw.sku && raw.sku.length > 0 ? raw.sku : null,
    type: toEnum(raw.type, PRODUCT_TYPE_LABELS),
    status: toEnum(raw.status, PRODUCT_STATUS_LABELS),
    price: raw.price ?? null,
    regularPrice: raw.regular_price ?? null,
    salePrice: raw.sale_price && raw.sale_price.length > 0 ? raw.sale_price : null,
    onSale: raw.on_sale ?? null,
    stockStatus: toEnum(raw.stock_status, STOCK_STATUS_LABELS),
    stockQuantity: raw.stock_quantity ?? null,
    manageStock: raw.manage_stock ?? null,
    totalSales: raw.total_sales ?? null,
    featured: raw.featured ?? null,
    createdAt: raw.date_created ?? null,
    updatedAt: raw.date_modified ?? null,
  };
}

export function normalizeProductDetail(raw: RawProduct): ProductDetail {
  // rawTermSchema fields are nullish-caught (T | null | undefined): keep only
  // rows with both id and name, normalizing away the undefined-ness.
  const terms = (list: Array<{ id?: number | null; name?: string | null; slug?: string | null }>) =>
    list.flatMap((t) =>
      t.id !== undefined && t.id !== null && t.name !== undefined && t.name !== null
        ? [{ id: t.id, name: t.name, slug: t.slug ?? null }]
        : [],
    );
  return {
    ...normalizeProductSummary(raw),
    permalink: raw.permalink ?? null,
    shortDescription: raw.short_description ?? null,
    description: raw.description ?? null,
    catalogVisibility: toEnum(raw.catalog_visibility, CATALOG_VISIBILITY_LABELS),
    categories: terms(raw.categories),
    tags: terms(raw.tags),
    imageCount: raw.images.length,
  };
}