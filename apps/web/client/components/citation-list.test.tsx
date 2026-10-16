import { citationSchema } from '@agent-works/domain/ask';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CitationList } from './citation-list';

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

describe('CitationList', () => {
  it('lists the title, the source link, the retrieval time, and the excerpt', () => {
    const html = renderToStaticMarkup(<CitationList citations={citations} />);

    expect(html).toContain('aria-label="Citations"');
    expect(html).toContain('href="https://docs.example.com/retention"');
    expect(html).toContain('href="https://docs.example.com/ask"');
    expect(html).toContain('dateTime="2026-03-14T15:04:00.000Z"');
    expect(html).toContain('dateTime="2026-01-02T08:30:00.000Z"');
    expect(html).toContain('Keep audit records for seven years.');
    expect(html).toContain('Questions are written to the audit log.');
    expect(html).not.toContain('etag');
    expect(html).not.toContain('accessDecisionId');
    expect(html).not.toContain('retention-policy');
    expect(html).not.toContain('ask-runbook');
  });
});
