import type postgres from 'postgres';

export type OperationState = 'outstanding' | 'uncertain' | 'completed';
export type OutstandingOperation = {
  readonly taskId: string;
  readonly ownerSub: string;
  readonly status: string;
  readonly state: OperationState;
  readonly updatedAt: string;
  readonly leaseExpired: boolean;
  readonly receiptRef: string | null;
};
export type OutstandingReport = {
  readonly outstanding: readonly OutstandingOperation[];
  readonly uncertain: readonly OutstandingOperation[];
  readonly completed: readonly OutstandingOperation[];
};
type Row = {
  id: string;
  created_by_sub: string;
  status: string;
  updated_at: Date;
  lease_until: Date | null;
  worker_id: string | null;
  ref: string | null;
};

/**
 * Read-only view over the task ledger for an operator who just stopped work.
 * RUNNING tasks are uncertain because a worker held them and whether its last effect committed
 * is unknown. COMPLETED tasks keep their receipt and are never reported as undone.
 * The query takes no locks and writes nothing, so it stays usable while a stop is active.
 */
export async function listOutstandingOperations(
  sql: postgres.Sql,
  now: Date,
): Promise<OutstandingReport> {
  const rows = await sql<Row[]>`
    select t.id, t.created_by_sub, t.status, t.updated_at, d.lease_until, d.worker_id, r.ref
    from tasks t
    left join task_deliveries d on d.task_id = t.id
    left join task_transition_receipts r on r.task_id = t.id and r.version = t.version
    where t.status not in ('FAILED', 'CANCELLED')
    order by t.updated_at, t.id
  `;
  const operations = rows.map((row): OutstandingOperation => {
    const state: OperationState =
      row.status === 'COMPLETED'
        ? 'completed'
        : row.status === 'RUNNING'
          ? 'uncertain'
          : 'outstanding';
    return {
      taskId: row.id,
      ownerSub: row.created_by_sub,
      status: row.status,
      state,
      updatedAt: row.updated_at.toISOString(),
      leaseExpired:
        row.worker_id !== null &&
        row.lease_until !== null &&
        row.lease_until.getTime() <= now.getTime(),
      receiptRef: row.ref,
    };
  });
  return {
    outstanding: operations.filter((operation) => operation.state === 'outstanding'),
    uncertain: operations.filter((operation) => operation.state === 'uncertain'),
    completed: operations.filter((operation) => operation.state === 'completed'),
  };
}
