import { addUsage } from '#domain-budget';

import { admission, admissionEvent } from './budget-admission.js';
import { chargeFingerprint, userBudgetKey, validateCharge } from './budget-validation.js';

import type { BudgetCharge, BudgetUsage } from '#domain-budget';
import type { BudgetEvent, BudgetPolicy, BudgetPort, Reservation } from './budget-port.js';
import type postgres from 'postgres';

type Account = {
  scope_key: string;
  owner_subject: string;
  sponsor: string | null;
  window_key: string;
  cost_micros: string;
  inference_steps: string;
  parallelism: string;
};
export function createPostgresBudgetPort(sql: postgres.Sql): BudgetPort {
  return {
    reserve(charge, policy) {
      validateCharge(charge, policy);
      return sql.begin((tx) => reserve(tx, charge, policy));
    },
    release(operationId) {
      return sql.begin((tx) => release(tx, operationId));
    },
    async events() {
      const rows = await sql<
        { payload: BudgetEvent }[]
      >`select payload from budget_events order by event_id`;
      return rows.map((row) => row.payload);
    },
  };
}
async function reserve(
  tx: postgres.TransactionSql,
  charge: BudgetCharge,
  policy: BudgetPolicy,
): Promise<Reservation> {
  // Lock ordering is deterministic for all tasks sharing a user, avoiding lost-update overspend.
  const taskKey = `task:${charge.scope.taskId}`;
  const userKey = `user:${userBudgetKey(charge)}`;
  await ensureAccounts(tx, charge, taskKey, userKey);
  const accounts = await tx<
    Account[]
  >`select * from budget_accounts where scope_key in (${taskKey}, ${userKey}) order by scope_key for update`;
  const previous = await tx<
    { fingerprint: string; result: Reservation }[]
  >`select fingerprint, result from budget_reservations where operation_id = ${charge.operationId}`;
  const fingerprint = chargeFingerprint(charge);
  if (previous.length > 0) {
    if (previous[0].fingerprint !== fingerprint)
      throw new Error('budget operation identity conflict');
    return previous[0].result;
  }
  const task = accounts.find((account) => account.scope_key === taskKey);
  const user = accounts.find((account) => account.scope_key === userKey);
  if (task === undefined || user === undefined) throw new Error('budget account');
  if (
    task.owner_subject !== charge.scope.userSubject ||
    task.sponsor !== charge.scope.sponsor ||
    task.window_key !== charge.scope.window
  )
    throw new Error('budget task scope conflict');
  const taskUsage = addUsage(usage(task), charge);
  const userUsage = addUsage(usage(user), charge);
  const result = admission(charge, policy, taskUsage, userUsage);
  const { allowed } = result;
  await tx`insert into budget_reservations(operation_id, fingerprint, task_key, user_key, parallelism, allowed, result)
    values (${charge.operationId}, ${fingerprint}, ${taskKey}, ${userKey}, ${charge.parallelism}, ${allowed}, ${tx.json(result)})`;
  if (allowed) {
    await updateAccount(tx, taskKey, taskUsage);
    await updateAccount(tx, userKey, userUsage);
  }
  const event = admissionEvent(result, policy);
  await tx`insert into budget_events(event_id, operation_id, payload) values (${event.eventId}, ${charge.operationId}, ${tx.json(event)})`;
  return result;
}
function usage(account: Account): BudgetUsage {
  return {
    estimatedCostMicros: Number(account.cost_micros),
    inferenceSteps: Number(account.inference_steps),
    parallelism: Number(account.parallelism),
  };
}
async function updateAccount(
  tx: postgres.TransactionSql,
  key: string,
  value: BudgetUsage,
): Promise<void> {
  await tx`update budget_accounts set cost_micros = ${value.estimatedCostMicros}, inference_steps = ${value.inferenceSteps}, parallelism = ${value.parallelism} where scope_key = ${key}`;
}
async function release(tx: postgres.TransactionSql, operationId: string): Promise<void> {
  const rows = await tx<
    {
      task_key: string;
      user_key: string;
      parallelism: string;
      allowed: boolean;
      released: boolean;
      result: Reservation;
    }[]
  >`select * from budget_reservations where operation_id = ${operationId} for update`;
  const row = rows.at(0);
  if (row === undefined) throw new Error('unknown budget operation');
  if (!row.allowed || row.released) return;
  await tx`select scope_key from budget_accounts where scope_key in (${row.task_key}, ${row.user_key}) order by scope_key for update`;
  await tx`update budget_accounts set parallelism = parallelism - ${row.parallelism} where scope_key in (${row.task_key}, ${row.user_key})`;
  await tx`update budget_reservations set released = true where operation_id = ${operationId}`;
  const evidence = await tx<
    { payload: BudgetEvent }[]
  >`select payload from budget_events where event_id = ${`reserve:${operationId}`}`;
  const event: BudgetEvent = {
    eventId: `release:${operationId}`,
    operationId,
    scope: row.result.charge.scope,
    kind: 'released',
    dimension: null,
    estimatedCostMicros: 0,
    inferenceSteps: 0,
    mode: evidence[0].payload.mode,
  };
  await tx`insert into budget_events(event_id, operation_id, payload) values (${event.eventId}, ${operationId}, ${tx.json(event)})`;
}

async function ensureAccounts(
  tx: postgres.TransactionSql,
  charge: BudgetCharge,
  taskKey: string,
  userKey: string,
): Promise<void> {
  for (const key of [taskKey, userKey].sort()) {
    await tx`insert into budget_accounts(scope_key, scope_kind, owner_subject, sponsor, window_key)
      values (${key}, ${key === taskKey ? 'task' : 'user'}, ${charge.scope.userSubject}, ${key === taskKey ? charge.scope.sponsor : null}, ${charge.scope.window})
      on conflict(scope_key) do nothing`;
  }
}
