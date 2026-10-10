import { describe, expect, it } from 'vitest';

import { searchContextSchema, sourceCitationSchema } from './search.js';

const context = {
  userSubject: 'alice',
  enterpriseId: 'ent',
  authorizedGroups: ['eng'],
  groupsObservedAt: '2026-10-10T10:00:00.000Z',
  allowedSources: ['drive'],
  taskPurpose: 'ask',
  classificationCeiling: 'INTERNAL' as const,
  allowedRegions: ['us'],
  resultCountLimit: 3,
};

const citation = {
  sourceObjectId: 'alice-runbook',
  title: 'Triage runbook',
  sourceUri: 'https://drive.fake.test/d/alice-runbook',
  etag: 'v1',
  retrievedAt: '2026-10-10T10:00:00.000Z',
  accessDecisionId: 'decision-1',
  excerpt: 'Follow the triage steps.',
};

describe('search contracts', () => {
  it('parses a search context and a source citation', () => {
    expect(searchContextSchema.parse(context)).toEqual(context);
    expect(sourceCitationSchema.parse(citation)).toEqual(citation);
  });

  it('rejects a trusted user id on the search context', () => {
    expect(searchContextSchema.safeParse({ ...context, userId: 'alice' }).success).toBe(false);
  });
});
