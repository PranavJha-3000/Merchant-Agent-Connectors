import type { z } from 'zod';
import { hasMoreFromTotal, parseLinkHeaderNext, type PageEnvelope } from '../../core/pagination.ts';
import { ValidationError, UpstreamResponseError } from '../../core/errors.ts';
import type { HttpClient, HttpResult } from '../../core/http.ts';
import type {
  ConversationMessage,
  ConversationReadable,
  ListTicketsParams,
  TicketDetail,
  TicketListable,
  TicketReadable,
  TicketSearchable,
  TicketSummary,
} from '../../capabilities/tickets.ts';
import { normalizeConversation, normalizeTicketDetail, normalizeTicketSummary } from './normalize.ts';
import {
  rawConversationListSchema,
  rawSearchResponseSchema,
  rawTicketListSchema,
  rawTicketSchema,
} from './types.ts';

/**
 * Freshdesk adapter: implements the ticket-domain capability interfaces.
 *
 * Owns route construction, query-parameter mapping (VERIFIED parameters only —
 * see docs/providers/freshdesk.md), raw-payload validation, and normalization.
 * Contains no MCP types and no retry/auth logic (core owns those).
 *
 * Verified endpoints (https://developers.freshdesk.com/api/):
 *   GET /api/v2/tickets                     list   (page≥1, per_page 30 default / 100 max,
 *     filter, email, updated_since, order_by, order_type; bare array + Link rel="next";
 *     default window: last 30 days)
 *   GET /api/v2/tickets/[id]                view
 *   GET /api/v2/search/tickets?query=...    search (query wrapped in ", ≤512 chars,
 *     page 1–10, fixed 30/page; response {total, results})
 *   GET /api/v2/tickets/[id]/conversations  thread (page/per_page; bare array)
 */

export const FRESHDESK_SEARCH_PAGE_SIZE = 30;
export const FRESHDESK_MAX_SEARCH_PAGE = 10;
export const FRESHDESK_MAX_QUERY_LENGTH = 512;

export class FreshdeskAdapter implements TicketListable, TicketReadable, TicketSearchable, ConversationReadable {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async listTickets(params: ListTicketsParams): Promise<PageEnvelope<TicketSummary>> {
    const res = await this.http.get({
      path: '/tickets',
      operation: 'freshdesk.listTickets',
      query: {
        page: params.page,
        per_page: params.perPage,
        filter: params.filter,
        email: params.requesterEmail,
        updated_since: params.updatedSince,
        order_by: params.orderBy,
        order_type: params.orderType,
      },
    });
    const raw = this.parse(res, rawTicketListSchema, 'freshdesk.listTickets');
    return {
      items: raw.map(normalizeTicketSummary),
      page: params.page,
      perPage: params.perPage,
      hasMore: parseLinkHeaderNext(res.headers.get('link')) !== null,
      total: null, // Freshdesk list does not report a total (verified)
    };
  }

  async getTicket(ticketId: number): Promise<TicketDetail> {
    const res = await this.http.get({ path: `/tickets/${ticketId}`, operation: 'freshdesk.getTicket' });
    const raw = this.parse(res, rawTicketSchema, 'freshdesk.getTicket');
    return normalizeTicketDetail(raw);
  }

  async searchTickets(query: string, page: number): Promise<PageEnvelope<TicketSummary>> {
    const trimmed = query.trim();
    const wrapped = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed : `"${trimmed}"`;
    if (wrapped.length > FRESHDESK_MAX_QUERY_LENGTH) {
      throw new ValidationError({
        provider: 'freshdesk',
        operation: 'freshdesk.searchTickets',
        message: `Search query exceeds Freshdesk's ${FRESHDESK_MAX_QUERY_LENGTH}-character limit (including quotes)`,
        hint: 'Shorten the query — combine conditions with AND/OR instead of listing many values.',
      });
    }
    const res = await this.http.get({
      path: '/search/tickets',
      operation: 'freshdesk.searchTickets',
      query: { query: wrapped, page },
    });
    const parsed = this.parse(res, rawSearchResponseSchema, 'freshdesk.searchTickets');
    return {
      items: parsed.results.map(normalizeTicketSummary),
      page,
      perPage: FRESHDESK_SEARCH_PAGE_SIZE,
      hasMore:
        hasMoreFromTotal(parsed.total, page, FRESHDESK_SEARCH_PAGE_SIZE) && page < FRESHDESK_MAX_SEARCH_PAGE,
      total: parsed.total,
    };
  }

  async listTicketConversations(ticketId: number, page: number, perPage: number): Promise<PageEnvelope<ConversationMessage>> {
    const res = await this.http.get({
      path: `/tickets/${ticketId}/conversations`,
      operation: 'freshdesk.listTicketConversations',
      query: { page, per_page: perPage },
    });
    const raw = this.parse(res, rawConversationListSchema, 'freshdesk.listTicketConversations');
    return {
      items: raw.map((c) => normalizeConversation(c, ticketId)),
      page,
      perPage,
      hasMore: parseLinkHeaderNext(res.headers.get('link')) !== null,
      total: null,
    };
  }

  /** Validate payload shape; drift → UpstreamResponseError (never a crash, raw body never leaked). */
  private parse<T>(res: HttpResult, schema: z.ZodType<T>, operation: string): T {
    const result = schema.safeParse(res.json);
    if (!result.success) {
      const paths = result.error.issues
        .slice(0, 3)
        .map((i) => i.path.join('.') || '(root)')
        .join(', ');
      throw new UpstreamResponseError({
        provider: 'freshdesk',
        operation,
        correlationId: res.correlationId,
        status: res.status,
        attempts: res.attempts,
        message: `Freshdesk returned an unexpected payload shape for ${operation}${paths ? ` at ${paths}` : ''} (not retried)`,
        hint: 'The response no longer matches the documented schema. Do not retry; report with the correlationId.',
      });
    }
    return result.data;
  }
}
