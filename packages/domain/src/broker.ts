import * as z from 'zod';

import { sha256DigestSchema } from './canonical-hash.js';
import { CLASSIFICATIONS } from './search.js';
import { lifecycleSchema } from './skill.js';

const label = z.string().min(1);

const decideFields = {
  decision: z.enum(['approve', 'reject']),
  expectedPayloadSha256: sha256DigestSchema,
};

const decidedFields = {
  id: label,
  state: z.enum(['approved', 'rejected']),
  executionsUsed: z.number().int().min(0),
};

export const approvalDecideSchema = z.strictObject(decideFields);
export const approvalDecidedSchema = z.strictObject(decidedFields);

const detailFields = {
  id: label,
  actionSummary: label,
  requestedBySub: label,
  payloadSha256: sha256DigestSchema,
  state: label,
  expiresAt: z.iso.datetime(),
};

export const approvalApiSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('detail'), ...detailFields }),
  z.strictObject({ kind: z.literal('decide'), ...decideFields }),
  z.strictObject({ kind: z.literal('decided'), ...decidedFields }),
]);

export type ApprovalDecide = z.infer<typeof approvalDecideSchema>;
export type ApprovalDecided = z.infer<typeof approvalDecidedSchema>;
export type ApprovalApi = z.infer<typeof approvalApiSchema>;

export const brokerReceiptSchema = z.strictObject({
  toolCallId: label,
  idempotencyKey: label,
  externalReceipt: label,
});

export type BrokerReceipt = z.infer<typeof brokerReceiptSchema>;

export const toolManifestSchema = z.strictObject({
  apiVersion: z.literal('internal.agents/v1'),
  kind: z.literal('ToolDefinition'),
  metadata: z.strictObject({
    name: label,
    version: label,
    owner: label,
  }),
  spec: z.strictObject({
    description: label,
    executor: label,
    inputSchemaRef: label,
    sideEffect: z.enum(['READ', 'WRITE_LOW', 'EXTERNAL_SEND', 'WRITE_HIGH', 'ADMIN', 'CODE_EXEC']),
    dataClassificationMax: z.enum(CLASSIFICATIONS),
    lifecycle: lifecycleSchema,
    permissions: z.strictObject({
      workloadCapability: label,
      userAuthority: z.enum(['delegated', 'approvedService']),
      resourceConstraint: label,
    }),
    approval: z.strictObject({
      required: z.boolean(),
      policy: label,
    }),
    execution: z.strictObject({
      timeoutSeconds: z.number().int().positive(),
      retries: z.number().int().nonnegative(),
      idempotency: z.literal('required'),
    }),
    evidence: z.strictObject({
      logRequestDigest: z.boolean(),
      logExternalObjectId: z.boolean(),
      redactFields: z.array(label),
    }),
  }),
});

export type ToolManifest = z.infer<typeof toolManifestSchema>;

export const ticketCreateManifest = {
  apiVersion: 'internal.agents/v1',
  kind: 'ToolDefinition',
  metadata: {
    name: 'ticket.create',
    version: '1.0.0',
    owner: 'platform-integrations',
  },
  spec: {
    description: 'Create one ticket in the fake tracker',
    executor: 'fake://ticket/create',
    inputSchemaRef: 'schemas/ticket-create.json',
    sideEffect: 'WRITE_LOW',
    dataClassificationMax: 'INTERNAL',
    lifecycle: 'PUBLISHED',
    permissions: {
      workloadCapability: 'ticket.create',
      userAuthority: 'delegated',
      resourceConstraint: 'project in approved_projects',
    },
    approval: {
      required: true,
      policy: 'ticket-write-v1',
    },
    execution: {
      timeoutSeconds: 30,
      retries: 0,
      idempotency: 'required',
    },
    evidence: {
      logRequestDigest: true,
      logExternalObjectId: true,
      redactFields: ['summary', 'description'],
    },
  },
} as const satisfies ToolManifest;
