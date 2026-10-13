import * as z from 'zod';

import { sha256DigestSchema } from './canonical-hash.js';
import { taskSubmitSchema } from './ledger.js';
import { policyDecisionSchema } from './policy.js';
import { principalSchema } from './principal.js';
import { searchContextSchema } from './search.js';

const instant = z.iso.datetime();

export const fencingTokenSchema = z.number().int().positive().brand<'FencingToken'>();

export type FencingToken = z.infer<typeof fencingTokenSchema>;

export function fencingToken(value: number): FencingToken {
  const parsed = fencingTokenSchema.safeParse(value);
  if (!parsed.success) throw new RangeError('fencing token');
  return parsed.data;
}

export const deliveryPayloadSchema = z.strictObject({
  subject: z.string().min(1),
  policy: policyDecisionSchema,
  agent: principalSchema,
  request: taskSubmitSchema,
  context: searchContextSchema,
  deadline: instant,
});

export type DeliveryPayload = z.infer<typeof deliveryPayloadSchema>;

export function deliveryPayload(value: unknown): DeliveryPayload {
  return deliveryPayloadSchema.parse(value);
}

export const externalWriteReceiptSchema = z.strictObject({
  ref: z.string().min(1),
  digestSha256: sha256DigestSchema,
});

export type ExternalWriteReceipt = z.infer<typeof externalWriteReceiptSchema>;

export function externalWriteReceipt(value: unknown): ExternalWriteReceipt {
  return externalWriteReceiptSchema.parse(value);
}

export type LeaseProof = {
  readonly taskId: string;
  readonly workerId: string;
  readonly fencingToken: FencingToken;
};

export type ClaimedDelivery = LeaseProof & {
  readonly leaseUntil: string;
  readonly attempt: number;
  readonly payload: DeliveryPayload;
};
