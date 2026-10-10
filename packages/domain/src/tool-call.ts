import * as z from 'zod';

import { authoritySchema } from './authority.js';

const label = z.string().min(1);

export const toolCallSchema = z.strictObject({
  id: label,
  taskId: label,
  stepId: label,
  toolRef: label,
  sideEffectClass: z.enum([
    'READ',
    'WRITE_LOW',
    'EXTERNAL_SEND',
    'WRITE_HIGH',
    'ADMIN',
    'CODE_EXEC',
  ]),
  idempotencyKey: label,
  authority: authoritySchema,
  policyDecisionId: label,
  approvalId: label.nullable(),
  status: label,
  externalReceipt: label.nullable(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;
