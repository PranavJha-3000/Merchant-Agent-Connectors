import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from '../../src/core/auth.ts';
import type { FetchLike } from '../../src/core/http.ts';
import { executeToolDefinition } from '../../src/core/tools.ts';
import { createFixtureFetch } from '../../src/fixtures/transport.ts';
import { freshdeskFixtureRoutes } from '../../src/providers/freshdesk/routes.ts';
import { woocommerceFixtureRoutes } from '../../src/providers/woocommerce/routes.ts';
import { freshdeskTools, woocommerceTools, zohoTools } from '../helpers.ts';

/**
 * Security tests: prove (not just promise) that credentials and real customer
 * data cannot leak through logs, errors, tool responses, or the repository.
 */

const FIXTURE_SECRET = 'fd_fixture_key_not_a_real_secret';
const FIXTURE_SECRET_B64 = basicAuthHeader(FIXTURE_SECRET, 'X');
const WOO_FIXTURE_KEY = 'ck_fixture_not_a_real_key';
const WOO_FIXTURE_SECRET = 'cs_fixture_not_a_real_secret';
const WOO_FIXTURE_SECRET_B64 = basicAuthHeader(WOO_FIXTURE_KEY, WOO_FIXTURE_SECRET).replace('Basic ', '');

function assertNoSecrets(serialized: string): void {
  expect(serialized).not.toContain(FIXTURE_SECRET);
  expect(serialized).not.toContain(FIXTURE_SECRET_B64.replace('Basic ', ''));
}

describe('secrets never reach logs', () => {
  it('covers success, retry, and failure flows', async () => {
    // Failure flows: 401 (immediate), 429 (with retries), malformed payload.
    const scenarios: FetchLike[] = [
      async () => new Response(JSON.stringify([{ id: 1, subject: 'ok', status: 2 }]), { status: 200 }),
      async () => new Response(JSON.stringify({ description: 'Authentication failed' }), { status: 401 }),
      async () =>
        new Response(JSON.stringify({ description: 'Rate limit exhausted' }), {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
      async () => new Response('<html>not json</html>', { status: 200 }),
    ];

    for (const fetchImpl of scenarios) {
      const { byName, logger } = freshdeskTools({ fetchImpl });
      await executeToolDefinition(byName.get('freshdesk_list_tickets')!, {});
      await executeToolDefinition(byName.get('freshdesk_get_ticket')!, { ticketId: 101 });
      const serialized = JSON.stringify(logger.entries);
      assertNoSecrets(serialized);
      expect(serialized).not.toContain('Basic ');
      expect(serialized).not.toContain('"authorization"');
    }
  });

  it('tool error payloads never contain credentials', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ description: 'bad key' }), { status: 401 });
    const { byName } = freshdeskTools({ fetchImpl });
    const result = await executeToolDefinition(byName.get('freshdesk_list_tickets')!, {});
    expect(result.isError).toBe(true);
    assertNoSecrets(JSON.stringify(result));
  });
});

