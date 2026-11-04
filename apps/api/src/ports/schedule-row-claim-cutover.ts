import { readFileSync } from 'node:fs';

import { schedulesReady } from '../scheduling/migration.js';

import type postgres from 'postgres';

export type SchedulerWriter = 'legacy' | 'rowclaim';
export type SchedulerOwner = { owner: SchedulerWriter; generation: number };

export class CutoverRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CutoverRefused';
  }
}

const pending = new WeakMap<postgres.Sql, Promise<void>>();

/** Applies 0013 then 0026 under advisory lock 7013. Idempotent, recorded in schema_migrations. */
export function rowClaimReady(sql: postgres.Sql): Promise<void> {
  const previous = pending.get(sql);
  if (previous !== undefined) return previous;
  const promise = schedulesReady(sql).then(() => applyMigration(sql));
  pending.set(sql, promise);
  return promise;
}

async function applyMigration(sql: postgres.Sql): Promise<void> {
  const name = '0026_schedule_row_claim.sql';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed module-relative migration URL
  const body = readFileSync(
    new URL('../../migrations/0026_schedule_row_claim.sql', import.meta.url),
    'utf8',
  );
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7013)`;
    const rows = await tx<
      { name: string }[]
    >`select name from schema_migrations where name=${name}`;
    if (rows.length > 0) return;
    await tx.unsafe(body);
    await tx`insert into schema_migrations(name) values(${name})`;
  });
}

export async function readSchedulerOwner(sql: postgres.Sql): Promise<SchedulerOwner> {
  await rowClaimReady(sql);
  const rows = await sql<
    { owner: SchedulerWriter; generation: number }[]
  >`select owner, generation from scheduler_owner where singleton`;
  if (rows.length === 0) throw new CutoverRefused('scheduler owner row missing');
  return rows[0];
}

/**
 * Resumable and idempotent. Gives every active timed schedule without a due row a wake-up at its
 * payload cursor. The first claim recomputes the real next slot. Returns the number of rows set.
 */
async function backfillScheduleDue(sql: postgres.Sql | postgres.TransactionSql): Promise<number> {
  const rows = await sql`update schedules s set next_due = (s.payload->>'cursor')::timestamptz
    where s.next_due is null and s.state = 'active'
      and not exists (select 1 from event_triggers t where t.schedule_id = s.id)`;
  return rows.count;
}

export type CutoverValidation = { activeTimedWithoutDue: number; duplicateSlots: number };

export async function validateScheduleDue(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<CutoverValidation> {
  const [missing] = await sql<{ n: number }[]>`select count(*)::int as n from schedules s
    where s.next_due is null and s.state = 'active'
      and not exists (select 1 from event_triggers t where t.schedule_id = s.id)`;
  const [dup] = await sql<{ n: number }[]>`select count(*)::int as n from (
    select 1 from schedule_runs where event_key is null group by schedule_id, fire_at having count(*) > 1) d`;
  return { activeTimedWithoutDue: missing.n, duplicateSlots: dup.n };
}

/**
 * The one-writer switch. Holds advisory lock 7013 (no legacy transaction in flight) and updates the
 * owner row (waits out row-claim transactions, which hold it FOR SHARE). If either writer is still
 * active within the timeout the flip is refused and nothing changes.
 */
export async function switchSchedulerOwner(
  sql: postgres.Sql,
  from: SchedulerWriter,
  to: SchedulerWriter,
  options: { lockTimeoutMs?: number } = {},
): Promise<SchedulerOwner> {
  await rowClaimReady(sql);
  if (from === to) throw new CutoverRefused('from and to must differ');
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`set local lock_timeout = ${options.lockTimeoutMs ?? 2000}`);
      const [lock] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(7013) as ok`;
      if (!lock.ok) throw new CutoverRefused('legacy writer active (advisory lock 7013 held)');
      const [row] = await tx<
        SchedulerOwner[]
      >`select owner, generation from scheduler_owner where singleton for update`;
      if (row.owner !== from) throw new CutoverRefused(`owner is ${row.owner}, expected ${from}`);
      if (to === 'rowclaim') {
        await backfillScheduleDue(tx);
        const check = await validateScheduleDue(tx);
        if (check.activeTimedWithoutDue > 0 || check.duplicateSlots > 0)
          throw new CutoverRefused(`validation failed ${JSON.stringify(check)}`);
      }
      const [next] = await tx<
        SchedulerOwner[]
      >`update scheduler_owner set owner = ${to}, generation = generation + 1, changed_at = now() where singleton returning owner, generation`;
      return next;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '55P03')
      throw new CutoverRefused('row-claim writer active (owner row locked)');
    throw error;
  }
}
