import { readFileSync } from 'node:fs';
import type { FixtureRoute } from '../../fixtures/transport.ts';

/**
 * Default fixture routes for Freshdesk (fixture mode).
 * Synthetic data only; behavior mirrors verified API semantics:
 * bare-array list with Link rel="next", 404 for unknown ids,
 * {total, results} search envelope, 30-day-ish deterministic dataset.
 */

function loadFixture<T>(name: string): T {
  const url = new URL(`../../fixtures/freshdesk/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

type TicketRecord = { id: number };

export function freshdeskFixtureRoutes(): FixtureRoute[] {
  const list = loadFixture<TicketRecord[]>('tickets.list.json');
  const ticket101 = loadFixture<unknown>('ticket.101.json');
  const search = loadFixture<unknown>('search.json');
  const conversations = loadFixture<unknown>('conversations.101.json');
  const notFound = { status: 404, json: { description: 'Resource not found' } } as const;

  return [
    {
      // GET /api/v2/search/tickets?query=...
      match: (u) => u.pathname.endsWith('/search/tickets'),
      respond: (u) => {
        const query = u.searchParams.get('query') ?? '';
        // Deterministic fixture corpus: only "status:2" matches (ticket 101 is Open).
        if (query.includes('status:2')) return { status: 200, json: search };
        return { status: 200, json: { total: 0, results: [] } };
      },
    },
    {
      // GET /api/v2/tickets/{id}/conversations
      match: (u) => /\/tickets\/\d+\/conversations$/.test(u.pathname),
      respond: (u) => (u.pathname.endsWith('/tickets/101/conversations') ? { status: 200, json: conversations } : notFound),
    },
    {
      // GET /api/v2/tickets/{id}
      match: (u) => /\/tickets\/\d+$/.test(u.pathname),
      respond: (u) => (u.pathname.endsWith('/tickets/101') ? { status: 200, json: ticket101 } : notFound),
    },
    {
      // GET /api/v2/tickets (list)
      match: (u) => u.pathname.endsWith('/tickets'),
      respond: (u) => {
        const page = u.searchParams.get('page') ?? '1';
        const email = u.searchParams.get('email') ?? undefined;
        if (page === '2') return { status: 200, json: [] };
        if (email !== undefined && email !== 'mia.torres@example.test') return { status: 200, json: [] };
        if (email !== undefined) {
          const first = list[0];
          return first === undefined ? { status: 200, json: [] } : { status: 200, json: [first] };
        }
        return {
          status: 200,
          json: list,
          headers: { link: '<https://fixture-helpdesk.freshdesk.com/api/v2/tickets?page=2>; rel="next"' },
        };
      },
    },
  ];
}
