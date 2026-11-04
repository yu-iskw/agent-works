import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { applyTaskLedgerMigration } from '../ledger/postgres-ledger.js';

import { createSuspensionEnforcer, InvocationStopped } from './enforcement.js';
import { listOutstandingOperations } from './outstanding.js';
import { createPostgresSuspensionLedger, suspensionLedgerReady } from './postgres.js';
import { publishPins, scopeTargets, suspendCommand, testContext } from './test-fixtures.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
const live = dockerAvailable();
const digest = 'a'.repeat(64);
let database: DisposablePostgres | undefined;
let sql: Sql;

beforeAll(async () => {
  if (!live) return;
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await applyTaskLedgerMigration(sql);
  await suspensionLedgerReady(sql);
  await publishPins(createPostgresSuspensionLedger(sql));
}, 60_000);
afterAll(async () => {
  if (live) await sql.end({ timeout: 1 });
  await database?.stop();
});
async function revisionOf(target: (typeof scopeTargets)[number]): Promise<number> {
  const snapshot = await createPostgresSuspensionLedger(sql).snapshot();
  return (
    snapshot.suspensions.find(
      (value) =>
        value.target.scope === target.scope &&
        value.target.id === target.id &&
        value.target.version === target.version,
    )?.revision ?? 0
  );
}

describe.skipIf(!live)('stop control on real PostgreSQL', () => {
  test.each(scopeTargets)(
    '$scope suspension denies the next effect after commit and survives a restart',
    async (target) => {
      const ledger = createPostgresSuspensionLedger(sql);
      const enforcer = createSuspensionEnforcer({ ledger });
      await expect(enforcer.check(testContext, 'tool')).resolves.toBeUndefined();
      const stop = suspendCommand(target, await revisionOf(target));
      await ledger.change(stop, 'operator', new Date());

      const restartedSql = openSql(database?.url ?? '');
      try {
        const restarted = createSuspensionEnforcer({
          ledger: createPostgresSuspensionLedger(restartedSql),
        });
        await expect(restarted.check(testContext, 'tool')).rejects.toBeInstanceOf(
          InvocationStopped,
        );
        await expect(restarted.check(testContext, 'model')).rejects.toBeInstanceOf(
          InvocationStopped,
        );
      } finally {
        await restartedSql.end({ timeout: 1 });
      }

      if (stop.kind !== 'suspension') throw new Error('fixture');
      await ledger.change(
        {
          kind: 'suspension',
          command: {
            ...stop.command,
            commandId: crypto.randomUUID(),
            action: 'resume',
            expectedRevision: stop.command.expectedRevision + 1,
          },
        },
        'operator',
        new Date(),
      );
      await expect(enforcer.check(testContext, 'tool')).resolves.toBeUndefined();
    },
  );

  test('concurrent stop and dispatch never lets an effect start after the stop commits', async () => {
    const ledger = createPostgresSuspensionLedger(sql);
    const enforcer = createSuspensionEnforcer({ ledger });
    const stop = suspendCommand(
      { scope: 'global', id: '*', version: null },
      await revisionOf({ scope: 'global', id: '*', version: null }),
    );
    const receipts: string[] = [];
    let committed = false;
    let lateEffects = 0;
    const runWorker = async (worker: number): Promise<'stopped' | 'finished'> => {
      for (let step = 0; step < 400; step += 1) {
        const afterCommit = committed;
        try {
          await enforcer.check({ ...testContext, taskId: `race-${worker}` }, 'tool');
        } catch (error) {
          if (error instanceof InvocationStopped) return 'stopped';
          throw error;
        }
        if (afterCommit) lateEffects += 1;
        receipts.push(`${worker}:${step}`);
        await Promise.resolve();
      }
      return 'finished';
    };
    const workers = Array.from({ length: 16 }, (_, worker) => runWorker(worker));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ledger.change(stop, 'operator', new Date());
    committed = true;
    const outcomes = await Promise.all(workers);

    expect(lateEffects).toBe(0);
    expect(outcomes.every((outcome) => outcome === 'stopped')).toBe(true);
    expect(receipts.length).toBeGreaterThan(0);
    const history = await ledger.history();
    const denied = history.filter(
      (event) => event.eventType === 'invocation.denied' && event.taskId?.startsWith('race-'),
    );
    expect(denied).toHaveLength(16);
    expect(denied.every((event) => event.reason === 'INVOCATION_SUSPENDED')).toBe(true);
    await expect(enforcer.check(testContext, 'tool')).rejects.toBeInstanceOf(InvocationStopped);
  });

  test('completed writes stay visible and are never reported as undone; running work is uncertain', async () => {
    const at = new Date('2026-10-14T10:00:00.000Z');
    await sql`insert into tasks (id, created_by_sub, status, objective_digest, skill_version, agent_version, policy_version, budget, version, created_at, updated_at) values
      ('done-1', 'alice', 'COMPLETED', ${digest}, 'incident', '1', '1', 1, 3, ${at}, ${at}),
      ('run-1', 'alice', 'RUNNING', ${digest}, 'incident', '1', '1', 1, 2, ${at}, ${at}),
      ('queued-1', 'bob', 'QUEUED', ${digest}, 'incident', '1', '1', 1, 1, ${at}, ${at}),
      ('cancelled-1', 'bob', 'CANCELLED', ${digest}, 'incident', '1', '1', 1, 2, ${at}, ${at})`;
    await sql`insert into task_transition_receipts (task_id, version, ref, digest) values ('done-1', 3, 'ticket://T-1', ${digest})`;
    await sql`insert into task_deliveries (task_id, payload, available_at, attempt, worker_id, lease_until, fencing_token)
      values ('run-1', '{}'::jsonb, ${at}, 1, 'worker-a', ${new Date(at.getTime() + 1000)}, 1)`;
    const before = await sql`select id, status, version from tasks order by id`;

    const ledger = createPostgresSuspensionLedger(sql);
    const global = { scope: 'global', id: '*', version: null } as const;
    const current = await ledger.snapshot();
    const stopped = current.suspensions.find((value) => value.target.scope === 'global');
    if (stopped?.suspended !== true) {
      await ledger.change(suspendCommand(global, await revisionOf(global)), 'operator', new Date());
    }

    const report = await listOutstandingOperations(sql, new Date(at.getTime() + 60_000));
    expect(report.completed).toEqual([
      expect.objectContaining({
        taskId: 'done-1',
        status: 'COMPLETED',
        receiptRef: 'ticket://T-1',
      }),
    ]);
    expect(report.uncertain).toEqual([
      expect.objectContaining({ taskId: 'run-1', status: 'RUNNING', leaseExpired: true }),
    ]);
    expect(report.outstanding.map((operation) => operation.taskId)).toEqual(['queued-1']);
    expect(await sql`select id, status, version from tasks order by id`).toEqual(before);
  });
});
