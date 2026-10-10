import * as z from 'zod';

const instant = z.iso.datetime();
const label = z.string().min(1);

export const principalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('human'),
    sub: label,
    enterpriseId: label,
    email: label,
    groups: z.array(label),
    groupsObservedAt: instant,
  }),
  z.strictObject({
    kind: z.literal('agent'),
    agentId: label,
    version: label,
    identityRef: label,
  }),
  z.strictObject({
    kind: z.literal('serviceWorkflow'),
    workflowId: label,
    sponsorSub: label,
  }),
]);

export type Principal = z.infer<typeof principalSchema>;
