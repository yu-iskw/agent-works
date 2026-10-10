import * as z from 'zod';

export const authoritySchema = z.strictObject({
  kind: z.enum(['userDelegated', 'agentOwned', 'approvedServiceWorkflow']),
  scopes: z.array(z.string().min(1)),
  resourceConstraint: z.string().min(1),
  expiresAt: z.iso.datetime(),
  auditRef: z.string().min(1),
});

export type Authority = z.infer<typeof authoritySchema>;
