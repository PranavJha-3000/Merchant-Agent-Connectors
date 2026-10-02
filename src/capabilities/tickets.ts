import { z } from 'zod';
import type { PageEnvelope } from '../core/pagination.ts';

/**
 * Ticket domain: normalized models + capability interfaces.
 *
 * Normalization happens WITHIN this domain only. Freshdesk tickets do not get
 * merged with WooCommerce orders or Zoho items into a fake universal model.
 * Unknown provider enum values degrade to label 'unknown' — never a crash
 * (Freshdesk supports custom statuses beyond 2–5).
 *
 * Field sources: https://developers.freshdesk.com/api/ (Ticket Properties,
 * Conversations) — verified 2026-10-02. Nullable = upstream sends null;
 * optional = upstream may omit the field entirely.
 */

export const enumValueSchema = z.object({
  code: z.union([z.number(), z.string()]),
  label: z.string(),
});
export type EnumValue = z.infer<typeof enumValueSchema>;

export const ticketSummarySchema = z.object({
  /** Provider id that produced this record. */
  provider: z.string(),
  /** Provider-native ID (kept with its native type for direct follow-up calls). */
  id: z.number(),
  subject: z.string(),
  status: enumValueSchema.nullable(),
  priority: enumValueSchema.nullable(),
  source: enumValueSchema.nullable(),
  type: z.string().nullable(),
  requesterId: z.number().nullable(),
  responderId: z.number().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

export const ticketDetailSchema = ticketSummarySchema.extend({
  descriptionText: z.string().nullable(),
  companyId: z.number().nullable(),
  groupId: z.number().nullable(),
  productId: z.number().nullable(),
  dueBy: z.string().nullable(),
  firstResponseDueBy: z.string().nullable(),
  isEscalated: z.boolean().nullable(),
  isSpam: z.boolean().nullable(),
  /** Allowlisted passthrough of provider custom fields (keys are schema-side, values are merchant data). */
  customFields: z.record(z.string(), z.unknown()).nullable(),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

export const conversationMessageSchema = z.object({
  provider: z.string(),
  id: z.number(),
  ticketId: z.number(),
  /** true = internal/private note. Agents must never quote these to a customer. */
  isPrivate: z.boolean().nullable(),
  /** true = message came from the requester (customer), false = agent/system. */
  isIncoming: z.boolean().nullable(),
  authorId: z.number().nullable(),
  bodyText: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  createdAt: z.string().nullable(),
  attachmentCount: z.number(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export interface ListTicketsParams {
  page: number;
  perPage: number;
  filter?: 'new_and_my_open' | 'watching' | 'spam' | 'deleted';
  requesterEmail?: string;
  updatedSince?: string;
  orderBy?: 'created_at' | 'due_by' | 'updated_at' | 'status';
  orderType?: 'asc' | 'desc';
}

/** Capabilities a provider may implement. Tools are only registered for implemented capabilities. */
export interface TicketListable {
  listTickets(params: ListTicketsParams): Promise<PageEnvelope<TicketSummary>>;
}
export interface TicketReadable {
  getTicket(ticketId: number): Promise<TicketDetail>;
}
export interface TicketSearchable {
  searchTickets(query: string, page: number): Promise<PageEnvelope<TicketSummary>>;
}
export interface ConversationReadable {
  listTicketConversations(ticketId: number, page: number, perPage: number): Promise<PageEnvelope<ConversationMessage>>;
}
