import { describe, expect, it } from 'vitest';

import type { IndexedDocument, SearchPort } from './search-port.js';
import type { SearchContext, SourceCitation } from '@agent-works/domain';

const retrievedAt = '2026-10-10T10:00:00.000Z';

function citation(id: string, title: string): SourceCitation {
  return {
    sourceObjectId: id,
    title,
    sourceUri: `https://drive.fake.test/d/${id}`,
    etag: 'v1',
    retrievedAt,
    accessDecisionId: `decision-${id}`,
    excerpt: title,
  };
}

const runbook = citation('alice-runbook', 'Triage runbook');
const secret = citation('bob-secret', 'Bob secret');
const restricted = citation('restricted-doc', 'Restricted');

export const searchFixture: readonly IndexedDocument[] = [
  {
    citation: runbook,
    groups: ['eng'],
    classification: 'INTERNAL',
    source: 'drive',
    region: 'us',
    text: 'triage runbook',
  },
  {
    citation: secret,
    groups: ['other'],
    classification: 'INTERNAL',
    source: 'drive',
    region: 'us',
    text: 'triage secret',
  },
  {
    citation: restricted,
    groups: ['eng'],
    classification: 'RESTRICTED',
    source: 'drive',
    region: 'us',
    text: 'triage restricted',
  },
];

const context: SearchContext = {
  userSubject: 'alice',
  enterpriseId: 'ent',
  authorizedGroups: ['eng'],
  groupsObservedAt: retrievedAt,
  allowedSources: ['drive'],
  taskPurpose: 'ask',
  classificationCeiling: 'INTERNAL',
  allowedRegions: ['us'],
  resultCountLimit: 3,
};

export function searchPortContract(create: () => SearchPort): void {
  describe('SearchPort', () => {
    it('returns the caller groups under the classification ceiling', async () => {
      expect(await create().search(context, 'triage')).toEqual([runbook]);
    });

    it('returns nothing for a group the caller is not in', async () => {
      expect(
        await create().search({ ...context, authorizedGroups: ['other'] }, 'triage secret'),
      ).toEqual([secret]);
      expect(await create().search({ ...context, authorizedGroups: ['nope'] }, 'triage')).toEqual(
        [],
      );
    });

    it('stops at the context result limit', async () => {
      expect(await create().search({ ...context, resultCountLimit: 1 }, 'triage')).toEqual([
        runbook,
      ]);
    });
  });
}
