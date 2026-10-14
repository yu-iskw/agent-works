import { z } from 'zod';

export const memoryNotice =
  'Memory is optional. Only your own turns can be remembered. You can inspect, revise, export or delete memories. Opting out removes active memories; legal holds preserve sealed records until released.';
const identifier = z.string().min(1).max(256);
export const memoryScopeSchema = z
  .object({ tenant: identifier, owner: identifier, agent: identifier })
  .strict();
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
const memoryClassificationSchema = z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
const memoryOriginSchema = z
  .object({
    kind: z.literal('user-turn'),
    taskId: identifier,
    turnId: identifier,
    subject: identifier,
    sourceRef: identifier.nullable(),
  })
  .strict();
export const memoryProposalSchema = z
  .object({
    id: z.uuid(),
    text: z.string().trim().min(1).max(2048),
    classification: memoryClassificationSchema,
    ttlSeconds: z.number().int().min(60).max(31536000),
    origin: memoryOriginSchema,
  })
  .strict();
export type MemoryProposal = z.infer<typeof memoryProposalSchema>;
export const memoryItemSchema = z
  .object({
    ...memoryScopeSchema.shape,
    ...memoryProposalSchema.shape,
    classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL']),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    legalHold: z.boolean(),
    state: z.enum(['active', 'sealed']),
  })
  .strict();
export type MemoryItem = z.infer<typeof memoryItemSchema>;
export const memoryConsentSchema = z
  .object({
    tenant: identifier,
    owner: identifier,
    enabled: z.boolean(),
    revision: z.number().int().nonnegative(),
    noticeVersion: z.literal('memory-v1'),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type MemoryConsent = z.infer<typeof memoryConsentSchema>;
export const memoryConsentCommandSchema = z
  .object({
    enabled: z.boolean(),
    revision: z.number().int().nonnegative(),
    noticeVersion: z.literal('memory-v1'),
  })
  .strict();
export const memoryEditSchema = z
  .object({
    id: z.uuid(),
    agent: identifier,
    revision: z.number().int().positive(),
    text: z.string().trim().min(1).max(2048),
  })
  .strict();
export const memoryDeleteSchema = memoryEditSchema.omit({ text: true });
export const memoryListSchema = z.object({ agent: identifier }).strict();
export const memoryAuditSchema = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    tenantHash: z.string(),
    ownerHash: z.string(),
    targetHash: z.string(),
    action: z.enum([
      'consent',
      'propose',
      'revise',
      'delete',
      'opt-out',
      'expiry',
      'hold',
      'release',
      'revocation',
      'restore',
      'deletion-request',
    ]),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type MemoryAudit = z.infer<typeof memoryAuditSchema>;
export const memoryTombstoneSchema = z
  .object({
    tenantHash: z.string(),
    ownerHash: z.string(),
    idHash: z.string(),
    at: z.iso.datetime(),
    reason: z.string(),
  })
  .strict();
export type MemoryTombstone = z.infer<typeof memoryTombstoneSchema>;
