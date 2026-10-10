import * as z from 'zod';

import { sha256DigestSchema } from './canonical-hash.js';

const label = z.string().min(1);

export const approvalSchema = z
  .strictObject({
    id: label,
    taskId: label,
    stepId: label,
    tool: label,
    targetResource: label,
    payloadSha256: sha256DigestSchema,
    requestedBySub: label,
    approverSub: label.nullable(),
    state: label,
    expiresAt: z.iso.datetime(),
    maxExecutions: z.number().int().min(1),
    executionsUsed: z.number().int().min(0),
  })
  .refine((approval) => approval.executionsUsed <= approval.maxExecutions, {
    path: ['executionsUsed'],
  });

export type Approval = z.infer<typeof approvalSchema>;
