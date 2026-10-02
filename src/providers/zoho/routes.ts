import { readFileSync } from 'node:fs';
import type { FixtureReply, FixtureRoute } from '../../fixtures/transport.ts';

/**
 * Default fixture routes for Zoho Inventory (fixture mode).
 *
 * Synthetic data only; behavior mirrors VERIFIED API semantics
 * (https://www.zoho.com/inventory/api/v1/ checked 2026-10-02):
 * - list responses use the documented envelope `{code, message, <resource>[],
 *   page_context: {page, per_page, has_more_page}}`;
 * - `page` defaults to 1, `per_page` to 200 (docs: "paginated to 200 items by
 *   default");
 * - every request must carry `organization_id` (docs: it "should be sent in with
 *   every API request"), so a request without it gets the documented 400 shape;
 * - unknown ids return 404 with the documented `{code, message}` error body
 *   (the message follows the docs' "Invoice does not exist." example; the
 *   numeric `code` is representative and never asserted - the adapter maps by
 *   HTTP status).
 *
 * Fixture-specific notes (NOT claimed as Zoho behavior):
 * - `filter_by` implements the Status.* values (Status.Lowstock =
 *   stock_on_hand <= reorder_level); the group-level views return nothing;
 * - `search_text` matches name or SKU; `sku` is an exact match.
 */

function loadFixture<T>(name: string): T {
  const url = new URL(`../../fixtures/zoho/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

type ItemRecord = {
  item_id?: string | null;
  name?: string | null;
  sku?: string | null;
  status?: string | null;
  item_type?: string | null;
  group_name?: string | null;
  stock_on_hand?: number | null;
  reorder_level?: number | null;
};

type SalesOrderRecord = {
  salesorder_id?: string | null;
  date?: string | null;
};

/** VERIFIED error envelope shape: { "code": 1002, "message": "..." }. */
const NOT_FOUND_ITEM: FixtureReply = { status: 404, json: { code: 1008, message: 'Item does not exist.' } };
const NOT_FOUND_SALES_ORDER: FixtureReply = { status: 404, json: { code: 1002, message: 'Sales order does not exist.' } };
const MISSING_ORG: FixtureReply = {
  status: 400,
  json: { code: 101, message: 'organization_id is a required parameter.' },
};

function intParam(u: URL, key: string, fallback: number): number {
  const raw = u.searchParams.get(key);
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  return Number(raw);
}

/** VERIFIED list envelope with the page_context node. */
function listReply(resourceKey: 'items' | 'salesorders', u: URL, matched: unknown[]): FixtureReply {
  const page = intParam(u, 'page', 1);
  const perPage = intParam(u, 'per_page', 200);
  const totalPages = Math.max(1, Math.ceil(matched.length / perPage));
  const slice = matched.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
  return {
    status: 200,
    json: {
      code: 0,
      message: 'success',
      [resourceKey]: slice,
      page_context: { page, per_page: perPage, has_more_page: page < totalPages },
    },
  };
}

function filterItems(u: URL, items: ItemRecord[]): ItemRecord[] {
  let matched = items;
  const filterBy = u.searchParams.get('filter_by');
  if (filterBy !== null) {
    const value = filterBy.replace(/^Status\./, '').toLowerCase();
    matched = matched.filter((i) => {
      const onHand = i.stock_on_hand ?? 0;
      const reorder = i.reorder_level ?? 0;
      switch (value) {
        case 'all':
          return true;
        case 'active':
          return i.status === 'active';
        case 'inactive':
          return i.status === 'inactive';
        case 'lowstock':
          return onHand > 0 && onHand <= reorder;
        default:
          // unmapped/uncategorized/grouped are group-level views: not modelled.
          return false;
      }
    });
  }
  const search = u.searchParams.get('search_text');
  if (search !== null && search.length > 0) {
    const needle = search.toLowerCase();
    matched = matched.filter(
      (i) => (i.name ?? '').toLowerCase().includes(needle) || (i.sku ?? '').toLowerCase().includes(needle),
    );
  }
  const sku = u.searchParams.get('sku');
  if (sku !== null) matched = matched.filter((i) => i.sku === sku); // exact match (documented)
  const sortColumn = u.searchParams.get('sort_column');
  if (sortColumn !== null) {
    const desc = (u.searchParams.get('sort_order') ?? 'A').toUpperCase() === 'D';
    matched = [...matched].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortColumn];
      const bv = (b as Record<string, unknown>)[sortColumn];
      const cmp =
        typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return desc ? -cmp : cmp;
    });
  }
  return matched;
}

function sortSalesOrders(u: URL, orders: SalesOrderRecord[]): SalesOrderRecord[] {
  const desc = (u.searchParams.get('sort_order') ?? 'A').toUpperCase() === 'D';
  return [...orders].sort((a, b) => {
    const cmp = (a.date ?? '').localeCompare(b.date ?? '');
    return desc ? -cmp : cmp;
  });
}

export function zohoFixtureRoutes(): FixtureRoute[] {
  // List fixtures are stored as the documented ENVELOPE ({code, message, items[],
  // page_context}); the routes below re-paginate that array, so the raw resource
  // array is extracted here.
  const items = loadFixture<{ items: ItemRecord[] }>('items.list.json').items;
  const item4208 = loadFixture<unknown>('item.4815000000044208.json');
  const salesOrders = loadFixture<{ salesorders: SalesOrderRecord[] }>('salesorders.list.json').salesorders;
  const salesOrder5208 = loadFixture<unknown>('salesorder.4815000000045208.json');

  /** Every Zoho request must carry organization_id (VERIFIED). */
  const orgMissing = (u: URL): boolean => (u.searchParams.get('organization_id') ?? '') === '';

  return [
    {
      // POST https://accounts.zoho.com/oauth/v2/token
      // Fixture-only OAuth token endpoint. Without it the token strategy cannot
      // obtain a token offline. The returned access token is a fake string that
      // is only ever used as an Authorization header against the fixture
      // upstream (never logged, never persisted).
      match: (u) => u.hostname === 'accounts.zoho.com' && u.pathname.endsWith('/oauth/v2/token'),
      respond: () => ({
        status: 200,
        json: {
          access_token: '1000.fixture_access_token_not_a_real_token',
          token_type: 'bearer',
          expires_in: 3600,
        },
      }),
    },
    {
      // GET /inventory/v1/items/{item_id}
      match: (u) => /\/items\/\d+$/.test(u.pathname),
      respond: (u) => {
        if (orgMissing(u)) return MISSING_ORG;
        return u.pathname.endsWith('/items/4815000000044208') ? { status: 200, json: item4208 } : NOT_FOUND_ITEM;
      },
    },
    {
      // GET /inventory/v1/salesorders/{salesorder_id}
      match: (u) => /\/salesorders\/\d+$/.test(u.pathname),
      respond: (u) => {
        if (orgMissing(u)) return MISSING_ORG;
        return u.pathname.endsWith('/salesorders/4815000000045208')
          ? { status: 200, json: salesOrder5208 }
          : NOT_FOUND_SALES_ORDER;
      },
    },
    {
      // GET /inventory/v1/items
      match: (u) => u.pathname.endsWith('/items'),
      respond: (u) => (orgMissing(u) ? MISSING_ORG : listReply('items', u, filterItems(u, items))),
    },
    {
      // GET /inventory/v1/salesorders
      match: (u) => u.pathname.endsWith('/salesorders'),
      respond: (u) => (orgMissing(u) ? MISSING_ORG : listReply('salesorders', u, sortSalesOrders(u, salesOrders))),
    },
  ];
}