import type { EnumValue } from '../../capabilities/common.ts';
import type { InventoryItemDetail, InventoryItemSummary } from '../../capabilities/inventory.ts';
import type { SalesOrderDetail, SalesOrderLineItem, SalesOrderSummary } from '../../capabilities/salesOrders.ts';
import type { RawItem, RawPageContext, RawSalesOrder, RawSalesOrderLineItem } from './types.ts';

/**
 * Zoho Inventory normalization (provider-owned, AGENTS.md §6).
 *
 * Two rules:
 * 1. IDs are preserved EXACTLY as strings (Zoho ids are 16-digit values).
 * 2. Enums degrade instead of throwing. Item `status` (active/inactive) and
 *    ItemType values are documented; the sales-order status enum is NOT
 *    enumerated on the checked pages, so unknown codes keep their raw code with
 *    a humanized label instead of a fabricated membership list.
 */

/** VERIFIED item status values (items docs `status` parameter). */
const ITEM_STATUS_LABELS: Record<string, string> = { active: 'Active', inactive: 'Inactive' };

/** VERIFIED item types (items docs `filter_by` ItemType.* values). */
const ITEM_TYPE_LABELS: Record<string, string> = {
  inventory: 'Inventory',
  non_inventory: 'Non-inventory',
  service: 'Service',
  sales: 'Sales',
  purchases: 'Purchases',
  salesandpurchases: 'Sales and purchases',
};

/** goods observed in the docs example; anything else is humanized, not invented. */
const PRODUCT_TYPE_LABELS: Record<string, string> = { goods: 'Goods', service: 'Service' };

/** humanize('on_hold') -> 'On hold'; used when a code has no documented label. */
function humanize(code: string): string {
  const spaced = code.replace(/[_-]+/g, ' ').trim();
  return spaced.length === 0 ? 'Unknown' : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function enumValue(code: string | null, labels?: Record<string, string>): EnumValue | null {
  if (code === null || code.trim().length === 0) return null;
  const key = code.trim();
  return { code: key, label: labels?.[key] ?? labels?.[key.toLowerCase()] ?? humanize(key) };
}

/** Ids arrive as numbers or strings; both become the exact digit string. */
export function toIdString(value: string | number | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

export function normalizeItemSummary(raw: RawItem): InventoryItemSummary {
  return {
    provider: 'zoho-inventory',
    id: toIdString(raw.item_id) ?? '(unknown)',
    name: raw.name ?? '(unnamed item)',
    sku: raw.sku,
    status: enumValue(raw.status, ITEM_STATUS_LABELS),
    itemType: enumValue(raw.item_type, ITEM_TYPE_LABELS),
    productType: enumValue(raw.product_type, PRODUCT_TYPE_LABELS),
    groupName: raw.group_name,
    rate: raw.rate,
    stockOnHand: raw.stock_on_hand,
    reorderLevel: raw.reorder_level,
    isTaxable: raw.is_taxable,
    createdAt: raw.created_time,
    updatedAt: raw.last_modified_time,
  };
}

/** Attribute labels are attribute_name1..N; option ids stay upstream. */
function attributeNames(raw: RawItem & Record<string, unknown>): string[] {
  const names: string[] = [];
  for (let i = 1; i <= 10; i += 1) {
    const value = raw[`attribute_name${i}`];
    if (typeof value === 'string' && value.length > 0) names.push(value);
  }
  return names;
}

export function normalizeItemDetail(raw: RawItem): InventoryItemDetail {
  return {
    ...normalizeItemSummary(raw),
    description: raw.description,
    purchaseDescription: raw.purchase_description,
    purchaseRate: raw.purchase_rate,
    taxName: raw.tax_name,
    taxPercentage: raw.tax_percentage,
    upc: raw.upc,
    ean: raw.ean,
    isbn: raw.isbn,
    partNumber: raw.part_number,
    attributeNames: attributeNames(raw as RawItem & Record<string, unknown>),
    hasImage: typeof raw.image_name === 'string' && raw.image_name.length > 0,
  };
}
function normalizeLineItem(raw: RawSalesOrderLineItem): SalesOrderLineItem {
  return {
    itemId: toIdString(raw.item_id),
    lineItemId: toIdString(raw.line_item_id),
    name: raw.name ?? '(unnamed line item)',
    quantity: raw.quantity,
    rate: raw.rate,
    itemTotal: raw.item_total,
    unit: raw.unit,
    taxName: raw.tax_name,
    taxPercentage: raw.tax_percentage,
    quantityShipped: raw.quantity_shipped,
    quantityInvoiced: raw.quantity_invoiced,
    quantityPacked: raw.quantity_packed,
  };
}

export function normalizeSalesOrderSummary(raw: RawSalesOrder): SalesOrderSummary {
  return {
    provider: 'zoho-inventory',
    id: toIdString(raw.salesorder_id) ?? '(unknown)',
    salesOrderNumber: raw.salesorder_number,
    referenceNumber: raw.reference_number,
    // No membership list invented: raw code + humanized label.
    status: enumValue(raw.status),
    customerName: raw.customer_name,
    customerId: toIdString(raw.customer_id),
    date: raw.date,
    total: raw.total,
    currencyCode: raw.currency_code,
    baseCurrencyTotal: raw.bcy_total,
    quantity: raw.quantity,
    quantityShipped: raw.quantity_shipped,
    shipmentDate: raw.shipment_date,
    createdAt: raw.created_time,
    updatedAt: raw.last_modified_time,
  };
}

export function normalizeSalesOrderDetail(raw: RawSalesOrder): SalesOrderDetail {
  return {
    ...normalizeSalesOrderSummary(raw),
    expectedShipmentDate: raw.expected_shipment_date,
    shipmentDays: raw.shipment_days,
    quantityInvoiced: raw.quantity_invoiced,
    quantityPacked: raw.quantity_packed,
    salesChannel: raw.sales_channel,
    isEmailed: raw.is_emailed,
    isDropShipment: raw.is_drop_shipment,
    isBackorder: raw.is_backorder,
    lineItems: raw.line_items.map(normalizeLineItem),
    itemCount: raw.line_items.length,
  };
}

/**
 * Pagination from the VERIFIED `page_context` node
 * ({page, per_page, has_more_page}). `hasMore` is only true on that upstream
 * signal; Zoho reports no total count, so `total` stays null.
 */
export function paginationFromPageContext(
  context: RawPageContext | null | undefined,
  requestedPage: number,
  requestedPerPage: number,
): { page: number; perPage: number; hasMore: boolean } {
  return {
    page: context?.page ?? requestedPage,
    perPage: context?.per_page ?? requestedPerPage,
    hasMore: context?.has_more_page === true,
  };
}