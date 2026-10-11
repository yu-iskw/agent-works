import { CLASSIFICATIONS } from '@agent-works/domain';

import type { Caller } from '../auth/iap.js';
import type { IndexedDocument, SearchPort } from '../ports/search-port.js';
import type { Classification, SearchContext, SourceCitation } from '@agent-works/domain';

export const DRIVE_SOURCE = 'drive';
export const DRIVE_REGION = 'us';
export const PUBLIC_FOLDER = 'public';
export const NEVER_OBSERVED = '1970-01-01T00:00:00.000Z';

export type GroupSnapshot = {
  readonly groups: readonly string[];
  readonly observedAt: string;
};

export type RetrievalPolicy = Omit<
  SearchContext,
  'userSubject' | 'authorizedGroups' | 'groupsObservedAt'
>;

export const askPolicy: RetrievalPolicy = {
  enterpriseId: 'agent-works',
  allowedSources: [DRIVE_SOURCE],
  taskPurpose: 'ask',
  classificationCeiling: 'INTERNAL',
  allowedRegions: [DRIVE_REGION],
  resultCountLimit: 3,
};

export class ContextMismatch extends Error {
  constructor() {
    super('search context belongs to another caller');
    this.name = 'ContextMismatch';
  }
}

export function contextFor(
  caller: Caller,
  snapshot: GroupSnapshot,
  policy: RetrievalPolicy,
): SearchContext {
  return {
    ...policy,
    allowedSources: [...policy.allowedSources],
    allowedRegions: [...policy.allowedRegions],
    userSubject: caller.sub,
    authorizedGroups: [...snapshot.groups],
    groupsObservedAt: snapshot.observedAt,
  };
}

function level(classification: Classification): number {
  return CLASSIFICATIONS.indexOf(classification);
}

export function readable(
  context: SearchContext,
  documents: readonly IndexedDocument[],
): readonly IndexedDocument[] {
  const groups = new Set(context.authorizedGroups);
  const sources = new Set(context.allowedSources);
  const regions = new Set(context.allowedRegions);
  const ceiling = level(context.classificationCeiling);
  const held = (document: IndexedDocument, group: string): boolean =>
    groups.has(group) ||
    (document.source === DRIVE_SOURCE &&
      (group === PUBLIC_FOLDER || group === context.userSubject));
  return documents.filter(
    (document) =>
      document.groups.some((group) => held(document, group)) &&
      sources.has(document.source) &&
      regions.has(document.region) &&
      level(document.classification) <= ceiling,
  );
}

export function select(
  context: SearchContext,
  documents: readonly IndexedDocument[],
  query: string,
): readonly SourceCitation[] {
  const hits: SourceCitation[] = [];
  for (const document of readable(context, documents)) {
    if (!document.text.includes(query)) continue;
    hits.push(document.citation);
    if (hits.length === context.resultCountLimit) break;
  }
  return hits;
}

export function createCorpusPort(documents: readonly IndexedDocument[]): SearchPort {
  return { search: (context, query) => Promise.resolve(select(context, documents, query)) };
}

export function boundTo(subject: string, port: SearchPort): SearchPort {
  return {
    search(context, query) {
      if (context.userSubject !== subject) return Promise.reject(new ContextMismatch());
      return port.search(context, query);
    },
  };
}

const minTokenLength = 5;

export function rankByOverlap(
  question: string,
  documents: readonly IndexedDocument[],
  limit: number,
): readonly IndexedDocument[] {
  const questionTokens = tokens(question);
  return documents
    .map((document, index) => ({
      document,
      index,
      score: overlap(questionTokens, tokens(`${document.citation.title} ${document.text}`)),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((item) => item.document);
}

function tokens(value: string): Set<string> {
  const set = new Set<string>();
  for (const match of value.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const token = match[0];
    if (token.length >= minTokenLength) set.add(token);
  }
  return set;
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let score = 0;
  for (const token of left) {
    if (right.has(token)) score += 1;
  }
  return score;
}
