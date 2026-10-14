import { expect, test } from 'vitest';

import { adminPage, confirmationPage } from './page.js';
import { commandId, stopForm } from './test-helpers.js';

test('admin page renders accessible forms, lifecycle and operator gate', () => {
  const page = adminPage({ suspensions: [], versions: [], events: [], csrfToken: 'a'.repeat(64) });
  expect(page).toContain('Suspension control plane');
  expect(page).toContain('Operator drill has not run');
  expect(page).toContain('Review suspension');
  expect(page).toContain('Review version change');
  expect(page).toContain('action="/admin/confirm"');
  expect(page).not.toContain('action="/admin/apply"');
  expect(page).toContain('scope="col"');
});
test('user supplied targets and audit reasons are escaped', () => {
  const page = adminPage({
    suspensions: [
      {
        target: { scope: 'user', id: '<script>evil</script>', version: null },
        suspended: true,
        reason: '<img onerror="evil">',
        actorSub: 'admin',
        expiresAt: null,
        revision: 1,
        commandId,
        occurredAt: '2026-10-14T10:00:00.000Z',
      },
    ],
    versions: [],
    events: [
      {
        eventType: 'admin.suspend',
        actorSub: '<admin>',
        reason: '<script>evil</script>',
        occurredAt: '2026-10-14T10:00:00.000Z',
        digest: 'a'.repeat(64),
      },
    ],
    csrfToken: 'a'.repeat(64),
  });
  expect(page).not.toContain('<script>');
  expect(page).not.toContain('<img');
  expect(page).toContain('&lt;script&gt;');
  expect(page).toContain('Review resume');
});
test('confirmation shows exact change and keeps CSRF out of displayed details', () => {
  const form = stopForm('a'.repeat(64));
  const page = confirmationPage(form);
  expect(page).toContain('Confirm admin change');
  expect(page).toContain('Local stop');
  expect(page).toContain('action="/admin/apply"');
  expect(page).toContain('name="confirmed" value="yes"');
  expect(page).not.toContain('<dt>csrfToken</dt>');
  expect(page).toContain('Completed side effects are never replayed');
});
