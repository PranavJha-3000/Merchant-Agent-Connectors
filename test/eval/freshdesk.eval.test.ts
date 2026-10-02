import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/core/http.ts';
import { executeToolDefinition, type ToolDefinition, type ToolResultEnvelope } from '../../src/core/tools.ts';
import { createFixtureFetch } from '../../src/fixtures/transport.ts';
import { freshdeskFixtureRoutes } from '../../src/providers/freshdesk/routes.ts';
import { freshdeskTools } from '../helpers.ts';

/**
 * Agent evaluation fixtures — deterministic, LLM-free.
 *
 * Each scenario models a realistic merchant-support task expressed as:
 *   business scenario → expected tool → expected arguments → expected
 *   result class (success / empty / specific error code) → failure behavior.
 *
 * What is tested is the CONTRACT an agent depends on: tool existence,
 * argument shapes, result shapes, empty-vs-error distinction, retryable
 * signaling — not model output. See docs/evaluation.md.
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

const fixture: FetchLike = createFixtureFetch({ routes: freshdeskFixtureRoutes() });
const callCounts = { n: 0 };
const countingFixture: FetchLike = async (url, init) => {
  callCounts.n += 1;
  return fixture(url, init);
};

const tasks: EvalTask[] = [
  {
    id: 'find-unresolved-ticket',
    scenario: 'Agent must find currently-open high-priority tickets to triage',
    tool: 'freshdesk_search_tickets',
    args: { query: 'status:2 AND priority:3' },
    expect: { class: 'success', minItems: 1 },
    fetchImpl: countingFixture,
  },
  {
    id: 'retrieve-known-ticket',
    scenario: 'Agent has ticket id 101 and needs full details incl. description',
    tool: 'freshdesk_get_ticket',
    args: { ticketId: 101 },
    expect: { class: 'success' },
    fetchImpl: countingFixture,
  },
  {
    id: 'find-by-customer-email',
    scenario: 'Customer emails in; locate their tickets by requester email (list endpoint, not search)',
    tool: 'freshdesk_list_tickets',
    args: { requesterEmail: 'mia.torres@example.test' },
    expect: { class: 'success', minItems: 1 },
    fetchImpl: countingFixture,
  },
  {
    id: 'browse-recent-tickets',
    scenario: 'Agent browses the recent ticket queue page 1',
    tool: 'freshdesk_list_tickets',
    args: {},
    expect: { class: 'success', minItems: 1 },
    fetchImpl: countingFixture,
  },
  {
    id: 'read-ticket-conversation',
    scenario: 'Agent needs the reply history of ticket 101 before responding',
    tool: 'freshdesk_list_ticket_conversations',
    args: { ticketId: 101 },
    expect: { class: 'success', minItems: 3 },
    fetchImpl: countingFixture,
  },
  {
    id: 'empty-search-is-not-an-error',
    scenario: 'Search matches nothing: agent must see success with empty results, not an error',
    tool: 'freshdesk_search_tickets',
    args: { query: 'priority:9' },
    expect: { class: 'success', empty: true },
    fetchImpl: countingFixture,
  },
  {
    id: 'unknown-id-is-not-found',
    scenario: 'Ticket id does not exist: agent must get NOT_FOUND and not retry',
    tool: 'freshdesk_get_ticket',
    args: { ticketId: 999999 },
    expect: { class: 'error', errorCode: 'NOT_FOUND', retryable: false },
    fetchImpl: countingFixture,
  },
  {
    id: 'stop-after-auth-failure',
    scenario: 'Credentials rejected: agent must stop and report configuration problem',
    tool: 'freshdesk_list_tickets',
    args: {},
    expect: { class: 'error', errorCode: 'AUTHENTICATION_ERROR', retryable: false },
    fetchImpl: async () => new Response(JSON.stringify({ description: 'Authentication failed' }), { status: 401 }),
  },
  {
    id: 'respect-rate-limit',
    scenario: 'Upstream rate-limits: agent sees RATE_LIMITED, retryable:true, and a wait hint',
    tool: 'freshdesk_list_tickets',
    args: {},
    expect: { class: 'error', errorCode: 'RATE_LIMITED', retryable: true },
    fetchImpl: async () =>
      new Response(JSON.stringify({ description: 'Rate limit exhausted' }), {
        status: 429,
        headers: { 'retry-after': '0' },
      }),
  },
  {
    id: 'recover-from-transient-5xx',
    scenario: 'One transient 500: the connector retries internally; the agent just sees success',
    tool: 'freshdesk_get_ticket',
    args: { ticketId: 101 },
    expect: { class: 'success' },
    fetchImpl: (() => {
      let calls = 0;
      return async (url: string, init: RequestInit) => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ description: 'intermittent' }), { status: 500 });
        return fixture(url, init);
      };
    })(),
  },
  {
    id: 'reject-invalid-arguments-pre-network',
    scenario: 'Bad input must be rejected before any upstream call',
    tool: 'freshdesk_get_ticket',
    args: { ticketId: 0 },
    expect: { class: 'error', errorCode: 'VALIDATION_ERROR', retryable: false },
    fetchImpl: countingFixture,
    expectNoNetwork: true,
  },
];

function payloadOf(result: ToolResultEnvelope): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

describe('agent evaluation fixtures (Freshdesk)', () => {
  it('registers every task tool before evaluation', () => {
    const { byName } = freshdeskTools();
    for (const task of tasks) {
      expect(byName.has(task.tool), `missing tool for task ${task.id}`).toBe(true);
    }
  });

  for (const task of tasks) {
    it(`${task.id}: ${task.scenario}`, async () => {
      const { byName } = freshdeskTools(task.fetchImpl ? { fetchImpl: task.fetchImpl } : {});
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
        expect(payload['provider']).toBe('freshdesk');
        expect(payload['operation']).toBe(task.tool);
      }
    });
  }
});
