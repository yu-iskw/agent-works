import { Fragment, h } from '../html.js';

import type { Html } from '../html.js';
import type { SourceCitation } from '@agent-works/domain';

type CitationDetail = {
  readonly term: string;
  readonly value: Html | string;
};

export default function CitationList({
  citations,
}: {
  readonly citations: readonly SourceCitation[];
}): Html {
  return (
    <ol aria-label="Citations">
      {citations.map((citation) => (
        <li>
          <a href={citation.sourceUri}>{citation.title}</a>
          <dl>
            {citationDetails(citation).map((detail) => (
              <>
                <dt>{detail.term}</dt>
                <dd>{detail.value}</dd>
              </>
            ))}
          </dl>
        </li>
      ))}
    </ol>
  );
}

function citationDetails(citation: SourceCitation): readonly CitationDetail[] {
  return [
    {
      term: 'Retrieved',
      value: <time datetime={citation.retrievedAt}>{citation.retrievedAt}</time>,
    },
    { term: 'Source data', value: citation.excerpt },
    { term: 'Source', value: citation.sourceObjectId },
    { term: 'Etag', value: citation.etag },
    { term: 'Access decision', value: citation.accessDecisionId },
  ];
}
