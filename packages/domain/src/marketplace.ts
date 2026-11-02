import * as z from 'zod';

import { semverSchema } from './connector-cdk.js';

export const MARKETPLACE_KINDS = ['connector', 'team_bot', 'mcp_server', 'a2a_agent'] as const;
export const marketplaceKindSchema = z.enum(MARKETPLACE_KINDS);
export type MarketplaceKind = z.infer<typeof marketplaceKindSchema>;

export const MARKETPLACE_STATUSES = ['available', 'enabled', 'disabled', 'coming_soon'] as const;
export const marketplaceStatusSchema = z.enum(MARKETPLACE_STATUSES);

const text = z.string().trim().min(1).max(512);

export const marketplaceListingSchema = z.strictObject({
  kind: marketplaceKindSchema,
  id: text,
  version: semverSchema,
  name: text,
  summary: text,
  publisher: z.literal('agent-works'),
  status: marketplaceStatusSchema,
  href: z.string().startsWith('/').max(512).optional(),
});
export type MarketplaceListing = z.infer<typeof marketplaceListingSchema>;
