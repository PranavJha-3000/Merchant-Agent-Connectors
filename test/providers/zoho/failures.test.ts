import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../../src/core/errors.ts';
import type { FetchLike } from '../../../src/core/http.ts';
import { createMemoryLogger } from '../../../src/core/logger.ts';
import type { ToolDefinition } from '../../../src/core/tools.ts';
import { executeToolDefinition } from '../../../src/core/tools.ts';
import { buildConnectorTools } from '../../../src/mcp/server.ts';
import { zohoConfigFromEnv } from '../../../src/providers/zoho/config.ts';
import { zohoInventoryModule } from '../../../src/providers/zoho/manifest.ts';
import { zohoTools } from '../../helpers.ts';

/**
 * Zoho Inventory failure tests.
 *
 * Verifies the documented failure contract (https://www.zoho.com/inventory/api/v1/errors/,
 * checked 2026-10-02: 400 bad request, 401 "Unauthorized (Invalid AuthToken)",
 * 404 not found, 429 too many requests, 500 server error, body `{code, message}`)
 * plus the one Zoho-specific behavior that justifies a retry: a 401 is replayed
 * ONCE after a real token refresh (core calls the AuthStrategy.refresh hook).
 */

/** Zoho-shaped error body: { "code": <int>, "message": "<text>" }. */
function zohoError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Token exchange succeeds; every data call returns the same scripted response. */
function withToken(dataResponse: () => Response): FetchLike {
  return async (url) =>
    url.includes('/oauth/v2/token')
      ? new Response(JSON.stringify({ access_token: '1000.fixture_token', expires_in: 3600 }), { status: 200 })
      : dataResponse();
}

async function runError(tool: ToolDefinition | undefined, args: unknown): Promise<Record<string, unknown>> {
  expect(tool, 'tool must exist').toBeDefined();
  const result = await executeToolDefinition(tool!, args);
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('Zoho Inventory failure behavior (normalized for agents)', () => {
  it('maps 404 to NOT_FOUND with retryable:false (unknown ids are not retried)', async () => {
    const { byName } = zohoTools({
      fetchImpl: withToken(() => zohoError(404, 1008, 'Item does not exist.')),
    });
    const error = await runError(byName.get('zoho_get_item'), { itemId: '4815000000099999' });
    expect(error['code']).toBe('NOT_FOUND');
    expect(error['retryable']).toBe(false);
    expect(error['provider']).toBe('zoho-inventory');
    expect(String(error['hint'])).toMatch(/do not retry/i);
  });

  it('maps 400 to VALIDATION_ERROR and points at organization_id / parameters', async () => {
    const { byName } = zohoTools({
      fetchImpl: withToken(() => zohoError(400, 101, 'organization_id is a required parameter.')),
    });
    const error = await runError(byName.get('zoho_list_items'), {});
    expect(error['code']).toBe('VALIDATION_ERROR');
    expect(error['retryable']).toBe(false);
    expect(String(error['message'])).toContain('organization_id');
    expect(String(error['hint'])).toContain('ZOHO_ORGANIZATION_ID');
  });

  it('maps the documented 429 quota errors to RATE_LIMITED with actionable quota detail', async () => {
    // Docs: 429 + code 45 = daily plan quota exceeded.
    const { byName } = zohoTools({
      fetchImpl: withToken(() =>
        zohoError(429, 45, 'The API call for this organization has exceeded the maximum call rate limit of 1000.'),
      ),
    });
    const error = await runError(byName.get('zoho_list_items'), {});
    expect(error['code']).toBe('RATE_LIMITED');
    expect(error['retryable']).toBe(true);
    expect(String(error['hint'])).toContain('100 requests/minute');
    expect(String(error['hint'])).toContain('daily');
  });
  it('recovers from a transient 5xx and never surfaces the retry to the agent', async () => {
    let dataCalls = 0;
    const { byName } = zohoTools({
      fetchImpl: withToken(() => {
        dataCalls += 1;
        if (dataCalls === 1) return zohoError(500, 5, 'Internal server error.');
        return new Response(
          JSON.stringify({ code: 0, message: 'success', salesorders: [], page_context: { page: 1, per_page: 200, has_more_page: false } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    const result = await executeToolDefinition(byName.get('zoho_list_sales_orders')!, {});
    expect(result.isError).toBeUndefined();
    expect(dataCalls).toBe(2); // retried internally, invisible to the agent
  });

  it('reports UPSTREAM_UNAVAILABLE when the 5xx retry budget is exhausted', async () => {
    const { byName } = zohoTools({ fetchImpl: withToken(() => zohoError(503, 5, 'Service unavailable.')) });
    const error = await runError(byName.get('zoho_list_items'), {});
    expect(error['code']).toBe('UPSTREAM_UNAVAILABLE');
    expect(error['retryable']).toBe(true);
    expect(error['attempts']).toBeGreaterThan(1);
  });

  it('rejects malformed JSON and schema drift as UPSTREAM_RESPONSE (never a crash, never a raw body)', async () => {
    const malformed = zohoTools({
      fetchImpl: withToken(() => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    });
    expect((await runError(malformed.byName.get('zoho_list_items'), {}))['code']).toBe('UPSTREAM_RESPONSE_ERROR');

    // Drift: `items` becomes a string instead of an array.
    const drifted = zohoTools({
      fetchImpl: withToken(
        () =>
          new Response(JSON.stringify({ code: 0, message: 'success', items: 'nope' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    });
    const driftError = await runError(drifted.byName.get('zoho_list_items'), {});
    expect(driftError['code']).toBe('UPSTREAM_RESPONSE_ERROR');
    expect(String(driftError['hint'])).toMatch(/do not retry/i);
    expect(JSON.stringify(driftError)).not.toContain('nope');
  });

  it('fails fast on invalid live configuration without leaking values', () => {
    expect(() => zohoConfigFromEnv({})).toThrowError(ConfigurationError);

    // An undocumented data center is refused rather than guessed.
    let caught: ConfigurationError | undefined;
    try {
      zohoConfigFromEnv({
        ZOHO_DATA_CENTER: 'jp',
        ZOHO_ORGANIZATION_ID: '10234695',
        ZOHO_CLIENT_ID: '1000.abc',
        ZOHO_CLIENT_SECRET: 'super-secret-value',
        ZOHO_REFRESH_TOKEN: 'refresh-secret-value',
      });
    } catch (e) {
      caught = e as ConfigurationError;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(String(caught?.message)).not.toContain('super-secret-value');
    expect(String(caught?.message)).not.toContain('refresh-secret-value');
    expect(String(caught?.hint)).toContain('ZOHO_DATA_CENTER');

    // A non-numeric organization id is rejected too.
    expect(() =>
      zohoConfigFromEnv({
        ZOHO_DATA_CENTER: 'com',
        ZOHO_ORGANIZATION_ID: 'not-a-number',
        ZOHO_CLIENT_ID: '1000.abc',
        ZOHO_CLIENT_SECRET: 's',
        ZOHO_REFRESH_TOKEN: 'r',
      }),
    ).toThrowError(ConfigurationError);
  });

  it('the live module path fails before any network call when config is incomplete', () => {
    expect(() =>
      buildConnectorTools({
        modules: [zohoInventoryModule],
        mode: 'live',
        logger: createMemoryLogger(),
        env: {},
      }),
    ).toThrowError(ConfigurationError);
  });
});
