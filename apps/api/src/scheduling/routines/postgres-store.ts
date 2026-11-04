import type {
  CreateOutcome,
  RoutineKind,
  RoutineRecord,
  RoutineScope,
  RoutineStore,
} from './types.js';
import type postgres from 'postgres';

type Row = {
  routine_id: string;
  grant_id: string;
  sponsor: string;
  idempotency_key: string;
  digest: string;
  kind: RoutineKind;
  scopes: RoutineScope[];
  state: 'active' | 'cancelled';
  cancel_reason: string | null;
  created_at: Date;
  expires_at: Date;
  cancelled_at: Date | null;
};

function toRecord(r: Row): RoutineRecord {
  return {
    routineId: r.routine_id,
    grantId: r.grant_id,
    sponsor: r.sponsor,
    idempotencyKey: r.idempotency_key,
    digest: r.digest,
    kind: r.kind,
    scopes: r.scopes,
    state: r.state,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    cancelledAt: r.cancelled_at === null ? null : r.cancelled_at.toISOString(),
  };
}

export function createPostgresRoutineStore(sql: postgres.Sql): RoutineStore {
  return {
    async create(record, maxActive): Promise<CreateOutcome> {
      return sql.begin(async (tx): Promise<CreateOutcome> => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${'routine:' + record.grantId}, 0))`;
        const priors = await tx<Row[]>`
          select * from tw_routines
          where grant_id = ${record.grantId} and idempotency_key = ${record.idempotencyKey}`;
        const prior = priors.at(0);
        if (prior !== undefined) {
          return prior.digest === record.digest
            ? { outcome: 'existing', record: toRecord(prior) }
            : { outcome: 'conflict' };
        }
        const counted = await tx<{ count: string }[]>`
          select count(*) from tw_routines
          where grant_id = ${record.grantId} and state = 'active'
            and expires_at > ${record.createdAt}`;
        if (Number(counted.at(0)?.count ?? 0) >= maxActive) return { outcome: 'fan_out_exceeded' };
        await tx`
          insert into tw_routines (routine_id, grant_id, sponsor, idempotency_key, digest, kind,
            scopes, state, created_at, expires_at)
          values (${record.routineId}, ${record.grantId}, ${record.sponsor},
            ${record.idempotencyKey}, ${record.digest}, ${record.kind},
            ${tx.json(record.scopes)}, 'active',
            ${record.createdAt}, ${record.expiresAt})`;
        return { outcome: 'created', record };
      });
    },
    async get(id) {
      const rows = await sql<Row[]>`select * from tw_routines where routine_id = ${id}`;
      const row = rows.at(0);
      return row === undefined ? undefined : toRecord(row);
    },
    async listActive() {
      const rows = await sql<Row[]>`select * from tw_routines where state = 'active'`;
      return rows.map(toRecord);
    },
    async cancel(id, reason, at) {
      await sql`
        update tw_routines set state = 'cancelled', cancel_reason = ${reason}, cancelled_at = ${at}
        where routine_id = ${id} and state = 'active'`;
      const rows = await sql<Row[]>`select * from tw_routines where routine_id = ${id}`;
      const row = rows.at(0);
      return row === undefined ? undefined : toRecord(row);
    },
  };
}
