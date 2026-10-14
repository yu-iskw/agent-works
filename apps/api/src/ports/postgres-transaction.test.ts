import { expect, it } from 'vitest';

import { currentPostgresTransaction, withPostgresTransaction } from './postgres-transaction.js';

import type postgres from 'postgres';

function singleConnectionPool() {
  let occupied = false;
  let begins = 0;
  const connection = {} as postgres.TransactionSql;
  const sql = {
    async begin(operation: (tx: postgres.TransactionSql) => Promise<unknown>) {
      if (occupied) throw new Error('pool exhausted by nested begin');
      occupied = true;
      begins++;
      try {
        return await operation(connection);
      } finally {
        occupied = false;
      }
    },
  } as unknown as postgres.Sql;
  return { sql, connection, begins: () => begins };
}

it('uses the outer connection instead of exhausting a one-connection pool', async () => {
  const pool = singleConnectionPool();
  await withPostgresTransaction(pool.sql, async (outer) => {
    expect(currentPostgresTransaction(pool.sql)).toBe(outer);
    await withPostgresTransaction(pool.sql, (inner) => {
      expect(inner).toBe(outer);
      return Promise.resolve();
    });
  });
  expect(pool.begins()).toBe(1);
  expect(currentPostgresTransaction(pool.sql)).toBeUndefined();
});
it('never borrows another pool connection and retains both scopes during composition', async () => {
  const first = singleConnectionPool();
  const second = singleConnectionPool();
  await withPostgresTransaction(first.sql, async (outer) => {
    await withPostgresTransaction(second.sql, (inner) => {
      expect(inner).toBe(second.connection);
      expect(inner).not.toBe(outer);
      expect(currentPostgresTransaction(first.sql)).toBe(outer);
      expect(currentPostgresTransaction(second.sql)).toBe(inner);
      return Promise.resolve();
    });
    expect(currentPostgresTransaction(second.sql)).toBeUndefined();
  });
  expect(first.begins()).toBe(1);
  expect(second.begins()).toBe(1);
});
it('propagates inner failure and clears the transaction scope before retry', async () => {
  const pool = singleConnectionPool();
  await expect(
    withPostgresTransaction(pool.sql, () =>
      withPostgresTransaction(pool.sql, () => Promise.reject(new Error('rollback'))),
    ),
  ).rejects.toThrow('rollback');
  expect(currentPostgresTransaction(pool.sql)).toBeUndefined();
  await withPostgresTransaction(pool.sql, () => Promise.resolve());
  expect(pool.begins()).toBe(2);
});
