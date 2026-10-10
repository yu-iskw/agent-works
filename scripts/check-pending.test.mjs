import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import { PLAN_ISSUES, checkPending, parseControls } from './check-pending.mjs';

test('pending test with no owner fails', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.cross-user-leak', owner: '' }],
      controls: [{ id: 'cross-user-leakage', test: 'sec.cross-user-leak' }],
      openPlans: new Set(['F1-03']),
    }),
  ).toEqual(['sec.cross-user-leak has no owner']);
});

test('pending test whose owner issue is closed fails', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.cross-user-leak', owner: 'F1-03' }],
      controls: [{ id: 'cross-user-leakage', test: 'sec.cross-user-leak' }],
      openPlans: new Set(),
    }),
  ).toEqual(['sec.cross-user-leak owner F1-03 is merged']);
});

test('control with no test id fails', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.cross-user-leak', owner: 'F1-03' }],
      controls: [{ id: 'cross-user-leakage', test: '' }],
      openPlans: new Set(['F1-03']),
    }),
  ).toEqual(['cross-user-leakage has no test id']);
});

test('committed catalog passes while every owner issue is open', () => {
  const pending = JSON.parse(readFileSync('e2e/security/pending-tests.json', 'utf8'));
  const controls = parseControls(readFileSync('docs/security/controls.yaml', 'utf8'));
  const openPlans = new Set(Object.keys(PLAN_ISSUES));
  expect(checkPending({ pending, controls, openPlans })).toEqual([]);
});
