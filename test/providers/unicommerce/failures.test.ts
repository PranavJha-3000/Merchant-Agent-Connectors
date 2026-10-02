import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../../src/core/errors.ts';
import type { FetchLike } from '../../../src/core/http.ts';
import { createMemoryLogger } from '../../../src/core/logger.ts';
import type { ToolDefinition } from '../../../src/core/tools.ts';
import { executeToolDefinition } from '../../../src/core/tools.ts';
import { buildConnectorTools } from '../../../src/mcp/server.ts';
import { unicommerceModule } from '../../../src/providers/unicommerce/manifest.ts';
import { unicommerceTools } from '../../helpers.ts';

/**
 * Unicommerce failure tests.
 *
 * The distinctive case is Unicommerce's DOCUMENTED application-error channel: a
 * rejected request still arrives as HTTP 200 with `successful: false` and a
 * populated `errors[]` (codes catalogued at /docs/response-codes.html). These
 * tests prove such a response can never be mistaken for an empty result, plus the
 * HTTP-level paths (5xx retry, 429) and the 401 -> refresh -> replay cycle.
 */

/** Documented envelope with `successful: false` and a catalogued error code. */
function appError(code: number, message: string): Record<string, unknown> {
  return {
    successful: false,
    message,
    errors: [{ code, fieldName: 'code', description: message, message }],
    warnings: [],
  };
}

