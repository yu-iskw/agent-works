import * as z from 'zod';

import { taskStatusSchema } from './task.js';

const label = z.string().min(1);

export const workflowSignalSchema = z.strictObject({
  taskId: label,
  signalId: label,
  kind: z.enum(['resume', 'cancel']),
});

export const workflowCheckpointSchema = z.strictObject({
  taskId: label,
  stepId: label,
  status: taskStatusSchema,
});

export type WorkflowSignal = z.infer<typeof workflowSignalSchema>;
export type WorkflowCheckpoint = z.infer<typeof workflowCheckpointSchema>;