describe('Zoho Inventory secrets never reach logs, errors, output or URLs', () => {
  // Fixture OAuth values (see providers/zoho/config.ts FIXTURE_ZOHO_CONFIG).
  const CLIENT_ID = '1000.fixtureclientid';
  const CLIENT_SECRET = 'fixture_client_secret_not_a_real_value';
  const REFRESH_TOKEN = '1000.fixturerefreshtoken.not-a-real-value';
  const ACCESS_TOKEN = '1000.fixture_access_token_not_a_real_token';

  function assertNoZohoSecrets(serialized: string): void {
    expect(serialized).not.toContain(CLIENT_ID);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain('Zoho-oauthtoken');
  }

  it('covers success, auth failure, rate limit and malformed-body flows', async () => {
    const scenarios: FetchLike[] = [
      // success against fixtures
      async (url) =>
        url.includes('/oauth/v2/token')
          ? new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }), { status: 200 })
          : new Response(
              JSON.stringify({
                code: 0,
                message: 'success',
                items: [{ item_id: '4815000000044208', name: 'Item', sku: 'X', stock_on_hand: 3 }],
                page_context: { page: 1, per_page: 200, has_more_page: false },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
      // expired/revoked token
      async () => new Response(JSON.stringify({ code: 100, message: 'Invalid OAuth token.' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
      // rate limited
      async () => new Response(JSON.stringify({ code: 45, message: 'exceeded' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      }),
      // schema drift
      async () => new Response(JSON.stringify({ code: 0, items: 'oops' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];

    for (const fetchImpl of scenarios) {
      const { byName, logger } = zohoTools({ fetchImpl });
      await executeToolDefinition(byName.get('zoho_list_items')!, {});
      const result = await executeToolDefinition(byName.get('zoho_get_item')!, { itemId: '4815000000044208' });
      assertNoZohoSecrets(JSON.stringify(result));
      assertNoZohoSecrets(JSON.stringify(logger.entries));
      expect(JSON.stringify(logger.entries)).not.toContain('"authorization"');
    }
  });

  it('never puts credentials in a request URL', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(`${init.method ?? 'GET'} ${url}`);
      if (url.includes('/oauth/v2/token')) {
        // The exchange carries client_secret/refresh_token in the BODY only.
        expect(url).not.toContain(CLIENT_SECRET);
        expect(url).not.toContain(REFRESH_TOKEN);
        return new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, message: 'success', salesorders: [], page_context: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { byName } = zohoTools({ fetchImpl });
    await executeToolDefinition(byName.get('zoho_list_sales_orders')!, {});
    expect(urls.length).toBeGreaterThanOrEqual(2);
    assertNoZohoSecrets(urls.join('\n'));
  });

  it('reports a dead grant without echoing the token response', async () => {
    const deadGrant: FetchLike = async (url) => {
      if (url.includes('/oauth/v2/token')) {
        // Zoho returns an `error` member on OAuth failures.
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 200 });
      }
      throw new Error('must not be reached');
    };
    const { byName } = zohoTools({ fetchImpl: deadGrant });
    const result = await executeToolDefinition(byName.get('zoho_list_items')!, {});
    expect(result.isError).toBe(true);
    assertNoZohoSecrets(JSON.stringify(result));
    expect(JSON.stringify(result)).toContain('AUTHENTICATION_ERROR');
  });
});

describe('WooCommerce secrets never reach logs', () => {
  function assertNoWooSecrets(serialized: string): void {
    expect(serialized).not.toContain(WOO_FIXTURE_KEY);
    expect(serialized).not.toContain(WOO_FIXTURE_SECRET);
    expect(serialized).not.toContain(WOO_FIXTURE_SECRET_B64);
  }

  it('covers success, retry, and failure flows', async () => {
    const scenarios: FetchLike[] = [
      async () => new Response(JSON.stringify([{ id: 42, status: 'processing' }]), { status: 200 }),
      async () =>
        new Response(JSON.stringify({ code: 'woocommerce_rest_invalid_consumer_key', message: 'Consumer key is missing.', data: { status: 401 } }), {
          status: 401,
        }),
      async () =>
        new Response(JSON.stringify({ code: 'rate_limit', message: 'Too many requests.', data: { status: 429 } }), {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
      async () => new Response('<html>not json</html>', { status: 200 }),
    ];

    for (const fetchImpl of scenarios) {
      const { byName, logger } = woocommerceTools({ fetchImpl });
      await executeToolDefinition(byName.get('woocommerce_list_orders')!, {});
      await executeToolDefinition(byName.get('woocommerce_get_order')!, { orderId: 42 });
      const serialized = JSON.stringify(logger.entries);
      assertNoWooSecrets(serialized);
      expect(serialized).not.toContain('Basic ');
      expect(serialized).not.toContain('"authorization"');
    }
  });

  it('tool error payloads never contain credentials', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ code: 'woocommerce_rest_invalid_consumer_key', message: 'bad key', data: { status: 401 } }), { status: 401 });
    const { byName } = woocommerceTools({ fetchImpl });
    const result = await executeToolDefinition(byName.get('woocommerce_list_orders')!, {});
    expect(result.isError).toBe(true);
    assertNoWooSecrets(JSON.stringify(result));
  });

  it('fixture fetch requests only carry the auth header (no credentials in URLs)', async () => {
    // WooCommerce also documents query-string credentials as a fallback; the
    // connector deliberately never uses them, so no key can end up in a URL.
    const urls: string[] = [];
    const inner = createFixtureFetch({
      routes: woocommerceFixtureRoutes(),
      onRequest: (u) => urls.push(u.toString()),
    });
    const { byName } = woocommerceTools({ fetchImpl: inner });
    await executeToolDefinition(byName.get('woocommerce_list_orders')!, {});
    await executeToolDefinition(byName.get('woocommerce_get_order')!, { orderId: 42 });
    for (const url of urls) {
      expect(url).not.toContain('consumer_key');
      expect(url).not.toContain('consumer_secret');
      expect(url).not.toContain(WOO_FIXTURE_KEY);
      expect(url).not.toContain(WOO_FIXTURE_SECRET);
    }
  });
});

describe('fixtures are synthetic', () => {
  it('contains no real-looking customer PII or credential material', () => {
    const fixtureFiles = [
      '../../src/fixtures/freshdesk/tickets.list.json',
      '../../src/fixtures/freshdesk/ticket.101.json',
      '../../src/fixtures/freshdesk/search.json',
      '../../src/fixtures/freshdesk/conversations.101.json',
      '../../src/fixtures/woocommerce/orders.list.json',
      '../../src/fixtures/woocommerce/order.42.json',
      '../../src/fixtures/woocommerce/products.list.json',
      '../../src/fixtures/woocommerce/product.17.json',
    ];
    for (const rel of fixtureFiles) {
      const content = readFileSync(new URL(rel, import.meta.url), 'utf8');
      // All emails must use reserved .test/.example domains.
      const emails = content.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      for (const email of emails) {
        expect(email, `non-synthetic email in ${rel}: ${email}`).toMatch(/\.(test|example|example\.test)$/);
      }
      // No JWTs / long secrets.
      expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
      expect(content).not.toContain(FIXTURE_SECRET);
    }
  });
});

describe('repository hygiene', () => {
  it('.gitignore covers .env and .env is absent from the repo', () => {
    const gitignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^\.env\.\*$/m);
    expect(existsSync(new URL('../../.env', import.meta.url))).toBe(false);
  });

  it('.env.example exists and contains no real-looking values', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    expect(example).toContain('FRESHDESK_API_KEY');
    expect(example).toContain('WOOCOMMERCE_CONSUMER_SECRET');
    expect(example).not.toContain(FIXTURE_SECRET);
    expect(example).not.toContain(WOO_FIXTURE_SECRET);
    expect(example).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });
});
