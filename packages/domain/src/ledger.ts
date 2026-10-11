import * as z from 'zod';

import { auditEventSchema } from './audit-event.js';
import { taskStatusSchema } from './task.js';

const label = z.string().min(1);
const instant = z.iso.datetime();

const submitFields = {
  objective: label,
  skillId: label,
  input: z.record(z.string(), z.json()).optional(),
  sourceAllowlist: z.array(label),
  requestedOutputs: z.array(label),
  executionPolicy: z.strictObject({
    mode: label,
    budgetUsd: z.number().nonnegative(),
    deadlineSeconds: z.number().int().positive(),
  }),
};

const acceptedFields = {
  taskId: label,
  status: taskStatusSchema,
  submittedAt: instant,
  statusUrl: label,
  traceId: label,
};

export const taskSubmitSchema = z.strictObject(submitFields);
export const taskAcceptedSchema = z.strictObject(acceptedFields);

export const taskApiSchema = z.xor([
  z.strictObject({ kind: z.literal('submit'), ...submitFields }),
  z.strictObject({ kind: z.literal('accepted'), ...acceptedFields }),
  z.strictObject({ error: z.literal('unknown_skill') }),
]);

export type TaskSubmit = z.infer<typeof taskSubmitSchema>;
export type TaskAccepted = z.infer<typeof taskAcceptedSchema>;
export type TaskApi = z.infer<typeof taskApiSchema>;

export const outboxEventSchema = z.strictObject({
  destination: z.enum(['audit', 'work']),
  event: auditEventSchema,
});

export type OutboxEvent = z.infer<typeof outboxEventSchema>;
