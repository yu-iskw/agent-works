import { claimDue } from '../ports/schedule-row-claim.js';

import { outboxReady } from './migration.js';
import { insertOutbox } from './store.js';

import type { RowClaimOptions } from '../ports/schedule-row-claim-store.js';
import type { ClaimDueInput } from '../ports/schedule-row-claim.js';
import type { ScheduleRun } from '@agent-works/domain';
import type postgres from 'postgres';

/**
 * Claim due schedules and write one outbox row per newly claimed run, all in the claim
 * transaction that advances the cursor. If the outbox insert fails, the run and the cursor
 * roll back with it. Nothing remote happens here; the publisher sends after commit.
 * Applies 0027 first if needed.
 */
export async function claimDueWithOutbox(
  sql: postgres.Sql,
  options: RowClaimOptions,
  input: ClaimDueInput,
): Promise<ScheduleRun[]> {
  await outboxReady(sql);
  return claimDue(sql, options, input, (tx, run) => insertOutbox(tx, run, input.now));
}
