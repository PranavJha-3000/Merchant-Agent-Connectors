import type { z } from 'zod';
import { UpstreamResponseError } from '../../core/errors.ts';
import type { HttpClient, HttpResult } from '../../core/http.ts';
import type { PageEnvelope } from '../../core/pagination.ts';
import type {
  SaleOrderReadable,
  SaleOrderSearchable,
  SearchSaleOrdersParams,
  UnicommerceSaleOrderDetail,
  UnicommerceSaleOrderSummary,
} from '../../capabilities/unicommerceOrders.ts';
import {
  UNICOMMERCE_SALE_ORDER_GET_PATH,
  UNICOMMERCE_SALE_ORDER_SEARCH_PATH,
} from './config.ts';
import { unicommerceApplicationError } from './errors.ts';
import {
  buildSearchRequestBody,
  normalizeSaleOrderDetail,
  normalizeSearchRow,
} from './normalize.ts';
import { rawEnvelopeSchema, rawSaleOrderGetSchema, rawSaleOrderSearchSchema, type RawApiError } from './types.ts';

/**
 * Unicommerce adapter: read-only sale orders (search + get).
 *
 * Owns request-body construction, envelope handling and normalization. No MCP
 * types, no auth/retry logic (core owns those).
 *
 * VERIFIED endpoints (https://documentation.unicommerce.com/, checked 2026-10-02):
 *   POST /services/rest/v1/oms/saleOrder/search  "Search Sale Order"
 *     Level: Tenant, Scheme: HTTPS, Content-Type: application/json,
 *     Authorization: bearer {access-token}. Request payload fields used here:
 *     displayOrderCode, status, channel, customerEmailOrMobile, customerName,
 *     cashOnDelivery, fromDate, toDate, dateType, facilityCodes, onHold, and
 *     searchOptions{searchKey, displayStart, displayLength, getCount}.
 *     Response: { successful, message, errors[], warnings[], totalRecords, elements[] }.
 *   POST /services/rest/v1/oms/saleorder/get    "Get Sale Order"
 *     Request payload: code (MANDATORY). Response: { successful, message,
 *     errors[], warnings[], saleOrderDTO }.
 *
 * Pagination: the documented mechanism is the offset pair
 * `searchOptions.displayStart`/`displayLength`, and `totalRecords` is the
 * documented total (requested via `getCount`). `hasMore` is therefore derived
 * arithmetic on those two documented values, not a guess.
 */

/**
 * Connector-imposed paging bounds. Unicommerce documents neither a default nor a
 * maximum for `displayLength`, so both values here are ours and labelled as such.
 */
export const UNICOMMERCE_DEFAULT_PER_PAGE = 50;
export const UNICOMMERCE_MAX_PER_PAGE = 100;

export class UnicommerceAdapter implements SaleOrderSearchable, SaleOrderReadable {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async searchSaleOrders(params: SearchSaleOrdersParams): Promise<PageEnvelope<UnicommerceSaleOrderSummary>> {
    const res = await this.http.postJson({
      path: UNICOMMERCE_SALE_ORDER_SEARCH_PATH,
      json: buildSearchRequestBody(params),
      operation: 'unicommerce.searchSaleOrders',
    });
    // Order matters: the documented `errors[]` channel decides the outcome, so
    // it is inspected before the resource-specific schema is enforced.
    this.assertSuccessful(res, 'unicommerce.searchSaleOrders', this.parse(res, rawEnvelopeSchema, 'unicommerce.searchSaleOrders').errors);
    const raw = this.parse(res, rawSaleOrderSearchSchema, 'unicommerce.searchSaleOrders');

    const items = raw.elements.map(normalizeSearchRow);
    const total = raw.totalRecords ?? null;
    const offset = (params.page - 1) * params.perPage;
    return {
      items,
      page: params.page,
      perPage: params.perPage,
      // Derived from the documented total plus the returned count.
      hasMore: total !== null ? offset + items.length < total : false,
      total,
    };
  }

  async getSaleOrder(code: string): Promise<UnicommerceSaleOrderDetail> {
    const res = await this.http.postJson({
      path: UNICOMMERCE_SALE_ORDER_GET_PATH,
      // `code` is the only mandatory field (docs/saleorder-get.html, level 1).
      json: { code },
      operation: 'unicommerce.getSaleOrder',
    });
    // Same ordering as search: documented `errors[]` first, then the DTO schema.
    this.assertSuccessful(res, 'unicommerce.getSaleOrder', this.parse(res, rawEnvelopeSchema, 'unicommerce.getSaleOrder').errors);
    const raw = this.parse(res, rawSaleOrderGetSchema, 'unicommerce.getSaleOrder');
    return normalizeSaleOrderDetail(raw.saleOrderDTO);
  }

  /**
   * Unicommerce's documented failure channel: HTTP 200 with `successful: false`
   * and a populated `errors[]`. Converted here so a rejected request can never
   * be mistaken for an empty result.
   */
  private assertSuccessful(res: HttpResult, operation: string, errors: readonly RawApiError[]): void {
    if (errors.length === 0) return;
    throw unicommerceApplicationError({
      provider: 'unicommerce',
      operation,
      correlationId: res.correlationId,
      status: res.status,
      errors,
    });
  }

  /** Validate payload shape; drift -> UpstreamResponseError (never a crash, never a raw body). */
  private parse<T>(res: HttpResult, schema: z.ZodType<T>, operation: string): T {
    const result = schema.safeParse(res.json);
    if (!result.success) {
      const paths = result.error.issues
        .slice(0, 3)
        .map((i) => i.path.join('.') || '(root)')
        .join(', ');
      throw new UpstreamResponseError({
        provider: 'unicommerce',
        operation,
        correlationId: res.correlationId,
        status: res.status,
        attempts: res.attempts,
        message: `Unicommerce returned an unexpected payload shape for ${operation}${paths ? ` at ${paths}` : ''} (not retried)`,
        hint: 'The response no longer matches the documented schema. Do not retry; report with the correlationId.',
      });
    }
    return result.data;
  }
}