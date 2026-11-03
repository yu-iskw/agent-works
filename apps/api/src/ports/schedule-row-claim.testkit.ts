import { execFileSync } from 'node:child_process';

import type { Sql } from 'postgres';

export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function dropSchedulerSchema(sql: Sql): Promise<void> {
  await sql`drop table if exists scheduler_owner, schedule_audit, received_events, schedule_runs, event_triggers, schedules cascade`;
  await sql`drop function if exists reject_schedule_audit_rewrite()`;
  await sql`drop function if exists schedule_writer_guard()`;
  await sql`drop table if exists schema_migrations`;
}
