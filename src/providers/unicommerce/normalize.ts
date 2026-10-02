import type { EnumValue } from '../../capabilities/common.ts';
import type {
  SearchSaleOrdersParams,
  UnicommerceSaleOrderDetail,
  UnicommerceSaleOrderItem,
  UnicommerceSaleOrderSummary,
} from '../../capabilities/unicommerceOrders.ts';
import type { RawApiError, RawSaleOrderDto, RawSaleOrderItem, RawSaleOrderSearchRow } from './types.ts';

/**
 * Unicommerce normalization (provider-owned, AGENTS.md §6).
 *
 * Enums here ARE documented, so labels come from verified value sets rather than
 * invention: sale-order status (5 values), item status (12 values), shipping
 * method (4 values). An unrecognized code keeps its raw value with a humanized
 * label, so a future Unicommerce status degrades instead of crashing.
 */

/** VERIFIED sale-order status enum (docs/saleorder-get.html, field 5.6). */
const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING_VERIFICATION: 'Pending verification',
  CANCELLED: 'Cancelled',
  CREATED: 'Created',
  PROCESSING: 'Processing',
  COMPLETE: 'Complete',
};

/** VERIFIED item status codes (docs/saleorder-get.html, field 5.21.20). */
const ITEM_STATUS_LABELS: Record<string, string> = {
  CANCELLED: 'Cancelled',
  FULFILLABLE: 'Fulfillable',
  CREATED: 'Created',
  PROCESSING: 'Processing',
  PACKED: 'Packed',
  READY_TO_DISPATCH: 'Ready to dispatch',
  DISPATCHED: 'Dispatched',
  DELIVERED: 'Delivered',
  REPLACED: 'Replaced',
  RETURN_REQUESTED: 'Return requested',
  COURIER_RETURN: 'Courier return',
  RETURNED: 'Returned',
};

/** VERIFIED shipping method codes (docs/saleorder-get.html, field 5.21.14). */
const SHIPPING_METHOD_LABELS: Record<string, string> = {
  STD: 'Standard',
  EXP: 'Express',
  PKP: 'Pickup',
  CHQ: 'Standard cheque',
};

