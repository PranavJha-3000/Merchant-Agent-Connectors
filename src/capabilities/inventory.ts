import { z } from 'zod';
import type { PageEnvelope } from '../core/pagination.ts';
import { enumValueSchema } from './common.ts';

/**
 * Inventory-item domain: normalized models + capability interfaces.
 *
 * Deliberately NOT the same type as the WooCommerce product (catalog.ts): a
 * Zoho Inventory item is a stocked SKU with `stock_on_hand`/`reorder_level`
 * semantics, tax treatment and item types (goods/service/inventory), while a
 * WooCommerce product is a storefront catalogue entry with price/stock-status
 * strings. Forcing one shape would delete exactly the fields a merchant
 * fulfilment agent needs. Kept in its own file so an order model never depends
 * on an inventory model (AGENTS.md §6).
 *
 * Field sources (VERIFIED 2026-10-02): https://www.zoho.com/inventory/api/v1/items/
 * - list example fields: group_id, group_name, item_id, name, status, source,
 *   item_type, description, rate, is_taxable, tax_name, tax_percentage,
 *   purchase_rate, product_type, reorder_level, sku, upc, ean, isbn,
 *   part_number, image_name, image_type, created_time, last_modified_time,
 *   stock_on_hand.
 * - documented `status` values: active, inactive.
 * - documented item types (filter_by): ItemType.Sales / Purchases /
 *   SalesAndPurchases / Inventory / NonInventory / Service.
 *
 * IDs are STRINGS: Zoho item ids are 16-digit values (e.g. 4815000000044208).
 * Keeping them as strings guarantees exact preservation regardless of magnitude.
 * Nullable = upstream sends null; optional = upstream may omit the field.
 */

export const inventoryItemSummarySchema = z.object({
  /** Provider id that produced this record. */
  provider: z.string(),
  /** Provider-native item id, kept as a string to preserve it exactly. */
  id: z.string(),
  name: z.string(),
  /** Stock Keeping Unit - what merchants and warehouse staff search by. */
  sku: z.string().nullable(),
  /** active / inactive (documented); unknown codes keep their raw code. */
  status: enumValueSchema.nullable(),
  /** inventory / non_inventory / service / ... (documented ItemType values). */
  itemType: enumValueSchema.nullable(),
  /** goods / service / ... (observed in the docs example). */
  productType: enumValueSchema.nullable(),
  groupName: z.string().nullable(),
  /** Sales rate in the organization's currency (Zoho returns numbers, not strings). */
  rate: z.number().nullable(),
  /** Units currently on hand - the number fulfilment questions actually ask. */
  stockOnHand: z.number().nullable(),
  /** Reorder threshold configured on the item. */
  reorderLevel: z.number().nullable(),
  isTaxable: z.boolean().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type InventoryItemSummary = z.infer<typeof inventoryItemSummarySchema>;

export const inventoryItemDetailSchema = inventoryItemSummarySchema.extend({
  description: z.string().nullable(),
  purchaseDescription: z.string().nullable(),
  purchaseRate: z.number().nullable(),
  taxName: z.string().nullable(),
  taxPercentage: z.number().nullable(),
  upc: z.string().nullable(),
  ean: z.string().nullable(),
  isbn: z.string().nullable(),
  partNumber: z.string().nullable(),
  /** Attribute labels (e.g. size "Small"); names only, option ids stay upstream. */
  attributeNames: z.array(z.string()),
  /** Derived: whether the item has an image (image bytes/URLs stay upstream). */
  hasImage: z.boolean(),
});
export type InventoryItemDetail = z.infer<typeof inventoryItemDetailSchema>;

/** Params map 1:1 to VERIFIED Zoho Inventory item query parameters only. */
export interface ListItemsParams {
  page: number;
  perPage: number;
  /** search_text: "Search items by name, SKU, or other searchable fields". */
  searchText?: string;
  /** sku: exact SKU match. */
  sku?: string;
  /** filter_by: documented Status.* values only (ItemType.* intentionally not exposed). */
  filterBy?: string;
  /** sort_column: name, sku, rate, purchase_rate, created_time, last_modified_time, reorder_level, stock_on_hand. */
  sortColumn?: string;
  /** sort_order: 'A' ascending, 'D' descending. */
  sortOrder?: string;
}

/** Capabilities a provider may implement. Tools are only registered for implemented capabilities. */
export interface InventoryListable {
  listItems(params: ListItemsParams): Promise<PageEnvelope<InventoryItemSummary>>;
}
export interface InventoryReadable {
  getItem(itemId: string): Promise<InventoryItemDetail>;
}