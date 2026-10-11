import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { readPendingCatalog } from '../e2e/pending/read-catalog.mjs';
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
  const pending = readPendingCatalog('e2e/pending');
  const controls = parseControls(readFileSync('docs/security/controls.yaml', 'utf8'));
  const plans = new Map(pending.map((row) => [row.owner, 'OPEN']));
  expect(checkPending({ pending, controls, plans })).toEqual([]);
});

test('repository comes from GITHUB_REPOSITORY and otherwise from the local origin', () => {
  expect(
    resolveRepository({ GITHUB_REPOSITORY: 'acme/widgets' }, () => {
      throw new Error('origin');
    }),
  ).toBe('acme/widgets');
  expect(resolveRepository({}, () => 'git@github.com:local/fork.git')).toBe('local/fork');
  expect(
    resolveRepository({ GITHUB_REPOSITORY: '   ' }, () => 'https://github.com/local/fork'),
  ).toBe('local/fork');
});

test('pending owner lookup uses GITHUB_REPOSITORY when the checkout has no origin', () => {
  const root = mkdtempSync(join(tmpdir(), 'pending-repo-'));
  try {
    mkdirSync(join(root, 'e2e/pending'), { recursive: true });
    mkdirSync(join(root, 'docs/security'), { recursive: true });
    writeFileSync(join(root, 'docs/security/controls.yaml'), '');
    const gitDir = join(root, 'git');
    const ghLog = join(root, 'gh-args');
    const gh = join(root, 'gh');
    writeFileSync(
      gh,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(ghLog)}\nprintf '%s' '[]'\n`,
    );
    chmodSync(gh, 0o755);
    const init = spawnSync('git', ['init', '--bare', gitDir], { encoding: 'utf8' });
    expect(init.status).toBe(0);
    const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/check-pending.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'acme/widgets',
        GIT_DIR: gitDir,
        PATH: `${root}:${process.env.PATH ?? ''}`,
      },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).toContain('acme/widgets');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1 security specs run and leave the pending catalog', () => {
  const workflow = readFileSync('.github/workflows/e2e.yml', 'utf8');
  const job = workflow.slice(
    workflow.indexOf('  e2e-security:'),
    workflow.indexOf('  pending-owners:'),
  );
  expect(job).toContain('pnpm exec playwright test --config e2e/playwright.config.ts security\n');
  expect(job).toContain('playwright install --with-deps chromium');
  expect(job).not.toContain('--list');
  const ids = readPendingCatalog('e2e/pending').map((row) => row.id);
  expect(ids).not.toContain('sec.policy-fail-closed');
  expect(ids).not.toContain('sec.model-claims-approval');
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
