import * as z from 'zod';

import { semverSchema } from './connector-cdk.js';
import { CAPABILITIES, capabilitySchema } from './teamwork.js';

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

export const marketplaceListQuerySchema = z.strictObject({
  kind: marketplaceKindSchema.optional(),
});

const generationSchema = z.number().int().positive();
const capabilitySetSchema = z
  .array(capabilitySchema)
  .min(1)
  .max(CAPABILITIES.length)
  .refine((capabilities) => new Set(capabilities).size === capabilities.length);

/**
 * Strict on purpose: the segment and the actor come from the verified assertion and the route, so a
 * body that names either is a malformed request, not an override.
 */
export const connectorActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('enable'),
    /** Omitted re-enables the stored subset; it never widens it. */
    capabilities: capabilitySetSchema.optional(),
    expectedGeneration: generationSchema,
  }),
  z.strictObject({ action: z.literal('disable'), expectedGeneration: generationSchema }),
  z.strictObject({
    action: z.literal('set_capabilities'),
    capabilities: capabilitySetSchema,
    expectedGeneration: generationSchema,
  }),
  z.strictObject({
    action: z.literal('upgrade'),
    version: semverSchema,
    expectedGeneration: generationSchema,
  }),
  /** Returns to `previous_version`; the target is stored, never supplied by the caller. */
  z.strictObject({ action: z.literal('rollback'), expectedGeneration: generationSchema }),
]);
export type ConnectorAction = z.infer<typeof connectorActionSchema>;

export const installationViewSchema = z.strictObject({
  connector: text,
  version: semverSchema,
  previousVersion: semverSchema.nullable(),
  capabilities: z.array(capabilitySchema),
  desiredState: z.enum(['enabled', 'disabled']),
  observedState: z.enum([
    'pending',
    'provisioning',
    'healthy',
    'failed',
    'disabled',
    'not_required',
  ]),
  observedDetail: z.string().nullable(),
  generation: generationSchema,
  updatedAt: z.string(),
});
export type InstallationView = z.infer<typeof installationViewSchema>;

export const connectorCapabilityViewSchema = z.strictObject({
  id: capabilitySchema,
  access: z.enum(['read', 'write']),
  tools: z.array(text),
  requiredScopes: z.array(text),
  /** The segment's static env allowlist; activation can only narrow it. */
  allowedByEnv: z.boolean(),
  /** Installed, desired enabled, and in the enabled subset. */
  enabled: z.boolean(),
});

export const marketplaceDetailSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('connector'),
    listing: marketplaceListingSchema,
    capabilities: z.array(connectorCapabilityViewSchema),
    installation: installationViewSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('team_bot'),
    listing: marketplaceListingSchema,
    role: text,
    capabilityRequests: z.array(capabilitySchema),
  }),
  z.strictObject({
    kind: z.enum(['mcp_server', 'a2a_agent']),
    listing: marketplaceListingSchema,
  }),
]);
export type MarketplaceDetail = z.infer<typeof marketplaceDetailSchema>;
