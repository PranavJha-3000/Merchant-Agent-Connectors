import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { basicAuthHeader } from '../../src/core/auth.ts';
import type { FetchLike } from '../../src/core/http.ts';
import { executeToolDefinition } from '../../src/core/tools.ts';
import { createFixtureFetch } from '../../src/fixtures/transport.ts';
import { freshdeskFixtureRoutes } from '../../src/providers/freshdesk/routes.ts';
import { freshdeskTools } from '../helpers.ts';

/**
 * Security tests: prove (not just promise) that credentials and real customer
 * data cannot leak through logs, errors, tool responses, or the repository.
 */

const FIXTURE_SECRET = 'fd_fixture_key_not_a_real_secret';
const FIXTURE_SECRET_B64 = basicAuthHeader(FIXTURE_SECRET, 'X');

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

describe('fixtures are synthetic', () => {
  it('contains no real-looking customer PII or credential material', () => {
    const fixtureFiles = [
      '../../src/fixtures/freshdesk/tickets.list.json',
      '../../src/fixtures/freshdesk/ticket.101.json',
      '../../src/fixtures/freshdesk/search.json',
      '../../src/fixtures/freshdesk/conversations.101.json',
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
    expect(example).not.toContain(FIXTURE_SECRET);
    expect(example).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });
});
