import type { Classification, SearchContext, SourceCitation } from '@agent-works/domain';

export type IndexedDocument = {
  readonly citation: SourceCitation;
  readonly groups: readonly string[];
  readonly classification: Classification;
  readonly source: string;
  readonly region: string;
  readonly text: string;
};

export interface SearchPort {
  search(context: SearchContext, query: string): Promise<readonly SourceCitation[]>;
}
