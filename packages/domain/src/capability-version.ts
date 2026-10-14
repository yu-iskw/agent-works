import * as z from 'zod';

import { canonicalPayloadSha256 } from './canonical-hash.js';

const label = z.string().trim().min(1).max(256);
export const capabilityPinSchema = z.strictObject({
  kind: z.enum(['agent', 'skill', 'tool']),
  id: label,
  version: label,
});
export const capabilityVersionCommandSchema = z.strictObject({
  commandId: z.uuid(),
  pin: capabilityPinSchema,
  state: z.enum(['draft', 'published', 'deprecated', 'revoked']),
  reason: z.string().trim().min(1).max(2000),
  expectedRevision: z.number().int().nonnegative(),
});
export const capabilityVersionSchema = z.strictObject({
  pin: capabilityPinSchema,
  state: capabilityVersionCommandSchema.shape.state,
  reason: z.string().min(1).max(2000),
  actorSub: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  commandId: z.uuid(),
});
export type CapabilityPin = z.infer<typeof capabilityPinSchema>;
export type CapabilityVersionCommand = z.infer<typeof capabilityVersionCommandSchema>;
export type CapabilityVersion = z.infer<typeof capabilityVersionSchema>;
export type CapabilityState = CapabilityVersion['state'];

export function capabilityKey(pin: CapabilityPin): string {
  return canonicalPayloadSha256(capabilityPinSchema.parse(pin));
}
export function capabilityVersionHash(value: CapabilityVersion): string {
  return canonicalPayloadSha256(capabilityVersionSchema.parse(value));
}
export function capabilityTransition(
  from: CapabilityState | undefined,
  to: CapabilityState,
): boolean {
  if (from === undefined) return to === 'draft';
  if (from === to) return false;
  switch (from) {
    case 'draft':
      return to === 'published' || to === 'revoked';
    case 'published':
      return to === 'deprecated' || to === 'revoked';
    case 'deprecated':
      return to === 'revoked';
    case 'revoked':
      return false;
  }
}
