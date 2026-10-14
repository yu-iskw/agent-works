import { AsyncLocalStorage } from 'node:async_hooks';

import type postgres from 'postgres';

const transactions = new AsyncLocalStorage<ReadonlyMap<postgres.Sql, postgres.TransactionSql>>();

/** Only reuse a connection belonging to this pool and asynchronous transaction scope. */
export function currentPostgresTransaction(sql: postgres.Sql): postgres.TransactionSql | undefined {
  return transactions.getStore()?.get(sql);
}

export async function withPostgresTransaction<T>(
  sql: postgres.Sql,
  operation: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const current = currentPostgresTransaction(sql);
  if (current !== undefined) return operation(current);
  return (await sql.begin((tx) => {
    const scope = new Map(transactions.getStore());
    scope.set(sql, tx);
    return transactions.run(scope, () => operation(tx));
  })) as T;
}
