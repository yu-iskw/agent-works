import * as z from 'zod';

import { canonicalPayloadSha256 } from './canonical-hash.js';

export const suspensionScopes = [
  'global',
  'team',
  'user',
  'agent',
  'skill',
  'model',
  'tool',
] as const;
const label = z.string().trim().min(1).max(256);
export const suspensionTargetSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('global'), id: z.literal('*'), version: z.null() }),
  z.strictObject({ scope: z.literal('team'), id: label, version: z.null() }),
  z.strictObject({ scope: z.literal('user'), id: label, version: z.null() }),
  z.strictObject({ scope: z.literal('agent'), id: label, version: label.nullable() }),
  z.strictObject({ scope: z.literal('skill'), id: label, version: label.nullable() }),
  z.strictObject({ scope: z.literal('model'), id: label, version: z.null() }),
  z.strictObject({ scope: z.literal('tool'), id: label, version: label.nullable() }),
]);
export const suspensionCommandSchema = z
  .strictObject({
    commandId: z.uuid(),
    action: z.enum(['suspend', 'resume']),
    target: suspensionTargetSchema,
    reason: z.string().trim().min(1).max(2000),
    expiresAt: z.iso.datetime().nullable(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .refine((command) => command.action === 'suspend' || command.expiresAt === null, {
    message: 'resume cannot expire',
  });
export const suspensionSchema = z.strictObject({
  target: suspensionTargetSchema,
  suspended: z.boolean(),
  reason: z.string().min(1).max(2000),
  actorSub: z.string().min(1).max(256),
  expiresAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  commandId: z.uuid(),
});
export type SuspensionTarget = z.infer<typeof suspensionTargetSchema>;
export type SuspensionCommand = z.infer<typeof suspensionCommandSchema>;
export type Suspension = z.infer<typeof suspensionSchema>;

export function suspensionHash(value: Suspension): string {
  return canonicalPayloadSha256(suspensionSchema.parse(value));
}
export function suspensionKey(target: SuspensionTarget): string {
  const parsed = suspensionTargetSchema.parse(target);
  return canonicalPayloadSha256(parsed);
}
export function suspensionActive(value: Suspension, at: Date): boolean {
  return (
    value.suspended && (value.expiresAt === null || Date.parse(value.expiresAt) > at.getTime())
  );
}
