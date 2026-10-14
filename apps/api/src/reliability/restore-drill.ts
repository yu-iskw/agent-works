import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { applyBudgetMigration } from '../finops/migration.js';
import { openSql } from '../ledger/disposable-postgres.js';
import { createPostgresDispatchPort } from '../ledger/postgres-dispatch.js';
import { createPostgresLedgerPort } from '../ledger/postgres-ledger.js';
import { proofOf } from '../ports/dispatch-port.js';

import { startDrillPostgres } from './disposable-postgres.js';

import type { AcceptTask } from '../ports/dispatch-port.js';
import type { TaskLedger } from '../ports/ledger-port.js';
import type { ExternalWriteReceipt, OutboxEvent } from '@agent-works/domain';
import type postgres from 'postgres';

export type RestoreReport = {
  readonly mode: 'disposable-postgres';
  readonly completedBeforeDump: number;
  readonly inFlightBeforeDump: number;
  readonly externalCreates: number;
  readonly duplicateCreates: number;
  readonly recoveredReceipts: number;
  readonly redrivenCompleted: number;
  readonly pass: boolean;
};
const startedAt = '2026-10-10T10:00:00.000Z';
const restoredDatabase = 'issue135_restored_fixture';

type ExternalSystem = {
  readonly counts: Map<string, number>;
  execute(key: string): ExternalWriteReceipt;
};
function externalSystem(): ExternalSystem {
  // This state lives outside Postgres and is intentionally NOT restored with the ledger.
  const receipts = new Map<string, ExternalWriteReceipt>();
  const counts = new Map<string, number>();
  return {
    counts,
    execute(key) {
      const prior = receipts.get(key);
      if (prior !== undefined) return prior;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const receipt = { ref: `FAKE-${receipts.size + 1}`, digestSha256: 'a'.repeat(64) };
      receipts.set(key, receipt);
      return receipt;
    },
  };
}
/** pg_dump/psql only address the database allocated by startDisposablePostgres. */
function dumpTransport(url: string, containerName?: string) {
  const nativeBin = '/usr/lib/postgresql/16/bin';
  const address = new URL(url);
  if (existsSync(`${nativeBin}/pg_dump`)) {
    const connection = ['-h', '127.0.0.1', '-p', address.port, '-U', 'postgres'];
    return {
      dump() {
        return execFileSync(
          `${nativeBin}/pg_dump`,
          [...connection, '-d', 'postgres', '--no-owner', '--no-acl'],
          { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      },
      restore(body: string) {
        execFileSync(
          `${nativeBin}/psql`,
          [...connection, '-d', restoredDatabase, '-v', 'ON_ERROR_STOP=1'],
          { input: body, stdio: ['pipe', 'ignore', 'pipe'] },
        );
      },
    };
  }
  const container = containerName;
  if (container === undefined || !/^issue135-memory-pg-\d+-\d+$/.test(container))
    throw new Error('disposable container identity');
  return {
    dump() {
      return execFileSync(
        'docker',
        [
          'exec',
          container,
          'pg_dump',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '--no-owner',
          '--no-acl',
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    },
    restore(body: string) {
      execFileSync(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-d',
          restoredDatabase,
          '-v',
          'ON_ERROR_STOP=1',
        ],
        { input: body, stdio: ['pipe', 'ignore', 'pipe'] },
      );
    },
  };
}
function eventFor(submitted: OutboxEvent, suffix: string): OutboxEvent {
  return {
    destination: 'audit',
    event: {
      ...submitted.event,
      eventId: `${submitted.event.taskId}:${suffix}`,
      eventType: `task.${suffix}`,
      outcome: 'SUCCESS',
    },
  };
}
async function complete(input: {
  ledger: TaskLedger;
  subject: string;
  taskId: string;
  receipt: ExternalWriteReceipt;
  lease: Parameters<TaskLedger['transition']>[0]['lease'];
}): Promise<void> {
  const task = await input.ledger.read(input.subject, input.taskId);
  if (task === undefined) throw new Error('drill task missing');
  const submitted = (await input.ledger.events(input.subject, input.taskId))[0];
  await input.ledger.transition({
    subject: input.subject,
    taskId: input.taskId,
    expectedVersion: task.version,
    to: 'COMPLETED',
    receipt: input.receipt,
    lease: input.lease,
    event: eventFor(submitted, 'completed'),
  });
}
async function seed(sql: postgres.Sql, external: ExternalSystem, request: AcceptTask) {
  await applyBudgetMigration(sql);
  await sql`create table issue135_disposable_marker(marker text primary key)`;
  await sql`insert into issue135_disposable_marker values ('OFFLINE_FIXTURE_ONLY')`;
  const dispatch = createPostgresDispatchPort(sql, () => new Date(startedAt));
  const ledger = createPostgresLedgerPort(sql, () => new Date(startedAt));
  const seeded: { taskId: string; key: string; completed: boolean }[] = [];
  for (let index = 0; index < 4; index += 1) {
    const key = `restore-write-${index}`;
    const accepted = await dispatch.accept({ ...request, idempotencyKey: key });
    const claim = await dispatch.claim('before-dump', 60_000);
    if (claim?.taskId !== accepted.taskId) throw new Error('drill claim');
    const submitted = (await ledger.events(request.subject, accepted.taskId))[0];
    await ledger.transition({
      subject: request.subject,
      taskId: accepted.taskId,
      expectedVersion: 1,
      to: 'RUNNING',
      lease: proofOf(claim),
      event: eventFor(submitted, 'running'),
    });
    const completed = index < 2;
    // One in-flight action has already reached the external system, but its receipt is not durable yet.
    if (index < 3) {
      const receipt = external.execute(key);
      if (completed)
        await complete({
          ledger,
          subject: request.subject,
          taskId: accepted.taskId,
          receipt,
          lease: proofOf(claim),
        });
    }
    seeded.push({ taskId: accepted.taskId, key, completed });
  }
  return seeded;
}
/** Offline rehearsal only. No caller-supplied database URL or real external adapter. */
export async function runRestoreDrill(request: AcceptTask): Promise<RestoreReport> {
  const database = await startDrillPostgres();
  const source = openSql(database.url);
  let restored: postgres.Sql | undefined;
  try {
    const external = externalSystem();
    const seeded = await seed(source, external, request);
    const transport = dumpTransport(database.url, database.containerName);
    const dump = transport.dump();
    await source.unsafe(`create database ${restoredDatabase}`);
    transport.restore(dump);
    const restoredUrl = new URL(database.url);
    restoredUrl.pathname = `/${restoredDatabase}`;
    restored = openSql(restoredUrl.toString());
    const after = '2026-10-10T10:02:00.000Z';
    const ledger = createPostgresLedgerPort(restored, () => new Date(after));
    const dispatch = createPostgresDispatchPort(restored, () => new Date(after));
    let recoveredReceipts = 0;
    let redrivenCompleted = 0;
    for (const entry of seeded.filter((value) => value.completed)) {
      // Re-deliver the ORIGINAL acceptance key: completed tasks remain terminal, with durable receipts.
      const replay = await dispatch.accept({ ...request, idempotencyKey: entry.key });
      if (replay.taskId !== entry.taskId) throw new Error('restored idempotency claim changed');
      const receipt = await ledger.readReceipt(request.subject, replay.taskId);
      if (receipt === undefined) throw new Error('completed receipt missing after restore');
      redrivenCompleted += 1;
      recoveredReceipts += 1;
    }
    for (;;) {
      const claim = await dispatch.claim('after-restore', 60_000);
      if (claim === undefined) break;
      const entry = seeded.find((value) => value.taskId === claim.taskId);
      if (entry === undefined || entry.completed)
        throw new Error('completed external effect resubmitted');
      const receipt = external.execute(entry.key);
      await complete({
        ledger,
        subject: request.subject,
        taskId: claim.taskId,
        receipt,
        lease: proofOf(claim),
      });
      recoveredReceipts += 1;
    }
    const externalCreates = [...external.counts.values()].reduce((sum, count) => sum + count, 0);
    const duplicateCreates = [...external.counts.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    );
    const report: RestoreReport = {
      mode: 'disposable-postgres',
      completedBeforeDump: 2,
      inFlightBeforeDump: 2,
      externalCreates,
      duplicateCreates,
      recoveredReceipts,
      redrivenCompleted,
      pass:
        duplicateCreates === 0 &&
        externalCreates === 4 &&
        recoveredReceipts === 4 &&
        redrivenCompleted === 2,
    };
    if (!report.pass) throw new Error('restore verification failed');
    return report;
  } finally {
    await restored?.end({ timeout: 1 });
    await source.end({ timeout: 1 });
    await database.stop();
  }
}
