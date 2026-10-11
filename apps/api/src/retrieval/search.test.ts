import { describe, expect, it } from 'vitest';

import { createMemorySearchPort } from '../ports/memory/search-port.js';
import { searchFixture, searchPortContract } from '../ports/search-port.contract.js';

import {
  ContextMismatch,
  askPolicy,
  boundTo,
  contextFor,
  createCorpusPort,
  readable,
  select,
} from './search.js';

import type { GroupSnapshot } from './search.js';
import type { Caller } from '../auth/iap.js';
import type { IndexedDocument } from '../ports/search-port.js';
import type { SearchContext } from '@agent-works/domain';

searchPortContract(() => createCorpusPort(searchFixture));

const alice = { sub: 'alice', assertion: 'a.b.c' } as Caller;
const observedAt = '2026-01-01T00:00:00.000Z';
const group = 'agent-users@company.example';

function driveDoc(id: string, folder: string, overrides: Partial<IndexedDocument> = {}) {
  return {
    citation: {
      sourceObjectId: id,
      title: id,
      sourceUri: `https://drive.fake.test/d/${id}`,
      etag: 'e',
      retrievedAt: observedAt,
      accessDecisionId: `d-${id}`,
      excerpt: id,
    },
    groups: [folder],
    classification: 'INTERNAL',
    source: 'drive',
    region: 'us',
    text: `text of ${id}`,
    ...overrides,
  } satisfies IndexedDocument;
}

function contextWith(snapshot: GroupSnapshot, patch: Partial<SearchContext> = {}): SearchContext {
  return { ...contextFor(alice, snapshot, askPolicy), ...patch };
}

describe('readable', () => {
  const docs = [
    driveDoc('open', 'public'),
    driveDoc('mine', 'alice'),
    driveDoc('theirs', 'bob'),
    driveDoc('shared', group),
    driveDoc('confidential', group, { classification: 'CONFIDENTIAL' }),
    driveDoc('mail', group, { source: 'mail' }),
    driveDoc('eu', group, { region: 'eu' }),
  ];
  const ids = (found: readonly IndexedDocument[]) => found.map((d) => d.citation.sourceObjectId);

  it('lets a caller with no groups read public and own folders only', () => {
    const context = contextWith({ groups: [], observedAt });
    expect(ids(readable(context, docs))).toEqual(['open', 'mine']);
  });

  it('adds group folders and still applies source, region, and classification', () => {
    const context = contextWith({ groups: [group], observedAt });
    expect(ids(readable(context, docs))).toEqual(['open', 'mine', 'shared']);
  });

  it('raises the ceiling and widens regions and sources when the context does', () => {
    const context = contextWith(
      { groups: [group], observedAt },
      {
        classificationCeiling: 'CONFIDENTIAL',
        allowedRegions: ['us', 'eu'],
        allowedSources: ['drive', 'mail'],
      },
    );
    expect(ids(readable(context, docs))).toEqual([
      'open',
      'mine',
      'shared',
      'confidential',
      'mail',
      'eu',
    ]);
  });

  it('does not treat public or the caller subject as a principal for other sources', () => {
    const mail = [
      driveDoc('m1', 'public', { source: 'mail' }),
      driveDoc('m2', 'alice', { source: 'mail' }),
    ];
    const context = contextWith({ groups: [], observedAt }, { allowedSources: ['mail'] });
    expect(readable(context, mail)).toEqual([]);
  });
});

describe('select', () => {
  it('stops at the limit, keeps input order, and returns the citation and full text', () => {
    const docs = [driveDoc('a', 'public'), driveDoc('b', 'public'), driveDoc('c', 'public')];
    const context = contextWith({ groups: [], observedAt }, { resultCountLimit: 2 });
    const hits = select(context, docs, 'text of');
    expect(hits).toEqual(docs.slice(0, 2).map((doc) => ({ ...doc.citation, text: doc.text })));
  });

  it('agrees with the memory SearchPort on every axis the memory port knows', async () => {
    const contexts: SearchContext[] = [
      { ...contextWith({ groups: ['eng'], observedAt }), userSubject: 'nobody' },
      { ...contextWith({ groups: ['other'], observedAt }), userSubject: 'nobody' },
      {
        ...contextWith({ groups: ['eng'], observedAt }),
        userSubject: 'nobody',
        classificationCeiling: 'RESTRICTED',
      },
      {
        ...contextWith({ groups: ['eng'], observedAt }),
        userSubject: 'nobody',
        allowedRegions: ['us', 'eu'],
      },
      {
        ...contextWith({ groups: ['eng'], observedAt }),
        userSubject: 'nobody',
        resultCountLimit: 1,
      },
    ];
    for (const context of contexts) {
      for (const query of ['triage', 'triage secret', 'eu', '']) {
        expect(select(context, searchFixture, query)).toEqual(
          await createMemorySearchPort(searchFixture).search(context, query),
        );
      }
    }
  });
});

describe('contextFor', () => {
  it('takes the subject from the caller and the groups from the snapshot', () => {
    const context = contextFor(alice, { groups: [group], observedAt }, askPolicy);
    expect(context).toEqual({
      userSubject: 'alice',
      enterpriseId: 'agent-works',
      authorizedGroups: [group],
      groupsObservedAt: observedAt,
      allowedSources: ['drive'],
      taskPurpose: 'ask',
      classificationCeiling: 'INTERNAL',
      allowedRegions: ['us'],
      resultCountLimit: 3,
    });
  });
});

describe('boundTo', () => {
  it('refuses a context minted for someone else', async () => {
    const port = boundTo('alice', createCorpusPort([driveDoc('open', 'public')]));
    const bob = { ...contextWith({ groups: [], observedAt }), userSubject: 'bob' };
    await expect(port.search(bob, 'text')).rejects.toBeInstanceOf(ContextMismatch);
  });
});
