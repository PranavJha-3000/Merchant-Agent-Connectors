import { z } from 'zod';

/**
 * Raw Freshdesk response schemas (validation layer).
 *
 * Only VERIFIED fields from https://developers.freshdesk.com/api/ are declared;
 * unknown fields are preserved via .passthrough() and ignored during
 * normalization (schema-drift tolerance). Required for structure: `id`.
 * Everything else degrades safely (`.catch`) so a missing/null/unexpected
 * field never crashes a read — normalization maps it to null/'unknown'.
 */

export const rawTicketSchema = z
  .object({
    id: z.number(),
    subject: z.string().catch('(no subject)'),
    status: z.number().nullish().catch(null),
    priority: z.number().nullish().catch(null),
    source: z.number().nullish().catch(null),
    type: z.string().nullish().catch(null),
    requester_id: z.number().nullish().catch(null),
    responder_id: z.number().nullish().catch(null),
    group_id: z.number().nullish().catch(null),
    company_id: z.number().nullish().catch(null),
    product_id: z.number().nullish().catch(null),
    tags: z.array(z.string()).catch([]),
    created_at: z.string().nullish().catch(null),
    updated_at: z.string().nullish().catch(null),
    due_by: z.string().nullish().catch(null),
    fr_due_by: z.string().nullish().catch(null),
    description_text: z.string().nullish().catch(null),
    is_escalated: z.boolean().nullish().catch(null),
    spam: z.boolean().nullish().catch(null),
    custom_fields: z.record(z.string(), z.unknown()).nullish().catch(null),
  })
  .passthrough();
export type RawTicket = z.infer<typeof rawTicketSchema>;

export const rawTicketListSchema = z.array(rawTicketSchema);

export const rawSearchResponseSchema = z
  .object({
    total: z.number().catch(0),
    results: rawTicketSchema.array().catch([]),
  })
  .passthrough();

export const rawConversationSchema = z
  .object({
    id: z.number(),
    body: z.string().nullish().catch(null),
    body_text: z.string().nullish().catch(null),
    incoming: z.boolean().nullish().catch(null),
    private: z.boolean().nullish().catch(null),
    user_id: z.number().nullish().catch(null),
    ticket_id: z.number().nullish().catch(null),
    created_at: z.string().nullish().catch(null),
    attachments: z.array(z.unknown()).nullish().catch(null),
  })
  .passthrough();
export type RawConversation = z.infer<typeof rawConversationSchema>;

export const rawConversationListSchema = z.array(rawConversationSchema);