/** humanize('READY_TO_DISPATCH') -> 'Ready to dispatch'; fallback for new codes. */
function humanize(code: string): string {
  const spaced = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return spaced.length === 0 ? 'Unknown' : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function enumValue(code: string | null, labels?: Record<string, string>): EnumValue | null {
  if (code === null || code.trim().length === 0) return null;
  const key = code.trim();
  return { code: key, label: labels?.[key] ?? humanize(key) };
}

/**
 * VERIFIED timestamps arrive as epoch milliseconds (e.g. 1598293800000); the
 * search example shows ISO text. Both normalize to ISO-8601 so an agent never has
 * to know the difference. Unparseable values become null, not a bogus date.
 */
export function normalizeTimestamp(value: number | string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // A numeric string is still epoch millis.
  if (/^\d{10,}$/.test(trimmed)) {
    const date = new Date(Number(trimmed));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Fields shared by the search row and the full DTO. */
function summaryFields(raw: {
  code: string;
  displayOrderCode: string | null;
  channel: string | null;
  source?: string | null;
  status: string | null;
  displayOrderDateTime: number | string | null;
  created: number | string | null;
  updated: number | string | null;
  fulfillmentTat?: number | string | null;
  notificationEmail: string | null;
  notificationMobile: string | null;
  currencyCode?: string | null;
  cod?: boolean | null;
}) {
  return {
    provider: 'unicommerce',
    code: raw.code,
    displayOrderCode: raw.displayOrderCode,
    channel: raw.channel,
    source: raw.source ?? null,
    status: enumValue(raw.status, ORDER_STATUS_LABELS),
    orderDate: normalizeTimestamp(raw.displayOrderDateTime),
    createdAt: normalizeTimestamp(raw.created),
    updatedAt: normalizeTimestamp(raw.updated),
    fulfillmentTat: normalizeTimestamp(raw.fulfillmentTat ?? null),
    isCashOnDelivery: raw.cod ?? null,
    currencyCode: raw.currencyCode ?? null,
    notificationEmail: raw.notificationEmail,
    notificationMobile: raw.notificationMobile,
  };
}

/** Search rows carry only a subset of fields; the rest stay null. */
export function normalizeSearchRow(raw: RawSaleOrderSearchRow): UnicommerceSaleOrderSummary {
  return summaryFields(raw);
}

function normalizeItem(raw: RawSaleOrderItem): UnicommerceSaleOrderItem {
  return {
    id: raw.id,
    code: raw.code,
    itemName: raw.itemName ?? '(unnamed item)',
    itemSku: raw.itemSku,
    sellerSkuCode: raw.sellerSkuCode,
    status: enumValue(raw.statusCode, ITEM_STATUS_LABELS),
    facilityCode: raw.facilityCode,
    facilityName: raw.facilityName,
    shelfCode: raw.shelfCode,
    shippingPackageCode: raw.shippingPackageCode,
    shippingPackageStatus: raw.shippingPackageStatus,
    shippingMethodCode: enumValue(raw.shippingMethodCode, SHIPPING_METHOD_LABELS),
    sellingPrice: raw.sellingPrice,
    totalPrice: raw.totalPrice,
    discount: raw.discount,
    taxPercentage: raw.taxPercentage,
    cancellable: raw.cancellable,
    onHold: raw.onHold,
    cancellationReason: raw.cancellationReason,
    createdAt: normalizeTimestamp(raw.created),
    updatedAt: normalizeTimestamp(raw.updated),
  };
}

export function normalizeSaleOrderDetail(raw: RawSaleOrderDto): UnicommerceSaleOrderDetail {
  const billing = raw.billingAddress;
  return {
    ...summaryFields(raw),
    customerCode: raw.customerCode,
    customerGstin: raw.customerGSTIN,
    priority: raw.priority,
    thirdPartyShipping: raw.thirdPartyShipping,
    // Uniware exposes `onHold` per item (5.21.43); order-level on-hold is derived
    // as "any line on hold" and documented as derived, not presented as raw.
    onHold: raw.saleOrderItems.some((i) => i.onHold === true) ? true : null,
    cancellable: raw.cancellable,
    reversePickable: raw.reversePickable,
    channelProcessingTime: normalizeTimestamp(raw.channelProcessingTime),
    additionalInfo: raw.additionalInfo,
    totalDiscount: raw.totalDiscount,
    totalShippingCharges: raw.totalShippingCharges,
    billingCity: billing?.city ?? null,
    billingState: billing?.state ?? null,
    billingCountry: billing?.country ?? null,
    billingPincode: billing?.pincode ?? null,
    items: raw.saleOrderItems.map(normalizeItem),
    itemCount: raw.saleOrderItems.length,
  };
}

/**
 * Build the documented JSON request body for sale-order search
 * (docs/saleorder-search.html "Request Payload"), including the offset paging
 * pair. Unset filters are OMITTED rather than sent as null, because the docs
 * describe each field as a filter that is simply absent when unused.
 *
 * Note on `cashOnDelivery`: the docs list it as "true if COD" with
 * "Default: true". What that default does when the field is absent is NOT
 * documented, so the adapter omits it unless the caller sets it explicitly
 * (see docs/providers/unicommerce.md).
 */
export function buildSearchRequestBody(params: SearchSaleOrdersParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    searchOptions: {
      displayStart: (params.page - 1) * params.perPage,
      displayLength: params.perPage,
      // VERIFIED boolean `getCount` - required to receive `totalRecords`.
      getCount: true,
      ...(params.searchKey !== undefined ? { searchKey: params.searchKey } : {}),
    },
  };
  if (params.displayOrderCode !== undefined) body['displayOrderCode'] = params.displayOrderCode;
  if (params.status !== undefined) body['status'] = params.status;
  if (params.channel !== undefined) body['channel'] = params.channel;
  if (params.customerEmailOrMobile !== undefined) body['customerEmailOrMobile'] = params.customerEmailOrMobile;
  if (params.customerName !== undefined) body['customerName'] = params.customerName;
  if (params.cod !== undefined) body['cashOnDelivery'] = params.cod;
  if (params.fromDate !== undefined) body['fromDate'] = params.fromDate;
  if (params.toDate !== undefined) body['toDate'] = params.toDate;
  if (params.dateType !== undefined) body['dateType'] = params.dateType;
  if (params.facilityCodes !== undefined) body['facilityCodes'] = params.facilityCodes;
  if (params.onHold !== undefined) body['onHold'] = params.onHold;
  return body;
}

/**
 * Read the documented `errors[]` array into one human-readable line for the error
 * mapper. Never returns raw payload JSON.
 */
export function describeApiErrors(errors: readonly RawApiError[]): string | null {
  const parts = errors
    .map((e) => {
      const code = e.code !== null ? `code ${e.code}` : null;
      const text = e.message ?? e.description ?? e.fieldName ?? null;
      return code !== null && text !== null ? `${text} (${code})` : (text ?? code);
    })
    .filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join('; ');
}
