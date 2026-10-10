import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import { checkPending, parseControls } from './check-pending.mjs';

const open = new Map([['F1-03', 'OPEN']]);

test('pending test with no owner fails', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.cross-user-leak', owner: '' }],
      controls: [{ id: 'cross-user-leakage', test: 'sec.cross-user-leak' }],
      plans: open,
    }),
  ).toEqual(['sec.cross-user-leak has no owner']);
});

test('pending test whose owner issue is closed fails', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.cross-user-leak', owner: 'F1-03' }],
      controls: [{ id: 'cross-user-leakage', test: 'sec.cross-user-leak', owner: 'F1-03' }],
      plans: new Map([['F1-03', 'CLOSED']]),
    }),
  ).toEqual(['sec.cross-user-leak owner F1-03 is merged']);
});

test('control with no test id fails', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.cross-user-leak', owner: 'F1-03' }],
      controls: [{ id: 'cross-user-leakage', test: '' }],
      plans: open,
    }),
  ).toEqual(['cross-user-leakage has no test id']);
});

test('control test id missing from the pending catalog fails', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.cross-user-leak', owner: 'F1-03' }],
      controls: [{ id: 'cross-user-leakage', test: 'sec.missing', owner: 'F1-03' }],
      plans: open,
    }),
  ).toEqual(['cross-user-leakage test sec.missing is not pending']);
});

test('committed catalog passes while every owner issue is open', () => {
  const pending = JSON.parse(readFileSync('e2e/security/pending-tests.json', 'utf8'));
  const controls = parseControls(readFileSync('docs/security/controls.yaml', 'utf8'));
  const plans = new Map(pending.map((row) => [row.owner, 'OPEN']));
  expect(checkPending({ pending, controls, plans })).toEqual([]);
});
