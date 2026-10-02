import { z } from 'zod';

/**
 * Value objects shared across capability domains (tickets, orders, catalog).
 *
 * Kept in one place so domain files never import from each other — an order
 * model must not depend on the ticket model. Enum values are `{code, label}`
 * so unknown provider codes degrade to label 'unknown' instead of crashing.
 */
export const enumValueSchema = z.object({
  code: z.union([z.number(), z.string()]),
  label: z.string(),
});
export type EnumValue = z.infer<typeof enumValueSchema>;