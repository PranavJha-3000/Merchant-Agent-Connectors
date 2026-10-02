import { z } from 'zod';
import type { ToolDefinition } from '../../core/tools.ts';
import {
  conversationMessageSchema,
  ticketDetailSchema,
  ticketSummarySchema,
} from '../../capabilities/tickets.ts';
import { FreshdeskAdapter } from './client.ts';

/**
 * Freshdesk MCP tool definitions - the agent-facing contract.
 *
 * Rules applied (docs/tool-spec.md):
 * - provider-prefixed semantic names, never raw paths;
 * - descriptions explicitly disambiguate sibling tools (when to use / NOT use);
 * - inputs are strictly validated BEFORE any network call;
 * - outputs are schema'd (structuredContent) and machine-predictable;
 * - errors are agent-safe normalized payloads (see core/tools.ts execute).
 *
 * Only VERIFIED Freshdesk parameters are exposed (verified 2026-10-02 against
 * https://developers.freshdesk.com/api/ - List/View/Search/Conversations,
 * Pagination, Errors sections). Anything unverified is intentionally absent.
 */

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const listInputSchema = z.object({
  page: z.number().int().min(1).default(1).describe('Page number, starts at 1.'),
  perPage: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(30)
    .describe('Results per page. Default 30, maximum 100 (Freshdesk limit).'),
  filter: z
    .enum(['new_and_my_open', 'watching', 'spam', 'deleted'])
    .optional()
    .describe('Freshdesk preset view. Omit for the default view (excludes spam/deleted).'),
  requesterEmail: z
    .email()
    .max(254)
    .optional()
    .describe('Only tickets from this requester email. Preferred over search when you know the email.'),
  updatedSince: z
    .iso.datetime({ offset: true })
    .optional()
    .describe('ISO-8601 UTC lower bound on updated_at, e.g. 2026-01-01T00:00:00Z. Needed to reach tickets older than 30 days.'),
  orderBy: z
    .enum(['created_at', 'due_by', 'updated_at', 'status'])
    .optional()
    .describe('Sort field. Default created_at.'),
  orderType: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default desc (newest first).'),
});

const searchInputSchema = z.object({
  query: z
    .string()
    .min(3)
    .max(510)
    .describe(
      "Freshdesk query language, max 512 chars WITH the surrounding double quotes (auto-added if missing). "
        + "Structured conditions only - e.g. \"status:2 AND priority:4\", \"tag:'shipping' AND created_at:>'2026-01-01'\". "
        + "NOT a free-text search.",
    ),
  page: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(1)
    .describe('Result page, 1-10 (Freshdesk search limit). Page size is fixed at 30.'),
});

const getTicketInputSchema = z.object({
  ticketId: z.number().int().min(1).describe('The numeric Freshdesk ticket id (from a list/search result or the user).'),
});

const conversationsInputSchema = z.object({
  ticketId: z.number().int().min(1).describe('The ticket id whose conversation thread to read.'),
  page: z.number().int().min(1).default(1).describe('Page number, starts at 1.'),
  perPage: z.number().int().min(1).max(100).default(30).describe('Results per page. Default 30, maximum 100.'),
});

const listOutputSchema = z.object({
  provider: z.literal('freshdesk'),
  fetchedAt: z.string().describe('RFC-3339 timestamp of when this page was fetched.'),
  page: z.number(),
  perPage: z.number(),
  hasMore: z.boolean().describe('true when another page exists - call again with page+1.'),
  total: z.number().nullable().describe('Total matches when the upstream reports one; null when unknown.'),
  items: z.array(ticketSummarySchema),
});

const getTicketOutputSchema = z.object({
  provider: z.literal('freshdesk'),
  fetchedAt: z.string(),
  ticket: ticketDetailSchema,
});

const searchOutputSchema = z.object({
  provider: z.literal('freshdesk'),
  fetchedAt: z.string(),
  query: z.string().describe('The query as sent to Freshdesk (quotes included).'),
  page: z.number(),
  perPage: z.literal(30),
  total: z.number(),
  hasMore: z.boolean(),
  items: z.array(ticketSummarySchema),
});

const conversationsOutputSchema = z.object({
  provider: z.literal('freshdesk'),
  fetchedAt: z.string(),
  ticketId: z.number(),
  page: z.number(),
  perPage: z.number(),
  hasMore: z.boolean(),
  items: z.array(conversationMessageSchema),
});

