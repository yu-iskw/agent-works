import { safeWorkbenchUrl } from '@agent-works/domain/workbench';
import { describe, expect, it } from 'vitest';

import { csrfValid } from './csrf.js';
import { noticeText } from './handler.js';
import { TaskLive, reportMarkdown } from './task-views.js';

import type { WorkbenchTaskDetail } from '@agent-works/domain/workbench';
import type { IncomingMessage } from 'node:http';

const token = 'a'.repeat(64);
const origins = ['http://localhost:8180'];

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('workbench csrf', () => {
  it('accepts a matching token from a trusted origin', () => {
    const form = new URLSearchParams({ csrf: token });
    expect(
      csrfValid(
        request({ cookie: `aw_wb_csrf=${token}`, origin: origins[0] ?? '' }),
        form,
        origins,
      ),
    ).toBe(true);
  });

  it.each([
    ['missing cookie', { origin: 'http://localhost:8180' }, token],
    [
      'mismatched token',
      { cookie: `aw_wb_csrf=${token}`, origin: 'http://localhost:8180' },
      'b'.repeat(64),
    ],
    ['foreign origin', { cookie: `aw_wb_csrf=${token}`, origin: 'https://evil.example' }, token],
    ['no origin or referer', { cookie: `aw_wb_csrf=${token}` }, token],
  ])('rejects %s', (_name, headers, posted) => {
    expect(csrfValid(request(headers), new URLSearchParams({ csrf: posted }), origins)).toBe(false);
  });

  it('falls back to the referer origin', () => {
    const headers = { cookie: `aw_wb_csrf=${token}`, referer: 'http://localhost:8180/tasks/x' };
    expect(csrfValid(request(headers), new URLSearchParams({ csrf: token }), origins)).toBe(true);
  });
});

describe('workbench links', () => {
  it.each([
    ['javascript:alert(1)', null],
    ['data:text/html,x', null],
    ['http://example.com/', null],
    ['https://user:pw@example.com/', null],
    ['/fixtures/drive/../../admin', null],
    ['/fixtures/drive/inc-1', '/fixtures/drive/inc-1'],
    ['https://docs.google.com/x', 'https://docs.google.com/x'],
  ])('%s -> %s', (url, expected) => {
    expect(safeWorkbenchUrl(url)).toBe(expected);
  });
});

const hostile = '<img src=x onerror="alert(1)">';

const detail: WorkbenchTaskDetail = {
  apiVersion: 'workbench.v1',
  task: {
    id: '00000000-0000-4000-8000-000000000001',
    title: hostile,
    objective: `${hostile}<script>alert(2)</script>`,
    status: 'waiting_approval',
    version: 3,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    llmMode: 'vertex',
    modelId: 'gemini-3.8-flash',
    errorCode: null,
    errorMessage: null,
  },
  events: [],
  evidence: [
    {
      id: 'E1',
      ordinal: 1,
      sourceId: 's',
      title: hostile,
      excerpt: 'x',
      url: 'javascript:alert(3)',
      modifiedAt: '2026-10-29T00:00:00.000Z',
      retrievedAt: '2026-10-29T00:00:00.000Z',
      provenance: 'Simulated Drive (fixture)',
    },
  ],
  artifact: {
    report: {
      title: hostile,
      summary: '**bold** [x](javascript:alert(4))',
      recurringCauses: [{ cause: hostile, explanation: 'e', evidenceIds: ['E1'] }],
      incidents: [],
      recommendations: [],
      gaps: [],
    },
    model: {
      mode: 'vertex',
      modelId: 'gemini-3.8-flash',
      modelVersion: 'gemini-3.8-flash',
      responseId: 'r',
      latencyMs: 10,
      promptTokens: null,
      outputTokens: null,
      at: '2026-10-29T00:00:00.000Z',
    },
    droppedCitations: 0,
    createdAt: '2026-10-29T00:00:00.000Z',
  },
  approval: null,
  action: null,
};

describe('workbench rendering', () => {
  it('escapes model, source and user text and never emits unsafe links', () => {
    const html = TaskLive(detail, token).html;
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/(href|src|action)="\s*javascript:/i);
    expect(html).toContain('[x](javascript:alert(4))');
    expect(html).toContain('&lt;img src=x onerror="alert(1)"&gt;');
    expect(html).toContain('Link unavailable: unsafe URL removed');
  });

  it('exports the backend record as Markdown with labelled provenance', () => {
    const markdown = reportMarkdown(detail);
    expect(markdown).toContain('Draft, not published');
    expect(markdown).toContain('- E1: ');
    expect(markdown).toContain('Simulated Drive (fixture)');
  });
});

describe('workbench notices', () => {
  it('explains every conflict the API can return', () => {
    expect(noticeText('cannot_cancel_cancel_requested')).toBe(
      'This task cannot cancel while it is cancel requested. The page shows its current state.',
    );
    expect(noticeText('client_request_reused')).toContain('Your text is kept below');
    expect(noticeText('approval_tampered')).toContain('integrity');
    expect(noticeText('something_new')).toBe('That request was not valid.');
  });
});
