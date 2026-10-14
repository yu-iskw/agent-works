import { expect, it, vi } from 'vitest';

import { createPostgresDlqStore } from './postgres-dlq.js';

import type { DlqDecision, DlqEntry } from './dlq-types.js';
import type postgres from 'postgres';

it('accepts a committed decision retry after jsonb reorders keys but rejects changed values', async () => {
  const entry: DlqEntry = {
    entryId: 'entry',
    taskId: 'task',
    subject: 'alice',
    idempotencyKey: 'key',
    riskyWrite: false,
    reason: 'stuck',
    state: 'requeued',
    version: 2,
    createdAt: '2026-10-14T00:00:00.000Z',
  };
  const decision: DlqDecision = {
    decisionId: 'decision',
    entryId: entry.entryId,
    operator: 'reviewer',
    reason: 'reviewed',
    action: 'requeue',
    evidenceRef: null,
    occurredAt: entry.createdAt,
  };
  const persisted = Object.fromEntries(Object.entries(decision).reverse());
  expect(JSON.stringify(persisted)).not.toBe(JSON.stringify(decision));
  const tx = vi.fn().mockImplementation((parts: TemplateStringsArray) => {
    if (parts[0].startsWith('select version')) return Promise.resolve([{ version: 2 }]);
    if (parts[0].startsWith('select payload')) return Promise.resolve([{ payload: persisted }]);
    throw new Error('committed retry must not mutate');
  });
  const sql = { begin: (callback: (transaction: unknown) => Promise<void>) => callback(tx) };
  const store = createPostgresDlqStore(sql as unknown as postgres.Sql);
  await expect(store.decide(entry, decision, 1)).resolves.toBeUndefined();
  expect(tx).toHaveBeenCalledTimes(2);
  await expect(store.decide(entry, { ...decision, reason: 'changed' }, 1)).rejects.toThrow(
    'DLQ decision identity conflict',
  );
});
