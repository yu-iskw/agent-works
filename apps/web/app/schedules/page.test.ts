import { expect, test } from 'vitest';

import { schedulesPage, schedulePreviewPage } from './page.js';
import { scheduleWebRecord } from './test-fixtures.js';
test('list exposes schedule state, expiry, pinned skill, and pause action', () => {
  const row = scheduleWebRecord();
  const html = schedulesPage([row], 'a'.repeat(64));
  expect(html).toContain('Scheduled tasks');
  expect(html).toContain(row.spec.purpose);
  expect(html).toContain('incident-analysis@1.0.0');
  expect(html).toContain('Pause');
  expect(html).toContain('Preview privileges');
});
test('paused list offers resume and revoked row has no state action', () => {
  const row = scheduleWebRecord();
  expect(schedulesPage([{ ...row, state: 'paused' }], 'token')).toContain('Resume');
  expect(schedulesPage([{ ...row, state: 'revoked' }], 'token')).not.toContain('>Pause<');
  expect(schedulesPage([{ ...row, state: 'revoked' }], 'token')).not.toContain('>Resume<');
});
test('purpose and JSON content are escaped rather than executable HTML', () => {
  const row = scheduleWebRecord();
  row.spec.purpose = '<script>alert(1)</script>';
  const html = schedulesPage([row], 'token');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  const preview = schedulePreviewPage(row.spec, { allowed: true }, 'token');
  expect(preview).not.toContain('<script>');
});
test('denied preview omits save and allowed preview shows all privilege dimensions', () => {
  const row = scheduleWebRecord();
  expect(schedulePreviewPage(row.spec, { allowed: false }, 'token')).not.toContain(
    '>Create schedule<',
  );
  const html = schedulePreviewPage(row.spec, { allowed: true }, 'token');
  expect(html).toContain('Create schedule');
  for (const key of [
    'scopes',
    'sources',
    'skill',
    'classification',
    'regions',
    'budgetUsd',
    'deadlineSeconds',
  ])
    expect(html).toContain(key);
});
test('empty schedules page explains how to create', () => {
  expect(schedulesPage([], 'token')).toContain('No schedules yet.');
  expect(schedulesPage([], 'token')).toContain('trusted local registry');
});
