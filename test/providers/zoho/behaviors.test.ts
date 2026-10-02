import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../../src/core/tools.ts';
import { executeToolDefinition } from '../../../src/core/tools.ts';
import { createFixtureFetch } from '../../../src/fixtures/transport.ts';
import { zohoFixtureRoutes } from '../../../src/providers/zoho/routes.ts';
import { zohoTools } from '../../helpers.ts';

/** Same shape as the other provider suites: never touch structuredContent on an error. */
async function run(tool: ToolDefinition | undefined, args: unknown): Promise<Record<string, any>> {
  expect(tool, 'tool must exist').toBeDefined();
  const result = await executeToolDefinition(tool!, args);
  if (result.isError) return { isError: true, error: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  return { isError: false, data: result.structuredContent as Record<string, unknown> };
}
/**
 * Zoho Inventory behavior tests (fixture transport).
 *
 * These encode the VERIFIED contract (https://www.zoho.com/inventory/api/v1/,
 * checked 2026-10-02): the list envelope with `page_context`, `organization_id`
 * on every request, exact-SKU matching, and the normalization an agent relies on
 * (stock on hand, reorder level, string-exact 16-digit ids).
 */

describe('Zoho Inventory happy paths (fixtures)', () => {
  it('lists items with the documented envelope and normalized stock fields', async () => {
    const urls: string[] = [];
    const { byName } = zohoTools({
      fetchImpl: createFixtureFetch({ routes: zohoFixtureRoutes(), onRequest: (u) => urls.push(u.toString()) }),
    });
    const result = await run(byName.get('zoho_list_items'), {});
    expect(result.isError).toBe(false);

    const data = result.data as {
      items: Array<Record<string, unknown>>;
      total: number | null;
      page: number;
      perPage: number;
    };
    expect(data.page).toBe(1);
    expect(data.perPage).toBe(200); // VERIFIED Zoho default
    expect(data.total).toBeNull(); // page_context carries no total
    expect(data.items).toHaveLength(3);

    const first = data.items[0]!;
    expect(first['provider']).toBe('zoho-inventory');
    expect(first['id']).toBe('4815000000044208'); // 16-digit id preserved exactly as a string
    expect(first['sku']).toBe('ACC-BLUE-M');
    expect(first['stockOnHand']).toBe(148);
    expect(first['reorderLevel']).toBe(25);
    expect(first['status']).toEqual({ code: 'active', label: 'Active' });
    expect(first['itemType']).toEqual({ code: 'inventory', label: 'Inventory' });

    // organization_id is appended by the adapter on every request (VERIFIED).
    // urls[0] is the OAuth token exchange (it happens first); the data call is last.
    const tokenUrl = urls[0]!;
    expect(tokenUrl).toContain('accounts.zoho.com/oauth/v2/token');
    // The token exchange must never carry credentials in the URL (they go in a form body).
    expect(tokenUrl).not.toContain('client_secret');
    expect(tokenUrl).not.toContain('refresh_token');
    const dataUrl = urls.at(-1)!;
    expect(dataUrl).toContain('organization_id=10234695');
    expect(dataUrl).toContain('/inventory/v1/items');
  });

  it('maps documented filter_by values, exact sku and search_text', async () => {
    const urls: string[] = [];
    const { byName } = zohoTools({
      fetchImpl: createFixtureFetch({ routes: zohoFixtureRoutes(), onRequest: (u) => urls.push(u.toString()) }),
    });

    const lowStock = await run(byName.get('zoho_list_items'), { filterBy: 'Status.Lowstock' });
    expect(lowStock.isError).toBe(false);
    // ACC-GREEN-L: stock 8 <= reorder 20. The blue bottle (148/25) and the
    // service item (0/0) must not appear.
    const lowItems = (lowStock.data as { items: Array<{ sku: string }> }).items;
    expect(lowItems.map((i: { sku: string }) => i.sku)).toEqual(['ACC-GREEN-L']);
    expect(urls.at(-1)).toContain('filter_by=Status.Lowstock');

    const bySku = await run(byName.get('zoho_list_items'), { sku: 'ACC-BLUE-M' });
    expect((bySku.data as { items: Array<{ sku: string }> }).items.map((i) => i.sku)).toEqual(['ACC-BLUE-M']);
    const bySearch = await run(byName.get('zoho_list_items'), { searchText: 'bottle' });
    expect(((bySearch.data as { items: unknown[] }).items)).toHaveLength(2);
  });

  it('returns an item detail with tax, purchase and identifier fields', async () => {
    const { byName } = zohoTools();
    const result = await run(byName.get('zoho_get_item'), { itemId: '4815000000044208' });
    expect(result.isError).toBe(false);
    const { item } = result.data as { item: Record<string, unknown> };
    expect(item['id']).toBe('4815000000044208');
    expect(item['stockOnHand']).toBe(148);
    expect(item['taxName']).toBe('VAT');
    expect(item['purchaseRate']).toBe(11.2);
    expect(item['partNumber']).toBe('ACC-BLUE-M-750');
    expect(item['attributeNames']).toEqual(['Medium']);
    expect(item['hasImage']).toBe(true);
  });

  it('lists sales orders and fetches one with line items and shipment progress', async () => {
    const urls: string[] = [];
    const { byName } = zohoTools({
      fetchImpl: createFixtureFetch({ routes: zohoFixtureRoutes(), onRequest: (u) => urls.push(u.toString()) }),
    });

    const list = await run(byName.get('zoho_list_sales_orders'), {});
    expect(list.isError).toBe(false);
    const items = (list.data as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(2);
    // Money stays a NUMBER here (unlike WooCommerce strings) and ids stay strings.
    expect(items[0]!['total']).toBe(104);
    expect(items[1]!['status']).toEqual({ code: 'confirmed', label: 'Confirmed' }); // humanized, not an invented enum
    expect(urls.at(-1)).toContain('/inventory/v1/salesorders');

    const detail = await run(byName.get('zoho_get_sales_order'), { salesOrderId: '4815000000045208' });
    expect(detail.isError).toBe(false);
    const { salesOrder } = detail.data as { salesOrder: Record<string, unknown> };
    expect(salesOrder['salesOrderNumber']).toBe('SO-00004');
    expect(salesOrder['isBackorder']).toBe(true);
    expect(salesOrder['shipmentDate']).toBeNull();
    const lines = salesOrder['lineItems'] as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]!['itemId']).toBe('4815000000044274');
    expect(lines[0]!['quantity']).toBe(12);
    expect(salesOrder['itemCount']).toBe(1);
  });

  it('accepts numeric ids as well as string ids', async () => {
    const { byName } = zohoTools();
    const asNumber = await run(byName.get('zoho_get_item'), { itemId: 4815000000044208 });
    expect(asNumber.isError).toBe(false);
    const asString = await run(byName.get('zoho_get_item'), { itemId: '4815000000044208' });
    // Compare the record only: fetchedAt legitimately differs between calls.
    expect((asString.data as { item: unknown }).item).toEqual(
      (asNumber.data as { item: unknown }).item,
    );
  });

  it('treats an empty result as success, not an error', async () => {
    const { byName } = zohoTools();
    const result = await run(byName.get('zoho_list_items'), { searchText: 'no-such-item-anywhere' });
    expect(result.isError).toBe(false);
    expect((result.data as { items: unknown[] }).items).toEqual([]);
  });
});
