import type { IndexedDocument, SearchHit, SearchPort } from '../search-port.js';
import type { Classification, SearchContext } from '@agent-works/domain';

function rank(classification: Classification): number {
  switch (classification) {
    case 'PUBLIC':
      return 0;
    case 'INTERNAL':
      return 1;
    case 'CONFIDENTIAL':
      return 2;
    case 'RESTRICTED':
      return 3;
    default: {
      const exhaustive: never = classification;
      return exhaustive;
    }
  }
}

function visible(context: SearchContext, document: IndexedDocument, query: string): boolean {
  const group = document.groups.some((name) => context.authorizedGroups.includes(name));
  return (
    group &&
    context.allowedSources.includes(document.source) &&
    context.allowedRegions.includes(document.region) &&
    rank(document.classification) <= rank(context.classificationCeiling) &&
    document.text.includes(query)
  );
}

export function createMemorySearchPort(documents: readonly IndexedDocument[]): SearchPort {
  return {
    search(context, query) {
      const hits: SearchHit[] = [];
      for (const document of documents) {
        if (!visible(context, document, query)) continue;
        hits.push({ ...document.citation, text: document.text });
        if (hits.length === context.resultCountLimit) break;
      }
      return Promise.resolve(hits);
    },
  };
}
