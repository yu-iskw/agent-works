import { readFileSync } from 'node:fs';

import { test } from '@playwright/test';

type PendingTest = { id: string; owner: string };

function pendingTests(value: unknown): PendingTest[] {
  if (!Array.isArray(value)) throw new Error('pending-tests.json must be a list');
  return value.map((row: unknown) => {
    if (row === null || typeof row !== 'object') throw new Error('pending test must be an object');
    const id = 'id' in row ? row.id : undefined;
    const owner = 'owner' in row ? row.owner : undefined;
    if (typeof id !== 'string' || typeof owner !== 'string') {
      throw new Error('pending test needs an id and an owner');
    }
    return { id, owner };
  });
}

const pending = pendingTests(JSON.parse(readFileSync('e2e/security/pending-tests.json', 'utf8')));

for (const row of pending) {
  test.fixme(row.id, { annotation: { type: 'owner', description: row.owner } }, () => {});
}