/** Token exchange succeeds; every data call returns the scripted body. */
function withToken(dataResponse: () => Response): FetchLike {
  return async (url) =>
    url.includes('/oauth/token')
      ? json(200, { access_token: 'fixture-token', token_type: 'bearer', expires_in: 3600 })
      : dataResponse();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function runError(tool: ToolDefinition | undefined, args: unknown): Promise<Record<string, unknown>> {
  expect(tool, 'tool must exist').toBeDefined();
  const result = await executeToolDefinition(tool!, args);
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('Unicommerce failure behavior (normalized for agents)', () => {
  it('turns the HTTP 200 application-error channel into a non-retryable error', async () => {
    // Fixtures answer an unknown code through the documented channel.
    const { byName } = unicommerceTools();
    const error = await runError(byName.get('unicommerce_get_sale_order'), { code: 'SO-NOPE' });
    expect(error['code']).toBe('VALIDATION_ERROR');
    expect(error['retryable']).toBe(false);
    // The upstream code is preserved for lookup; the raw body is not.
    expect(String(error['message'])).toContain('code 40005');
    expect(String(error['hint'])).toContain('response-codes.html');
    expect(JSON.stringify(error)).not.toContain('fieldName');
  });

  it('never mistakes a rejected search for an empty result', async () => {
    const { byName } = unicommerceTools({
      fetchImpl: withToken(() => json(200, appError(40005, 'Invalid sale order code'))),
    });
    const error = await runError(byName.get('unicommerce_search_sale_orders'), { displayOrderCode: 'X' });
    expect(error['code']).toBe('VALIDATION_ERROR');
    expect(String(error['message'])).toContain('Invalid sale order code');
  });

  it('maps the documented INVALID_TOKEN code to AUTHENTICATION_ERROR', async () => {
    const { byName } = unicommerceTools({
      fetchImpl: withToken(() => json(200, appError(100209, 'Invalid token'))),
    });
    const error = await runError(byName.get('unicommerce_search_sale_orders'), {});
    expect(error['code']).toBe('AUTHENTICATION_ERROR');
    // The hint must state the documented 30-day refresh-token constraint.
    expect(String(error['hint'])).toContain('30 days');
  });

  it('maps documented tenant-credential codes to AUTHENTICATION_ERROR', async () => {
    const { byName } = unicommerceTools({
      fetchImpl: withToken(() => json(200, appError(100084, 'Invalid tenant'))),
    });
    const error = await runError(byName.get('unicommerce_get_sale_order'), { code: 'SO1016233' });
    expect(error['code']).toBe('AUTHENTICATION_ERROR');
    expect(String(error['hint'])).toContain('UNICOMMERCE_BASE_URL');
  });

  it('maps an undocumented application code to VALIDATION_ERROR without inventing a class', async () => {
    const { byName } = unicommerceTools({
      fetchImpl: withToken(() => json(200, appError(20010, 'Sale order is on hold'))),
    });
    const error = await runError(byName.get('unicommerce_get_sale_order'), { code: 'SO1016233' });
    expect(error['code']).toBe('VALIDATION_ERROR');
    expect(String(error['message'])).toContain('code 20010');
    expect(String(error['hint'])).toMatch(/do not retry/i);
  });
  it('recovers from a transient 5xx without the agent seeing a retry', async () => {
    let dataCalls = 0;
    const { byName } = unicommerceTools({
      fetchImpl: withToken(() => {
        dataCalls += 1;
        if (dataCalls === 1) return json(500, { message: 'Internal server error' });
        return json(200, { successful: true, message: 'Success', errors: [], warnings: [], totalRecords: 0, elements: [] });
      }),
    });
    const result = await executeToolDefinition(byName.get('unicommerce_search_sale_orders')!, {});
    expect(result.isError).toBeUndefined();
    expect(dataCalls).toBe(2);
  });

  it('reports UPSTREAM_UNAVAILABLE when the retry budget is exhausted', async () => {
    const { byName } = unicommerceTools({ fetchImpl: withToken(() => json(503, { message: 'Service unavailable' })) });
    const error = await runError(byName.get('unicommerce_search_sale_orders'), {});
    expect(error['code']).toBe('UPSTREAM_UNAVAILABLE');
    expect(error['retryable']).toBe(true);
  });

  it('maps 429 to RATE_LIMITED without claiming an undocumented budget', async () => {
    const { byName } = unicommerceTools({ fetchImpl: withToken(() => json(429, { message: 'Too many requests' })) });
    const error = await runError(byName.get('unicommerce_search_sale_orders'), {});
    expect(error['code']).toBe('RATE_LIMITED');
    expect(error['retryable']).toBe(true);
    expect(String(error['hint'])).toMatch(/does not publish rate limits/i);
  });

  it('replays once after a 401 using a freshly minted token', async () => {
    let tokenCalls = 0;
    let dataCalls = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/oauth/token')) {
        tokenCalls += 1;
        return json(200, { access_token: `token-${tokenCalls}`, token_type: 'bearer', expires_in: 3600 });
      }
      dataCalls += 1;
      if (tokenCalls === 1) return json(401, { message: 'Unauthorized' });
      return json(200, { successful: true, message: 'Success', errors: [], warnings: [], totalRecords: 0, elements: [] });
    };
    const { byName } = unicommerceTools({ fetchImpl });
    const result = await executeToolDefinition(byName.get('unicommerce_search_sale_orders')!, {});
    expect(result.isError).toBeUndefined();
    expect(tokenCalls).toBe(2); // initial + exactly one refresh
    expect(dataCalls).toBe(2); // original + one replay
  });

  it('reports schema drift as UPSTREAM_RESPONSE without leaking the body', async () => {
    const { byName } = unicommerceTools({
      fetchImpl: withToken(() =>
        json(200, { successful: true, message: 'Success', errors: [], warnings: [], elements: 'not-an-array' }),
      ),
    });
    const error = await runError(byName.get('unicommerce_search_sale_orders'), {});
    expect(error['code']).toBe('UPSTREAM_RESPONSE_ERROR');
    expect(JSON.stringify(error)).not.toContain('not-an-array');
  });

  it('the live module path fails before any network call when config is incomplete', () => {
    expect(() =>
      buildConnectorTools({ modules: [unicommerceModule], mode: 'live', logger: createMemoryLogger(), env: {} }),
    ).toThrowError(ConfigurationError);
  });
});