export function buildFreshdeskTools(adapter: FreshdeskAdapter): ToolDefinition[] {
  const now = (): string => new Date().toISOString();

  return [
    {
      name: 'freshdesk_list_tickets',
      provider: 'freshdesk',
      description:
        'List Freshdesk tickets with pagination and filters (read-only). '
        + 'USE WHEN: browsing recent tickets; finding tickets by requester email; using a preset view; or filtering by an updated_at window. '
        + 'DO NOT USE WHEN: you already have a ticket id (use freshdesk_get_ticket), or you need field conditions like status/priority/type/tag/date-range '
        + '(use freshdesk_search_tickets). '
        + 'By default Freshdesk only returns tickets from the last 30 days - pass updatedSince for older tickets. '
        + 'Pagination: page starts at 1, perPage max 100 (default 30); when hasMore is true, call again with page+1. '
        + 'An empty items array means no matches (success, not an error).',
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (args) => {
        const page = await adapter.listTickets(args);
        return { provider: 'freshdesk' as const, fetchedAt: now(), ...page };
      },
    },
    {
      name: 'freshdesk_get_ticket',
      provider: 'freshdesk',
      description:
        'Fetch ONE Freshdesk ticket by its numeric id, including description text and custom fields (read-only). '
        + 'USE WHEN: you already have a ticket id - from freshdesk_list_tickets, freshdesk_search_tickets, or the user. '
        + 'DO NOT USE WHEN: you only have an email, subject, keyword or status - use freshdesk_list_tickets (requester email) '
        + 'or freshdesk_search_tickets (field conditions) to locate the id first. '
        + 'An unknown id returns error code NOT_FOUND with retryable:false - do not retry the same id.',
      inputSchema: getTicketInputSchema,
      outputSchema: getTicketOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async ({ ticketId }) => {
        const ticket = await adapter.getTicket(ticketId);
        return { provider: 'freshdesk' as const, fetchedAt: now(), ticket };
      },
    },
    {
      name: 'freshdesk_search_tickets',
      provider: 'freshdesk',
      description:
        'Search Freshdesk tickets by structured ticket-field conditions using Freshdesk query language (read-only). '
        + 'USE WHEN: you need tickets matching field conditions - status, priority, type, tag, agent, group, date ranges, custom fields - and you do not have an id. '
        + 'DO NOT USE WHEN: you have a ticket id (freshdesk_get_ticket), want a plain recent listing or have a requester email (freshdesk_list_tickets). '
        + 'This is NOT free-text search: pass conditions, not sentences. Query must be double-quoted (auto-added if missing), max 512 chars; '
        + 'operators :> and :< work on dates/numbers; combine with AND/OR and parentheses; field names are case-sensitive. '
        + 'Examples: status:2 AND priority:4 - tag:\'urgent\' - created_at:>\'2026-01-01\'. '
        + 'Page size is fixed at 30, pages 1-10 (Freshdesk limit). total reports the full match count. '
        + 'Empty items with total:0 means no match (success). Freshdesk indexes changes with a few minutes of lag.',
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async ({ query, page }) => {
        const result = await adapter.searchTickets(query, page);
        return { provider: 'freshdesk' as const, fetchedAt: now(), query, ...result };
      },
    },
    {
      name: 'freshdesk_list_ticket_conversations',
      provider: 'freshdesk',
      description:
        'List the conversation thread of one Freshdesk ticket - public replies and internal notes, oldest first (read-only). '
        + 'USE WHEN: you have a ticket id and need its messages (emails, replies, notes). '
        + 'DO NOT USE WHEN: you do not have a ticket id yet - locate it first with freshdesk_list_tickets or freshdesk_search_tickets. '
        + 'isPrivate:true marks an internal agent note: read it for context but NEVER quote it to a customer. '
        + 'isIncoming:true marks a message from the requester. '
        + 'An unknown ticket id returns NOT_FOUND; a ticket with no messages returns an empty items array (success). '
        + 'Pagination: page starts at 1, perPage max 100 (default 30).',
      inputSchema: conversationsInputSchema,
      outputSchema: conversationsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async ({ ticketId, page, perPage }) => {
        const result = await adapter.listTicketConversations(ticketId, page, perPage);
        return { provider: 'freshdesk' as const, fetchedAt: now(), ticketId, ...result };
      },
    },
  ];
}

