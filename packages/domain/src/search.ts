import * as z from 'zod';

const label = z.string().min(1);
const instant = z.iso.datetime();

export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export const searchContextSchema = z.strictObject({
  userSubject: label,
  enterpriseId: label,
  authorizedGroups: z.array(label),
  groupsObservedAt: instant,
  allowedSources: z.array(label),
  taskPurpose: label,
  classificationCeiling: z.enum(CLASSIFICATIONS),
  allowedRegions: z.array(label),
  resultCountLimit: z.number().int().positive(),
});

export type SearchContext = z.infer<typeof searchContextSchema>;

export const sourceCitationSchema = z.strictObject({
  sourceObjectId: label,
  title: label,
  sourceUri: z.url().regex(/^https?:\/\//),
  etag: label,
  retrievedAt: instant,
  accessDecisionId: label,
  excerpt: label,
});

export type SourceCitation = z.infer<typeof sourceCitationSchema>;
