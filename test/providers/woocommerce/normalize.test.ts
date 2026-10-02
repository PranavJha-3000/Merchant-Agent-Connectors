import { describe, expect, it } from 'vitest';
import {
  normalizeOrderDetail,
  normalizeOrderSummary,
  normalizeProductDetail,
  normalizeProductSummary,
} from '../../../src/providers/woocommerce/normalize.ts';
import { rawOrderSchema, rawProductSchema } from '../../../src/providers/woocommerce/types.ts';

/** Enum options verified at https://developer.woocommerce.com/docs/apis/rest-api/v3/ (orders/products). */
describe('normalizeOrderSummary', () => {
  it('maps known statuses to labels and keeps money as strings', () => {
    const raw = rawOrderSchema.parse({
      id: 1,
      number: '1',
      status: 'on-hold',
      currency: 'EUR',
      total: '99.90',
      customer_id: 0,
      date_created_gmt: '2026-01-01T00:00:00',
      date_modified: '2026-01-02T00:00:00',
    });
    const out = normalizeOrderSummary(raw);
    expect(out.status).toEqual({ code: 'on-hold', label: 'On hold' });
    expect(out.total).toBe('99.90'); // never parsed into a float
    expect(out.currency).toBe('EUR');
    expect(out.customerId).toBe(0); // guest preserved as 0
    expect(out.createdAt).toBe('2026-01-01T00:00:00');
    expect(out.provider).toBe('woocommerce');
  });

  it('degrades unknown statuses (plugin-registered) safely instead of crashing', () => {
    const raw = rawOrderSchema.parse({ id: 2, status: 'awaiting-pickup' });
    expect(normalizeOrderSummary(raw).status).toEqual({ code: 'awaiting-pickup', label: 'unknown' });
  });

  it('normalizes missing/null fields to null without throwing', () => {
    const raw = rawOrderSchema.parse({ id: 3, status: null, number: null, total: null });
    const out = normalizeOrderSummary(raw);
    expect(out.status).toBeNull();
    expect(out.number).toBeNull();
    expect(out.total).toBeNull();
    expect(out.updatedAt).toBeNull();
  });

  it('tolerates an unexpected null id via catch at list level only (top-level id is structural)', () => {
    // A payload without `id` must fail schema validation -> upstream drift error path,
    // exercised through the raw schema here.
    expect(rawOrderSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });
});

describe('normalizeOrderDetail', () => {
  it('flattens billing name, keeps line items, and derives itemCount', () => {
    const raw = rawOrderSchema.parse({
      id: 42,
      status: 'processing',
      billing: { first_name: 'Nora', last_name: 'Fisher', email: 'nora.fisher@example.test' },
      shipping: { city: 'Springfield', country: 'US' },
      line_items: [{ id: 1, name: 'Bottle', product_id: 17, quantity: 2, subtotal: '48.00', total: '48.00' }],
      customer_note: 'hi',
      payment_method_title: 'Card',
      date_paid: '2026-01-01T00:00:00',
    });
    const out = normalizeOrderDetail(raw);
    expect(out.billingName).toBe('Nora Fisher');
    expect(out.billingEmail).toBe('nora.fisher@example.test');
    expect(out.shippingCity).toBe('Springfield');
    expect(out.itemCount).toBe(1);
    expect(out.lineItems[0]!.productId).toBe(17);
    expect(out.customerNote).toBe('hi');
    expect(out.dateCompleted).toBeNull();
  });

  it('degrades missing address and line items to nulls/empty', () => {
    const raw = rawOrderSchema.parse({ id: 7 });
    const out = normalizeOrderDetail(raw);
    expect(out.billingName).toBeNull();
    expect(out.lineItems).toEqual([]);
    expect(out.itemCount).toBe(0);
  });
});

describe('normalizeProductSummary', () => {
  it('maps type/status/stock enums to labels', () => {
    const raw = rawProductSchema.parse({
      id: 17,
      name: 'Bottle',
      type: 'variable',
      status: 'publish',
      stock_status: 'onbackorder',
      price: '24.00',
      sku: 'ACC-BLUE-M',
      stock_quantity: 3,
      manage_stock: true,
    });
    const out = normalizeProductSummary(raw);
    expect(out.type).toEqual({ code: 'variable', label: 'Variable' });
    expect(out.status).toEqual({ code: 'publish', label: 'Published' });
    expect(out.stockStatus).toEqual({ code: 'onbackorder', label: 'On backorder' });
    expect(out.sku).toBe('ACC-BLUE-M');
    expect(out.price).toBe('24.00');
  });

  it('empty SKU becomes null (upstream sends an empty string)', () => {
    const raw = rawProductSchema.parse({ id: 18, name: 'Tee', sku: '', sale_price: '' });
    const out = normalizeProductSummary(raw);
    expect(out.sku).toBeNull();
    expect(out.salePrice).toBeNull();
  });

  it('degrades unknown stock statuses instead of crashing', () => {
    const raw = rawProductSchema.parse({ id: 19, name: 'Boot', stock_status: 'coming-soon' });
    expect(normalizeProductSummary(raw).stockStatus).toEqual({ code: 'coming-soon', label: 'unknown' });
  });
});

describe('normalizeProductDetail', () => {
  it('keeps categories/tags with ids and derives imageCount', () => {
    const raw = rawProductSchema.parse({
      id: 17,
      name: 'Bottle',
      permalink: 'https://store.fixture.example/product/bottle/',
      short_description: '<p>short</p>',
      description: '<p>long</p>',
      catalog_visibility: 'visible',
      categories: [{ id: 12, name: 'Drinkware', slug: 'drinkware' }],
      tags: [{ id: 3, name: 'outdoor', slug: 'outdoor' }],
      images: [{ id: 55 }, { id: 56 }],
    });
    const out = normalizeProductDetail(raw);
    expect(out.categories).toEqual([{ id: 12, name: 'Drinkware', slug: 'drinkware' }]);
    expect(out.tags[0]!.id).toBe(3);
    expect(out.imageCount).toBe(2);
    expect(out.catalogVisibility).toEqual({ code: 'visible', label: 'Visible' });
  });

  it('drops malformed category rows (missing id) instead of failing the read', () => {
    const raw = rawProductSchema.parse({ id: 17, name: 'Bottle', categories: [{ name: 'NoId' }, { id: 5, name: 'Ok' }] });
    const out = normalizeProductDetail(raw);
    expect(out.categories).toEqual([{ id: 5, name: 'Ok', slug: null }]);
  });
});