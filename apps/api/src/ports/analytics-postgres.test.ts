import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { analyticsReady } from '../analytics/migration.js';
import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';

import { createPostgresAnalyticsPort } from './analytics-postgres.js';
import { analyticsPortContract } from './analytics.contract.js';

import type { AnalyticsPort } from './analytics.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';
function available(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
const live = available();
let database: DisposablePostgres;
let sql: Sql;
let port: AnalyticsPort;
beforeAll(async () => {
  if (!live) return;
  database = await startDisposablePostgres();
  sql = openSql(database.url);
}, 60000);
beforeEach(async () => {
  if (!live) return;
  await sql`drop table if exists analytics_query_audit,analytics_report_versions,analytics_metrics,analytics_datasets cascade`;
  await sql`drop function if exists reject_analytics_rewrite()`;
  await sql`drop table if exists schema_migrations`;
  const other = openSql(database.url);
  await sql.end({ timeout: 1 });
  sql = other;
  await analyticsReady(sql);
  port = createPostgresAnalyticsPort(sql);
});
afterAll(async () => {
  if (live) {
    await sql.end({ timeout: 1 });
    await database.stop();
  }
});
describe.skipIf(!live)('Postgres analytics contract', () => {
  analyticsPortContract(() => port);
});
it.skipIf(!live)('rejects rewrite, deletion, and truncate of evidence tables', async () => {
  await expect(sql`update analytics_query_audit set payload='{}'::jsonb`).rejects.toThrow(
    'append-only',
  );
  await expect(sql`delete from analytics_query_audit`).rejects.toThrow('append-only');
  await expect(sql`truncate analytics_query_audit`).rejects.toThrow('append-only');
  await expect(sql`update analytics_report_versions set payload='{}'::jsonb`).rejects.toThrow(
    'append-only',
  );
  await expect(sql`delete from analytics_report_versions`).rejects.toThrow('append-only');
  await expect(sql`truncate analytics_report_versions`).rejects.toThrow('append-only');
});
it.skipIf(!live)('reopens an independently pooled durable catalog', async () => {
  const { analyticsDatasets } = await import('../analytics/fixtures.js');
  await port.putDataset(analyticsDatasets[0]);
  const other = openSql(database.url);
  try {
    expect((await createPostgresAnalyticsPort(other).catalog()).datasets).toEqual([
      analyticsDatasets[0],
    ]);
  } finally {
    await other.end({ timeout: 1 });
  }
});
it.skipIf(!live)('rolls back rejected catalog writes', async () => {
  const { analyticsDatasets } = await import('../analytics/fixtures.js');
  await sql`alter table analytics_datasets add constraint reject_fixture check (name <> 'approved.sales')`;
  await expect(port.putDataset(analyticsDatasets[0])).rejects.toThrow();
  expect((await port.catalog()).datasets).toEqual([]);
});

it.skipIf(!live)('allocates unique versions across independent pools', async () => {
  const { randomUUID } = await import('node:crypto');
  const other = openSql(database.url);
  const reopened = createPostgresAnalyticsPort(other);
  const input = {
    reportId: randomUUID(),
    title: 'Concurrent report',
    owner: 'alice',
    validatedBy: 'alice',
    validatedAt: '2026-10-14T10:00:00.000Z',
    sql: 'SELECT amount FROM approved.sales WHERE day >= @start LIMIT 20',
    params: { start: '2026-10-01' },
    vetted: false,
    metric: null,
    classification: 'CONFIDENTIAL' as const,
  };
  try {
    const versions = await Promise.all([
      port.saveReport({ ...input, id: randomUUID() }),
      reopened.saveReport({ ...input, id: randomUUID() }),
    ]);
    expect(versions.map((v) => v.version).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(await reopened.reports('alice')).toHaveLength(2);
  } finally {
    await other.end({ timeout: 1 });
  }
});
