import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import {
  checkPending,
  parseControls,
  plansFromIssues,
  resolveRepository,
} from './check-pending.mjs';

const open = new Map([['F1-03', 'OPEN']]);

test('pending test with no owner fails', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.cross-user-leak', owner: '' }],
      controls: [{ id: 'cross-user-leakage', test: 'sec.other', owner: 'F1-03' }],
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

test('control with no owner fails', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.cross-user-leak', owner: 'F1-03' }],
      controls: [{ id: 'cross-user-leakage', test: 'sec.cross-user-leak', owner: '' }],
      plans: open,
    }),
  ).toEqual(['cross-user-leakage has no owner']);
});

test('control whose test has left the pending catalog still passes', () => {
  expect(
    checkPending({
      pending: [{ id: 'sec.other', owner: 'F1-03' }],
      controls: [{ id: 'cross-user-leakage', test: 'sec.cross-user-leak', owner: 'F1-03' }],
      plans: open,
    }),
  ).toEqual([]);
});

test('committed catalog passes while every owner issue is open', () => {
  const pending = JSON.parse(readFileSync('e2e/security/pending-tests.json', 'utf8'));
  const controls = parseControls(readFileSync('docs/security/controls.yaml', 'utf8'));
  const plans = new Map(pending.map((row) => [row.owner, 'OPEN']));
  expect(checkPending({ pending, controls, plans })).toEqual([]);
});

test('repository comes from GITHUB_REPOSITORY and otherwise from the local origin', () => {
  expect(
    resolveRepository(
      { GITHUB_REPOSITORY: 'acme/widgets' },
      'https://x-access-token:secret@github.com/yu-iskw/agent-works',
    ),
  ).toBe('acme/widgets');
  expect(resolveRepository({}, 'git@github.com:local/fork.git')).toBe('local/fork');
  expect(resolveRepository({ GITHUB_REPOSITORY: '   ' }, 'https://github.com/local/fork')).toBe(
    'local/fork',
  );
});

test('plan ids without a hyphen are read from issue titles', () => {
  const plans = plansFromIssues([
    { title: 'A1: IAP assertion verification', state: 'open' },
    { title: 'WF1: Local workflow engine + cancel', state: 'open' },
    { title: 'C-06: Deploy to dev behind IAP', state: 'open' },
    { title: 'F1-01: Verify IAP assertions', state: 'closed' },
    { title: 'TODO: not a plan', state: 'open' },
    { title: 'PR-99: not an issue', state: 'closed', pull_request: {} },
  ]);
  expect(plans.get('A1')).toBe('OPEN');
  expect(plans.get('WF1')).toBe('OPEN');
  expect(plans.get('C-06')).toBe('OPEN');
  expect(plans.get('F1-01')).toBe('CLOSED');
  expect(plans.get('TODO')).toBeUndefined();
  expect(plans.get('PR-99')).toBeUndefined();
});
