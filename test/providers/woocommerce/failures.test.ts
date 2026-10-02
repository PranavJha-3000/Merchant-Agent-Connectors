import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/core/http.ts';
import type { ToolDefinition } from '../../../src/core/tools.ts';
import { executeToolDefinition } from '../../../src/core/tools.ts';
import { createFixtureFetch } from '../../../src/fixtures/transport.ts';
import { woocommerceFixtureRoutes } from '../../../src/providers/woocommerce/routes.ts';
import { woocommerceTools } from '../../helpers.ts';

async function call(tool: ToolDefinition | undefined, args: unknown): Promise<{ isError: boolean; payload: Record<string, any> }> {
  const result = await executeToolDefinition(tool!, args);
  if (result.isError) return { isError: true, payload: JSON.parse(result.content[0]!.text) as Record<string, any> };
  return { isError: false, payload: result.structuredContent as Record<string, any> };
}

/** WooCommerce error envelope shape (VERIFIED: docs/apis/rest-api "Errors"). */
const jsonResponse = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });

const wooError = (status: number, code: string, message: string): unknown => ({ code, message, data: { status } });

describe('WooCommerce failure behavior (normalized for agents)', () => {
  it('401 -> AUTHENTICATION_ERROR, single attempt, stop', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(401, wooError(401, 'woocommerce_rest_invalid_consumer_key', 'Consumer key is missing.'));
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await call(byName.get('woocommerce_get_order'), { orderId: 42 });
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('AUTHENTICATION_ERROR');
    expect(out.payload['retryable']).toBe(false);
    expect(out.payload['attempts']).toBe(1);
    expect(calls).toBe(1);
    expect(out.payload['hint']).toContain('Check provider configuration');
    expect(out.payload['message']).toContain('Consumer key is missing.'); // upstream message, safe envelope
  });

  it('403 -> AUTHORIZATION_ERROR, no retry', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(403, wooError(403, 'woocommerce_rest_cannot_view', 'Sorry, you cannot view this resource.'));
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await call(byName.get('woocommerce_list_orders'), {});
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('AUTHORIZATION_ERROR');
    expect(out.payload['retryable']).toBe(false);
    expect(calls).toBe(1);
  });

  it('429 -> honors Retry-After, then surfaces RATE_LIMITED with wait hint', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(429, wooError(429, 'woocommerce_rest_too_many_requests', 'Too many requests.'), { 'retry-after': '0' });
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await call(byName.get('woocommerce_list_orders'), {});
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('RATE_LIMITED');
    expect(out.payload['retryable']).toBe(true);
    expect(out.payload['retryAfterMs']).toBe(0);
    expect(out.payload['attempts']).toBe(3);
    expect(calls).toBe(3);
  });

  it('500 once -> recovered by the retry pipeline, agent sees success', async () => {
    let calls = 0;
    const fixture = createFixtureFetch({ routes: woocommerceFixtureRoutes() });
    const fetchImpl: FetchLike = async (url, init) => {
      calls += 1;
      if (calls === 1) return jsonResponse(500, wooError(500, 'internal_server_error', 'Server error'));
      return fixture(url, init);
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await call(byName.get('woocommerce_get_order'), { orderId: 42 });
    expect(out.isError).toBe(false);
    expect(calls).toBe(2); // one retry was consumed transparently
  });

  it('500 exhausted -> UPSTREAM_UNAVAILABLE with attempt count', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(500, wooError(500, 'internal_server_error', 'Server error'));
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await call(byName.get('woocommerce_list_orders'), {});
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('UPSTREAM_UNAVAILABLE');
    expect(out.payload['retryable']).toBe(true);
    expect(out.payload['attempts']).toBe(3);
    expect(calls).toBe(3);
  });

  it('400 -> VALIDATION_ERROR carrying the WooCommerce envelope message, no retry', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(400, wooError(400, 'woocommerce_rest_invalid_param', 'Invalid parameter: status.'));
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await call(byName.get('woocommerce_list_orders'), {});
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('VALIDATION_ERROR');
    expect(out.payload['message']).toContain('Invalid parameter: status.');
    expect(out.payload['message']).toContain('woocommerce_rest_invalid_param');
    expect(calls).toBe(1);
  });

  it('404 -> NOT_FOUND carrying the documented envelope message, no retry', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(404, wooError(404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid order ID.'));
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await call(byName.get('woocommerce_get_order'), { orderId: 7 });
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('NOT_FOUND');
    expect(out.payload['retryable']).toBe(false);
    expect(out.payload['message']).toContain('Invalid order ID.');
    expect(calls).toBe(1);
  });

  it('schema drift (200 but wrong shape) -> UPSTREAM_RESPONSE_ERROR, raw body never echoed', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, { unexpected: 'woo-payload-marker-xyz' });
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await call(byName.get('woocommerce_get_order'), { orderId: 42 });
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('UPSTREAM_RESPONSE_ERROR');
    expect(out.payload['retryable']).toBe(false);
    expect(out.payload['attempts']).toBe(1);
    expect(JSON.stringify(out.payload)).not.toContain('woo-payload-marker-xyz');
  });

  it('malformed JSON on 200 -> UPSTREAM_RESPONSE_ERROR, single attempt', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response('<html>gateway page</html>', { status: 200 });
    };
    const { byName } = woocommerceTools({ fetchImpl });
    const out = await call(byName.get('woocommerce_list_products'), {});
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('UPSTREAM_RESPONSE_ERROR');
    expect(calls).toBe(1);
    expect(JSON.stringify(out.payload)).not.toContain('gateway page');
  });
});

