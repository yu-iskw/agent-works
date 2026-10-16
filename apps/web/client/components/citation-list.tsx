import type { Citation } from '@agent-works/domain';

const retrievedFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function CitationList({ citations }: { readonly citations: readonly Citation[] }) {
  return (
    <ol aria-label="Citations" className="mt-3 list-decimal space-y-4 pl-5 text-sm">
      {citations.map((citation) => (
        <li key={citation.sourceObjectId}>
          <a href={citation.sourceUri} target="_blank" rel="noreferrer" className="underline">
            {citation.title}
          </a>
          <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Retrieved</dt>
            <dd>
              <time dateTime={citation.retrievedAt}>
                {retrievedFormat.format(new Date(citation.retrievedAt))}
              </time>
            </dd>
            <dt className="text-muted-foreground">Source data</dt>
            <dd>{citation.excerpt}</dd>
          </dl>
        </li>
      ))}
    </ol>
  );
}
