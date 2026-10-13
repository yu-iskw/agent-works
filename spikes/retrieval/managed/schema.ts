import { z } from 'zod';

const documentSchema = z.object({
  id: z.string().min(1),
  structData: z.object({
    title: z.string(),
    content: z.string(),
    sourceUri: z.string(),
    version: z.string(),
    retrievedAt: z.iso.datetime(),
    accessDecisionId: z.string(),
    sourceAccessChecked: z.boolean(),
  }),
  derivedStructData: z.object({ snippets: z.array(z.object({ snippet: z.string() })) }),
});
/** Exact harness feature scope: document search results, snippets and answer surface.
 * These are operator-normalized connector fields, not a promise every connector emits them. */
export const managedRecordingSchema = z.strictObject({
  schemaId: z.literal('agent-works.retrieval.managed-recording'),
  schemaVersion: z.literal(1),
  provenance: z.literal('synthetic'),
  scenario: z.string().min(1),
  caseId: z.enum(['alice', 'bob', 'shared-group', 'outsider', 'revoked-member', 'source-deletion']),
  subject: z.enum(['alice', 'bob', 'reviewer', 'outsider']),
  status: z.number().int().min(100).max(599),
  response: z
    .object({
      results: z.array(z.object({ document: documentSchema })).optional(),
      answer: z.string().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
});
export type ManagedRecording = z.infer<typeof managedRecordingSchema>;
