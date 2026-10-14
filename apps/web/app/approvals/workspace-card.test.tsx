import { describe, expect, it } from 'vitest';

import { WorkspaceApprovalCard } from './workspace-card.js';
const digest = 'a'.repeat(64);
describe('workspace approval payload diff', () => {
  it('renders exact document destination, title, body and digest', () => {
    const view = WorkspaceApprovalCard({
      payload: {
        tool: 'docs.createDraft',
        title: 'Brief',
        destinationId: 'authorized-folder',
        body: 'Exact content',
      },
      payloadSha256: digest,
    });
    expect(view.html).toContain('authorized-folder');
    expect(view.html).toContain('Exact content');
    expect(view.html).toContain(digest);
    expect(view.html).toContain('Workspace payload changes');
  });
  it('shows before and after values without hiding edits', () => {
    const payload = {
      tool: 'docs.createDraft' as const,
      title: 'New',
      destinationId: 'folder',
      body: 'After',
    };
    const view = WorkspaceApprovalCard({
      payload,
      previous: { ...payload, title: 'Old', body: 'Before' },
      payloadSha256: digest,
    });
    expect(view.html).toContain('Old');
    expect(view.html).toContain('New');
    expect(view.html).toContain('Before');
    expect(view.html).toContain('After');
  });
  it('renders event times, attendees and disabled notification statement', () => {
    const view = WorkspaceApprovalCard({
      payload: {
        tool: 'calendar.createEvent',
        calendarId: 'primary',
        summary: 'Review',
        description: 'Agenda',
        start: '2026-10-15T10:00:00Z',
        end: '2026-10-15T11:00:00Z',
        attendees: ['alice@example.test'],
      },
      payloadSha256: digest,
    });
    expect(view.html).toContain('alice@example.test');
    expect(view.html).toContain('2026-10-15T10:00:00Z');
    expect(view.html).toContain('notifications are disabled');
  });
  it('escapes hostile markup in all payload fields', () => {
    const view = WorkspaceApprovalCard({
      payload: {
        tool: 'docs.createDraft',
        title: '<script>alert(1)</script>',
        destinationId: 'folder',
        body: '<img src=x onerror=alert(1)>',
      },
      payloadSha256: digest,
    });
    expect(view.html).not.toContain('<script>');
    expect(view.html).not.toContain('<img');
    expect(view.html).toContain('&lt;script&gt;');
  });
  it('identifies Gmail output as a draft and displays recipients', () => {
    const view = WorkspaceApprovalCard({
      payload: {
        tool: 'gmail.createDraft',
        subject: 'Review',
        to: ['alice@example.test'],
        body: 'Draft',
      },
      payloadSha256: digest,
    });
    expect(view.html).toContain('Create this draft.');
    expect(view.html).toContain('alice@example.test');
  });
});
