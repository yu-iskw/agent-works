import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judge, parseRuns } from './evidence.mjs';

const run = (name, status) =>
  JSON.stringify({
    type: 'test_run',
    test_run: { path: 'tests/dev.tftest.hcl', run: name, status },
  });

const green = {
  code: 0,
  runs: parseRuns(
    [run('infra-no-owner-binding', 'pass'), run('infra-no-sa-keys', 'pass')].join('\n'),
  ),
};

const controlled = (owner, keys) =>
  new Map([
    [
      'infra.no-owner-binding',
      [
        { where: 'root', ...owner },
        { where: 'module', ...owner },
      ],
    ],
    [
      'infra.no-sa-keys',
      [
        { where: 'root', ...keys },
        { where: 'module', ...keys },
      ],
    ],
  ]);

const ownerTripped = {
  code: 1,
  runs: parseRuns(
    [run('infra-no-owner-binding', 'fail'), run('infra-no-sa-keys', 'pass')].join('\n'),
  ),
};
const keysTripped = {
  code: 1,
  runs: parseRuns(
    [run('infra-no-owner-binding', 'pass'), run('infra-no-sa-keys', 'fail')].join('\n'),
  ),
};

test('parseRuns keeps run statuses and skips progress lines and noise', () => {
  const lines = [
    'not json',
    JSON.stringify({ type: 'test_run', test_run: { run: 'a', progress: 'starting' } }),
    run('a', 'pass'),
    run('b', 'fail'),
  ].join('\n');
  assert.deepEqual(
    [...parseRuns(lines)],
    [
      ['a', 'pass'],
      ['b', 'fail'],
    ],
  );
});

test('each scratch failing only its own run marks both evidence ids passed', () => {
  assert.deepEqual(judge({ baseline: green, controlled: controlled(ownerTripped, keysTripped) }), [
    { id: 'infra.no-owner-binding', status: 'passed', reasons: [] },
    { id: 'infra.no-sa-keys', status: 'passed', reasons: [] },
  ]);
});

test('a scratch that the test does not catch marks that id failed', () => {
  const uncaught = { code: 0, runs: green.runs };
  const verdicts = judge({ baseline: green, controlled: controlled(ownerTripped, uncaught) });
  assert.deepEqual(verdicts[1], {
    id: 'infra.no-sa-keys',
    status: 'failed',
    reasons: [
      'root: scratch did not fail terraform test',
      'root: infra-no-sa-keys is pass, not fail',
      'module: scratch did not fail terraform test',
      'module: infra-no-sa-keys is pass, not fail',
    ],
  });
});

test('a run missing from the committed tree marks its id failed', () => {
  const missing = { code: 0, runs: parseRuns(run('infra-no-owner-binding', 'pass')) };
  const verdicts = judge({ baseline: missing, controlled: controlled(ownerTripped, keysTripped) });
  assert.deepEqual(
    verdicts.map(({ id, status }) => [id, status]),
    [
      ['infra.no-owner-binding', 'passed'],
      ['infra.no-sa-keys', 'failed'],
    ],
  );
});
