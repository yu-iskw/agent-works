import { citationSchema } from '@agent-works/domain/ask';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SourceList } from './source-list';

import type { Citation } from '@agent-works/domain';

const citations = [
  citationSchema.parse({
    sourceObjectId: 'retention-policy',
    title: 'Retention policy',
    sourceUri: 'https://docs.example.com/retention',
    retrievedAt: '2026-03-14T15:04:00.000Z',
    excerpt: 'Keep audit records for seven years.',
  }),
  citationSchema.parse({
    sourceObjectId: 'ask-runbook',
    title: 'Ask runbook',
    sourceUri: 'https://docs.example.com/ask',
    retrievedAt: '2026-01-02T08:30:00.000Z',
    excerpt: 'Questions are written to the audit log.',
  }),
];

const unparsed: Citation = {
  sourceObjectId: 'hidden-object-id',
  title: 'Loose note',
  sourceUri: 'not a url',
  retrievedAt: '2026-04-01T00:00:00.000Z',
  excerpt: 'Unparsed location.',
};

describe('SourceList', () => {
  it('lists the title, the host, the source link, the retrieval time, and the excerpt', () => {
    const html = renderToStaticMarkup(<SourceList citations={citations} />);

    expect(html).toContain('aria-label="Sources"');
    expect(html).toContain('href="https://docs.example.com/retention"');
    expect(html).toContain('href="https://docs.example.com/ask"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('docs.example.com');
    expect(html).toContain('dateTime="2026-03-14T15:04:00.000Z"');
    expect(html).toContain('dateTime="2026-01-02T08:30:00.000Z"');
    expect(html).toContain('Keep audit records for seven years.');
    expect(html).toContain('Questions are written to the audit log.');
    expect(html).not.toContain('etag');
    expect(html).not.toContain('accessDecisionId');
    expect(html).not.toContain('retention-policy');
    expect(html).not.toContain('ask-runbook');
  });

  it('falls back to the raw source string when the host cannot be parsed', () => {
    const html = renderToStaticMarkup(<SourceList citations={[unparsed]} />);

    expect(html).toContain('not a url');
    expect(html).toContain('Loose note');
    expect(html).not.toContain('hidden-object-id');
  });
});
