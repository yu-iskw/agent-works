import { openSql } from '../ledger/disposable-postgres.js';

import type postgres from 'postgres';

/** The offline CLI refuses a database lacking the disposable drill marker. No ambient URL. */
export async function openDrillDatabase(url: string): Promise<postgres.Sql> {
  const parsed = new URL(url);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname)
  )
    throw new Error('disposable local database required');
  const sql = openSql(url);
  try {
    const rows = await sql<{ marker: string }[]>`select marker from issue135_disposable_marker`;
    if (rows.length !== 1 || rows[0].marker !== 'OFFLINE_FIXTURE_ONLY')
      throw new Error('disposable marker missing');
    return sql;
  } catch {
    await sql.end({ timeout: 1 });
    throw new Error('disposable marker missing');
  }
}
