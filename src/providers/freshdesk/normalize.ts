import type { ConversationMessage, EnumValue, TicketDetail, TicketSummary } from '../../capabilities/tickets.ts';
import type { RawConversation, RawTicket } from './types.ts';

/**
 * Freshdesk → normalized domain translation (provider-owned).
 *
 * Enum codes are VERIFIED from https://developers.freshdesk.com/api/:
 *   Status   2 Open · 3 Pending · 4 Resolved · 5 Closed
 *   Priority 1 Low · 2 Medium · 3 High · 4 Urgent
 *   Source   1 Email · 2 Portal · 3 Phone · 7 Chat · 9 Feedback Widget · 10 Outbound Email
 * Freshdesk supports CUSTOM ticket statuses (codes beyond 5): unknown codes
 * degrade to label 'unknown' with the raw code preserved — never a crash.
 */

const PROVIDER = 'freshdesk';

const STATUS_LABELS: Record<number, string> = { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' };
const PRIORITY_LABELS: Record<number, string> = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const SOURCE_LABELS: Record<number, string> = {
  1: 'Email',
  2: 'Portal',
  3: 'Phone',
  7: 'Chat',
  9: 'Feedback Widget',
  10: 'Outbound Email',
};

function toEnum(code: number | null | undefined, labels: Record<number, string>): EnumValue | null {
  if (code === null || code === undefined) return null;
  return { code, label: labels[code] ?? 'unknown' };
}

export function normalizeTicketSummary(raw: RawTicket): TicketSummary {
  return {
    provider: PROVIDER,
    id: raw.id,
    subject: raw.subject,
    status: toEnum(raw.status, STATUS_LABELS),
    priority: toEnum(raw.priority, PRIORITY_LABELS),
    source: toEnum(raw.source, SOURCE_LABELS),
    type: raw.type ?? null,
    requesterId: raw.requester_id ?? null,
    responderId: raw.responder_id ?? null,
    tags: raw.tags,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

export function normalizeTicketDetail(raw: RawTicket): TicketDetail {
  return {
    ...normalizeTicketSummary(raw),
    descriptionText: raw.description_text ?? null,
    companyId: raw.company_id ?? null,
    groupId: raw.group_id ?? null,
    productId: raw.product_id ?? null,
    dueBy: raw.due_by ?? null,
    firstResponseDueBy: raw.fr_due_by ?? null,
    isEscalated: raw.is_escalated ?? null,
    isSpam: raw.spam ?? null,
    customFields: raw.custom_fields ?? null,
  };
}

export function normalizeConversation(raw: RawConversation, ticketId: number): ConversationMessage {
  return {
    provider: PROVIDER,
    id: raw.id,
    ticketId: raw.ticket_id ?? ticketId,
    isPrivate: raw.private ?? null,
    isIncoming: raw.incoming ?? null,
    authorId: raw.user_id ?? null,
    bodyText: raw.body_text ?? null,
    bodyHtml: raw.body ?? null,
    createdAt: raw.created_at ?? null,
    attachmentCount: raw.attachments?.length ?? 0,
  };
}
