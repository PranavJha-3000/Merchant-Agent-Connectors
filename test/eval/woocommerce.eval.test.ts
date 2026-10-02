import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/core/http.ts';
import { executeToolDefinition, type ToolDefinition, type ToolResultEnvelope } from '../../src/core/tools.ts';
import { createFixtureFetch } from '../../src/fixtures/transport.ts';
import { woocommerceFixtureRoutes } from '../../src/providers/woocommerce/routes.ts';
import { woocommerceTools } from '../helpers.ts';

/**
 * Agent evaluation fixtures for WooCommerce - deterministic, LLM-free.
 *
 * Same model as the Freshdesk suite (docs/evaluation.md):
 *   business scenario -> expected tool -> expected arguments -> expected
 *   result class -> expected failure behavior -> success criterion.
 *
 * These tasks assert the CONTRACT an agent relies on when working a merchant
 * order/support workflow: which tool it should pick, how empty differs from
 * missing, and when to stop vs retry.
 */

interface EvalExpectation {
  class: 'success' | 'error';
  minItems?: number;
  items?: number;
  empty?: boolean;
  errorCode?: string;
  retryable?: boolean;
}

interface EvalTask {
  id: string;
  scenario: string;
  tool: string;
  args: unknown;
  expect: EvalExpectation;
  fetchImpl?: FetchLike;
  expectNoNetwork?: boolean;
}

const fixture: FetchLike = createFixtureFetch({ routes: woocommerceFixtureRoutes() });
const callCounts = { n: 0 };
const countingFixture: FetchLike = async (url, init) => {
  callCounts.n += 1;
  return fixture(url, init);
};

const tasks: EvalTask[] = [
  {
    id: 'browse-recent-orders',
    scenario: 'Agent must see the store\'s recent orders to triage fulfilment work',
    tool: 'woocommerce_list_orders',
    args: {},
    expect: { class: 'success', minItems: 1 },
    fetchImpl: countingFixture,
  },
  {
    id: 'find-unfulfilled-orders',
    scenario: 'Agent must list orders currently awaiting fulfilment (processing status)',
    tool: 'woocommerce_list_orders',
    args: { status: 'processing' },
    expect: { class: 'success', items: 1 },
    fetchImpl: countingFixture,
  },
  {
    id: 'retrieve-known-order',
    scenario: 'Agent has order id 42 and needs line items and payment dates',
    tool: 'woocommerce_get_order',
    args: { orderId: 42 },
    expect: { class: 'success' },
    fetchImpl: countingFixture,
  },
  {
    id: 'find-customer-orders-by-id',
    scenario: "Customer calls in; agent lists their orders by the store's numeric customer id",
    tool: 'woocommerce_list_orders',
    args: { customerId: 7 },
    expect: { class: 'success', items: 2 },
    fetchImpl: countingFixture,
  },
  {
    id: 'find-product-by-sku',
    scenario: 'Warehouse asks about a SKU: agent must use the product list with an exact SKU filter',
    tool: 'woocommerce_list_products',
    args: { sku: 'ACC-BLUE-M' },
    expect: { class: 'success', items: 1 },
    fetchImpl: countingFixture,
  },
  {
    id: 'check-stock-levels',
    scenario: 'Agent checks which products are out of stock for a customer answer',
    tool: 'woocommerce_list_products',
    args: { stockStatus: 'outofstock' },
    expect: { class: 'success', items: 1 },
    fetchImpl: countingFixture,
  },
  {
    id: 'empty-filter-is-not-an-error',
    scenario: 'No refunded orders exist: agent must see success with empty results, not an error',
    tool: 'woocommerce_list_orders',
    args: { status: 'refunded' },
    expect: { class: 'success', empty: true },
    fetchImpl: countingFixture,
  },
  {
    id: 'unknown-order-id-is-not-found',
    scenario: 'Order id does not exist: agent must get NOT_FOUND and not retry',
    tool: 'woocommerce_get_order',
    args: { orderId: 999999 },
    expect: { class: 'error', errorCode: 'NOT_FOUND', retryable: false },
    fetchImpl: countingFixture,
  },
  {
    id: 'stop-after-auth-failure',
    scenario: 'Store rejects the API key: agent must stop and report, not retry',
    tool: 'woocommerce_list_orders',
    args: {},
    expect: { class: 'error', errorCode: 'AUTHENTICATION_ERROR', retryable: false },
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 'woocommerce_rest_invalid_consumer_key', message: 'Consumer key is missing.', data: { status: 401 } }), {
        status: 401,
      }),
  },
  {
    id: 'reject-invalid-arguments-pre-network',
    scenario: 'Bad input must be rejected before any upstream call',
    tool: 'woocommerce_get_product',
    args: { productId: 0 },
    expect: { class: 'error', errorCode: 'VALIDATION_ERROR', retryable: false },
    fetchImpl: countingFixture,
    expectNoNetwork: true,
  },
];

function payloadOf(result: ToolResultEnvelope): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

describe('agent evaluation fixtures (WooCommerce)', () => {
  it('registers every task tool before evaluation', () => {
    const { byName } = woocommerceTools();
    for (const task of tasks) {
      expect(byName.has(task.tool), `missing tool for task ${task.id}`).toBe(true);
    }
  });

  for (const task of tasks) {
    it(`${task.id}: ${task.scenario}`, async () => {
      const { byName } = woocommerceTools(task.fetchImpl ? { fetchImpl: task.fetchImpl } : {});
      const tool: ToolDefinition = byName.get(task.tool)!;
      const before = callCounts.n;
      const result = await executeToolDefinition(tool, task.args);

      if (task.expectNoNetwork) {
        expect(callCounts.n).toBe(before);
      }

      if (task.expect.class === 'success') {
        if (result.isError) throw new Error(`expected success, got: ${result.content[0]!.text}`);
        const data = result.structuredContent as Record<string, unknown>;
        const items = data['items'];
        if (task.expect.empty) expect(items).toEqual([]);
        if (task.expect.items !== undefined) expect((items as unknown[]).length).toBe(task.expect.items);
        if (task.expect.minItems !== undefined) {
          expect((items as unknown[]).length).toBeGreaterThanOrEqual(task.expect.minItems);
        }
      } else {
        expect(result.isError).toBe(true);
        const payload = payloadOf(result);
        expect(payload['code']).toBe(task.expect.errorCode);
        if (task.expect.retryable !== undefined) expect(payload['retryable']).toBe(task.expect.retryable);
        expect(payload['correlationId']).toBeTruthy();
        expect(payload['provider']).toBe('woocommerce');
        expect(payload['operation']).toBe(task.tool);
      }
    });
  }
});
