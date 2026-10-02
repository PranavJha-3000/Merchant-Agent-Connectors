import type { FetchLike } from '../core/http.ts';

/**
 * Deterministic fixture transport.
 *
 * Routes raw fetch calls to canned upstream responses so the entire pipeline —
 * auth headers, retries, Retry-After, validation, normalization, MCP output —
 * runs unmodified without credentials or network. All fixture data is
 * synthetic (AGENTS.md §9): fictional names, *.test domains, fake keys.
 */

export interface FixtureReply {
  status: number;
  /** JSON body (serialized). Omit + use rawText for non-JSON bodies. */
  json?: unknown;
  rawText?: string;
  headers?: Record<string, string>;
}

export interface FixtureRoute {
  match: (url: URL) => boolean;
  /** callIndex is 0 for the first call to this route, 1 for the second, … */
  respond: (url: URL, callIndex: number) => FixtureReply;
}

export interface FixtureFetchOptions {
  routes: FixtureRoute[];
  /** Observability hook (tests assert call order/URLs). */
  onRequest?: (url: URL) => void;
}

export function createFixtureFetch(options: FixtureFetchOptions): FetchLike {
  const counters = new Map<FixtureRoute, number>();
  return async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    options.onRequest?.(url);
    for (const route of options.routes) {
      if (!route.match(url)) continue;
      const callIndex = counters.get(route) ?? 0;
      counters.set(route, callIndex + 1);
      const reply = route.respond(url, callIndex);
      const body = reply.rawText ?? (reply.json !== undefined ? JSON.stringify(reply.json) : null);
      return new Response(body, { status: reply.status, headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) } });
    }
    // Fail loudly: an unmatched call means a test/demo requested an un-fixture'd path.
    throw new Error(`fixture transport: no route matched ${url.pathname}${url.search}`);
  };
}
