import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/core/http.ts';
import type { ToolDefinition } from '../../../src/core/tools.ts';
import { executeToolDefinition } from '../../../src/core/tools.ts';
import { createFixtureFetch } from '../../../src/fixtures/transport.ts';
import { freshdeskFixtureRoutes } from '../../../src/providers/freshdesk/routes.ts';
import { freshdeskTools } from '../../helpers.ts';

async function call(tool: ToolDefinition | undefined, args: unknown): Promise<{ isError: boolean; payload: Record<string, any> }> {
  const result = await executeToolDefinition(tool!, args);
  if (result.isError) return { isError: true, payload: JSON.parse(result.content[0]!.text) as Record<string, any> };
  return { isError: false, payload: result.structuredContent as Record<string, any> };
}

const jsonResponse = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });

describe('Freshdesk failure behavior (normalized for agents)', () => {
  it('401 → AUTHENTICATION_ERROR, single attempt, stop', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(401, { description: 'Authentication failed' });
    };
    const { byName } = freshdeskTools({ fetchImpl });
    const out = await call(byName.get('freshdesk_get_ticket'), { ticketId: 101 });
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('AUTHENTICATION_ERROR');
    expect(out.payload['retryable']).toBe(false);
    expect(out.payload['attempts']).toBe(1);
    expect(calls).toBe(1);
    expect(out.payload['hint']).toContain('Check provider configuration');
  });

  it('429 → honors Retry-After, then surfaces RATE_LIMITED with wait hint', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(429, { description: 'Rate limit exhausted' }, { 'retry-after': '0' });
    };
    const { byName } = freshdeskTools({ fetchImpl });
    const out = await call(byName.get('freshdesk_list_tickets'), {});
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('RATE_LIMITED');
    expect(out.payload['retryable']).toBe(true);
    expect(out.payload['retryAfterMs']).toBe(0);
    expect(out.payload['attempts']).toBe(3);
    expect(calls).toBe(3);
  });

  it('500 once → recovered by the retry pipeline, agent sees success', async () => {
    let calls = 0;
    const fixture = createFixtureFetch({ routes: freshdeskFixtureRoutes() });
    const fetchImpl: FetchLike = async (url, init) => {
      calls += 1;
      if (calls === 1) return jsonResponse(500, { description: 'intermittent' });
      return fixture(url, init);
    };
    const { byName } = freshdeskTools({ fetchImpl });
    const out = await call(byName.get('freshdesk_get_ticket'), { ticketId: 101 });
    expect(out.isError).toBe(false);
    expect(calls).toBe(2); // one retry was consumed transparently
  });

  it('422 → VALIDATION_ERROR with Freshdesk field detail, no retry', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(422, {
        description: 'Validation failed',
        errors: [{ field: 'per_page', message: 'Invalid value', code: 'invalid_value' }],
      });
    };
    const { byName } = freshdeskTools({ fetchImpl });
    const out = await call(byName.get('freshdesk_list_tickets'), {});
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('VALIDATION_ERROR');
    expect(out.payload['message']).toContain('Validation failed');
    expect(out.payload['message']).toContain('per_page: Invalid value');
    expect(calls).toBe(1);
  });

  it('schema drift (200 but wrong shape) → UPSTREAM_RESPONSE_ERROR, raw body never echoed', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, { unexpected: 'payload-marker-xyz' });
    };
    const { byName } = freshdeskTools({ fetchImpl });
    const out = await call(byName.get('freshdesk_get_ticket'), { ticketId: 101 });
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('UPSTREAM_RESPONSE_ERROR');
    expect(out.payload['retryable']).toBe(false);
    expect(out.payload['attempts']).toBe(1);
    expect(JSON.stringify(out.payload)).not.toContain('payload-marker-xyz');
  });

  it('malformed JSON on 200 → UPSTREAM_RESPONSE_ERROR, single attempt', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response('<html>gateway page</html>', { status: 200 });
    };
    const { byName } = freshdeskTools({ fetchImpl });
    const out = await call(byName.get('freshdesk_list_tickets'), {});
    expect(out.isError).toBe(true);
    expect(out.payload['code']).toBe('UPSTREAM_RESPONSE_ERROR');
    expect(calls).toBe(1);
    expect(JSON.stringify(out.payload)).not.toContain('gateway page');
  });
});
