import type { Citation } from '@agent-works/domain';

const retrievedFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function SourceList({ citations }: { readonly citations: readonly Citation[] }) {
  return (
    <ol aria-label="Sources" className="mt-3 flex list-none flex-col gap-2 p-0">
      {citations.map((citation, index) => (
        <li
          key={`${citation.sourceObjectId}-${index}`}
          className="rounded-lg bg-muted/40 px-3 py-2"
        >
          <a
            href={citation.sourceUri}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium hover:underline"
          >
            {citation.title}
          </a>
          <p className="text-xs text-muted-foreground">
            {sourceHost(citation.sourceUri)}{' '}
            <time dateTime={citation.retrievedAt}>
              {retrievedFormat.format(new Date(citation.retrievedAt))}
            </time>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{citation.excerpt}</p>
        </li>
      ))}
    </ol>
  );
}

function sourceHost(sourceUri: string): string {
  try {
    return new URL(sourceUri).host;
  } catch {
    return sourceUri;
  }
}
