import { describe, expect, it } from 'vitest';
import { normalizeConversation, normalizeTicketDetail, normalizeTicketSummary } from '../../../src/providers/freshdesk/normalize.ts';
import { rawConversationSchema, rawTicketSchema } from '../../../src/providers/freshdesk/types.ts';

/** Enum codes verified at https://developers.freshdesk.com/api/ (Ticket Properties). */
describe('normalizeTicketSummary', () => {
  it('maps known status/priority/source codes to labels', () => {
    const raw = rawTicketSchema.parse({
      id: 1,
      subject: 's',
      status: 2,
      priority: 4,
      source: 7,
      tags: ['a'],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
    const out = normalizeTicketSummary(raw);
    expect(out.status).toEqual({ code: 2, label: 'Open' });
    expect(out.priority).toEqual({ code: 4, label: 'Urgent' });
    expect(out.source).toEqual({ code: 7, label: 'Chat' });
    expect(out.provider).toBe('freshdesk');
    expect(out.id).toBe(1);
  });

  it('degrades unknown codes (custom statuses) safely instead of crashing', () => {
    const raw = rawTicketSchema.parse({ id: 2, subject: 'custom', status: 9, priority: 42, source: 99 });
    const out = normalizeTicketSummary(raw);
    expect(out.status).toEqual({ code: 9, label: 'unknown' });
    expect(out.priority).toEqual({ code: 42, label: 'unknown' });
    expect(out.source).toEqual({ code: 99, label: 'unknown' });
  });

  it('normalizes missing/null fields to null without throwing', () => {
    const raw = rawTicketSchema.parse({ id: 3, subject: 'bare', status: null, priority: null });
    const out = normalizeTicketSummary(raw);
    expect(out.status).toBeNull();
    expect(out.responderId).toBeNull();
    expect(out.tags).toEqual([]);
    expect(out.createdAt).toBeNull();
  });

  it('tolerates unexpected null subject via catch', () => {
    const raw = rawTicketSchema.parse({ id: 4, subject: null });
    expect(normalizeTicketSummary(raw).subject).toBe('(no subject)');
  });
});

describe('normalizeTicketDetail', () => {
  it('keeps description, dates, and allowlisted custom fields', () => {
    const raw = rawTicketSchema.parse({
      id: 10,
      subject: 's',
      status: 5,
      description_text: 'details',
      due_by: '2026-01-05T00:00:00Z',
      fr_due_by: '2026-01-03T00:00:00Z',
      custom_fields: { cf_x: 1 },
    });
    const out = normalizeTicketDetail(raw);
    expect(out.descriptionText).toBe('details');
    expect(out.dueBy).toBe('2026-01-05T00:00:00Z');
    expect(out.firstResponseDueBy).toBe('2026-01-03T00:00:00Z');
    expect(out.status).toEqual({ code: 5, label: 'Closed' });
    expect(out.customFields).toEqual({ cf_x: 1 });
  });
});

describe('normalizeConversation', () => {
  it('preserves private/incoming semantics for agent safety', () => {
    const raw = rawConversationSchema.parse({
      id: 501,
      body_text: 'hello',
      body: '<div>hello</div>',
      incoming: false,
      private: true,
      user_id: 7,
      created_at: '2026-01-01T10:00:00Z',
      attachments: [{}],
    });
    const out = normalizeConversation(raw, 101);
    expect(out.isPrivate).toBe(true);
    expect(out.isIncoming).toBe(false);
    expect(out.ticketId).toBe(101);
    expect(out.authorId).toBe(7);
    expect(out.bodyText).toBe('hello');
    expect(out.attachmentCount).toBe(1);
  });

  it('falls back to the requested ticketId when upstream omits it', () => {
    const raw = rawConversationSchema.parse({ id: 502 });
    expect(normalizeConversation(raw, 101).ticketId).toBe(101);
  });
});
