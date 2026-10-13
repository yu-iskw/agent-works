import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

const contract = readFileSync('docs/spikes/google-docs-write-contract.md', 'utf8');
const matrix = readFileSync('docs/spikes/google-docs-write-negative-matrix.md', 'utf8');

function rows(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .slice(2)
    .map((line) =>
      line
        .split('|')
        .slice(1, 5)
        .map((cell) => cell.trim()),
    );
}

it('keeps the Docs contract and negative matrix predicates identical', () => {
  expect(rows(matrix)).toEqual(rows(contract));
});

it.each([contract, matrix])(
  'requires approval eligibility and remaining executions for a new Docs post',
  (text) => {
    expect(text).toContain(
      '`post_once` requires an eligible, approved, payload-bound approval with `executionsUsed < maxExecutions`',
    );
    const decisions = rows(text);
    expect(decisions.find(([id]) => id === 'approval_ineligible')).toEqual([
      'approval_ineligible',
      'deny',
      'No new post. `APPROVAL_REQUIRED`.',
      'The receipt is absent, and the approval is missing, is not approved, has no eligible approver, or does not bind this task, step, tool, target and digest.',
    ]);
    expect(decisions.find(([id]) => id === 'execution_limit')).toEqual([
      'execution_limit',
      'deny',
      'No new post. `APPROVAL_REQUIRED`.',
      'The receipt is absent, and `executionsUsed >= maxExecutions`. A new claim atomically consumes one execution before posting.',
    ]);
    expect(decisions.find(([id]) => id === 'replay')?.[3]).toContain('a receipt is stored');
  },
);
