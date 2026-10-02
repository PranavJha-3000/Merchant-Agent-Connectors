import { readFileSync } from 'node:fs';
import type { FixtureReply, FixtureRoute } from '../../fixtures/transport.ts';
import { UNICOMMERCE_SALE_ORDER_GET_PATH, UNICOMMERCE_SALE_ORDER_SEARCH_PATH, UNICOMMERCE_TOKEN_PATH } from './config.ts';

/**
 * Default fixture routes for Unicommerce (fixture mode).
 *
 * Synthetic data only; behavior mirrors VERIFIED API semantics
 * (https://documentation.unicommerce.com/, checked 2026-10-02):
 * - both sale-order endpoints are POST with a JSON request body;
 * - every response is wrapped in the documented envelope
 *   `{ successful, message, errors[], warnings[], ... }`, and `totalRecords`
 *   carries the search total when `getCount` is requested;
 * - failures arrive as HTTP 200 with `successful: false` and a populated
 *   `errors[]` (the documented error shape);
 * - the token endpoint answers `{ access_token, token_type, refresh_token,
 *   expires_in }`.
 *
 * Fixture-specific notes (NOT claimed as Unicommerce behavior):
 * - search filters are applied locally (displayOrderCode, status, channel,
 *   searchKey, onHold);
 * - an unknown order code is answered through the documented application-error
 *   channel using the catalogued code `INVALID_SALE_ORDER_CODE` (40005); which
 *   exact code a tenant returns for a non-existent order is UNVERIFIED.
 */

function loadFixture<T>(name: string): T {
  const url = new URL(`../../fixtures/unicommerce/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

type SearchRow = {
  code?: string;
  displayOrderCode?: string;
  channel?: string;
  status?: string;
  displayOrderDateTime?: number | string;
  created?: number | string;
  updated?: number | string;
  notificationEmail?: string;
  notificationMobile?: string;
};

/** Documented error-code catalog entry used for an unknown order code. */
const UNKNOWN_ORDER_ERROR = {
  successful: false,
  message: 'Invalid sale order code',
  errors: [
    { code: 40005, fieldName: 'code', description: 'Invalid sale order code', message: 'Invalid sale order code' },
  ],
  warnings: [],
};

function readJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (init === undefined || typeof init.body !== 'string') return {};
  try {
    const parsed = JSON.parse(init.body) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Apply the documented filters (NO paging) - `totalRecords` reports this count. */
function filterRows(body: Record<string, unknown>, rows: SearchRow[]): SearchRow[] {
  let matched = rows;
  const code = body['displayOrderCode'];
  if (typeof code === 'string') matched = matched.filter((r) => r.code === code || r.displayOrderCode === code);
  const status = body['status'];
  if (typeof status === 'string') matched = matched.filter((r) => r.status === status);
  const channel = body['channel'];
  if (typeof channel === 'string') matched = matched.filter((r) => r.channel === channel);
  const onHold = body['onHold'];
  // Fixture rule only: the real service decides what onHold means per order.
  if (typeof onHold === 'boolean') matched = matched.filter((r) => (r.status === 'PROCESSING') === onHold);
  const searchKey = (body['searchOptions'] as Record<string, unknown> | undefined)?.['searchKey'];
  if (typeof searchKey === 'string' && searchKey.length > 0) {
    const needle = searchKey.toLowerCase();
    matched = matched.filter(
      (r) =>
        (r.code ?? '').toLowerCase().includes(needle) ||
        (r.displayOrderCode ?? '').toLowerCase().includes(needle) ||
        (r.channel ?? '').toLowerCase().includes(needle),
    );
  }
  return matched;
}

/** Slice the filtered set with the documented offset pair displayStart/displayLength. */
function pageRows(body: Record<string, unknown>, filtered: SearchRow[]): SearchRow[] {
  const options = (body['searchOptions'] ?? {}) as Record<string, unknown>;
  const displayStart = typeof options['displayStart'] === 'number' ? options['displayStart'] : 0;
  const displayLength = typeof options['displayLength'] === 'number' ? options['displayLength'] : 50;
  return filtered.slice(displayStart, displayStart + displayLength);
}

export function unicommerceFixtureRoutes(): FixtureRoute[] {
  const rows = loadFixture<{ elements: SearchRow[] }>('saleorders.search.json').elements;
  const saleOrder = loadFixture<Record<string, unknown>>('saleorder.SO1016233.json');

  return [
    {
      // GET /oauth/token (fixture token endpoint; fake token, never logged).
      match: (u) => u.pathname.endsWith(UNICOMMERCE_TOKEN_PATH),
      respond: () => ({
        status: 200,
        json: {
          access_token: 'fixture-unicommerce-access-token-not-real',
          token_type: 'bearer',
          refresh_token: 'fixture-unicommerce-refresh-token-not-real',
          expires_in: 3600,
          scope: 'read trust write',
        },
      }),
    },
    {
      // POST /services/rest/v1/oms/saleOrder/search
      match: (u) => u.pathname === UNICOMMERCE_SALE_ORDER_SEARCH_PATH,
      respond: (_u, _index, init) => {
        const body = readJsonBody(init);
        // VERIFIED: `totalRecords` counts the FILTERED matches, not the table.
        const filtered = filterRows(body, rows);
        const options = (body['searchOptions'] ?? {}) as Record<string, unknown>;
        return {
          status: 200,
          json: {
            successful: true,
            message: 'Success',
            errors: [],
            warnings: [],
            ...(options['getCount'] === true ? { totalRecords: filtered.length } : {}),
            elements: pageRows(body, filtered),
          },
        };
      },
    },
    {
      // POST /services/rest/v1/oms/saleorder/get
      match: (u) => u.pathname === UNICOMMERCE_SALE_ORDER_GET_PATH,
      respond: (_u, _index, init) =>
        readJsonBody(init)['code'] === 'SO1016233'
          ? { status: 200, json: saleOrder }
          : // Documented failure channel: HTTP 200 with successful:false + errors[].
            { status: 200, json: { ...UNKNOWN_ORDER_ERROR, saleOrderDTO: null } },
    },
  ];
}