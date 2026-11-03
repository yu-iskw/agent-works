import { ticketCreateManifest } from '@agent-works/domain';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';

import { createGrantLifecycle } from './lifecycle.js';
import { createMemoryGrantStore } from './memory-store.js';
import { applyStandingGrantMigration } from './migration.js';
import { createPostgresGrantStore } from './postgres-store.js';

import type { GrantActivation, GrantActor, RootGrantRequest } from './lifecycle.js';
import type { GrantStore } from './store.js';
import type { Sql } from 'postgres';

export const TICKET_ACTION = ticketCreateManifest.spec.permissions.workloadCapability;
const START = '2026-11-03T00:00:00.000Z';
const DAY_MS = 86_400_000;

export const owner: GrantActor = { kind: 'human', sub: 'local-test:owner', role: 'owner' };
export const admin: GrantActor = { kind: 'human', sub: 'local-test:admin', role: 'admin' };
export const member: GrantActor = { kind: 'human', sub: 'local-test:alice', role: 'member' };
export const coordinator: GrantActor = { kind: 'bot', botId: 'coordinator', botVersion: 1 };
const READ = 'drive.read';
const ANALYST = 'research-analyst';
export const analyst: GrantActor = { kind: 'bot', botId: ANALYST, botVersion: 3 };

/** Placeholder limits only; real values need the approved O04 policy. */
export const budget = {
  approval: 'PLACEHOLDER',
  estimatedCostMicros: 1_000_000,
  inferenceSteps: 40,
  parallelism: 4,
} as const;

export const schedule = {
  allowed: true,
  minIntervalSeconds: 3600,
  maxLifetimeSeconds: 86_400,
  maxActiveRoutines: 3,
};

export const off = {
  allowed: false,
  minIntervalSeconds: 0,
  maxLifetimeSeconds: 0,
  maxActiveRoutines: 0,
};

export function rootRequest(patch: Partial<RootGrantRequest> = {}): RootGrantRequest {
  return {
    sponsor: 'alice',
    grantee: { botId: 'coordinator', botVersion: 1 },
    permissions: [
      { action: READ, resource: 'drive_research' },
      { action: READ, resource: 'drive_context' },
      { action: TICKET_ACTION, resource: 'PROJ' },
    ],
    expiresAt: new Date(Date.parse(START) + 30 * DAY_MS).toISOString(),
    maxDepth: 2,
    schedule,
    limits: { maxConcurrency: 4, maxFanOut: 3, budget },
    ...patch,
  };
}

export function childRequest(patch: Record<string, unknown> = {}) {
  return {
    grantee: { botId: ANALYST, botVersion: 3 },
    permissions: [{ action: READ, resource: 'drive_research' }],
    expiresAt: new Date(Date.parse(START) + 10 * DAY_MS).toISOString(),
    maxDepth: 2,
    schedule: off,
    limits: {
      maxConcurrency: 2,
      maxFanOut: 2,
      budget: { ...budget, estimatedCostMicros: 250_000 },
    },
    ...patch,
  };
}

let grantCounter = 0;

export type Clock = { now: Date; advanceDays(days: number): void };

export function clock(): Clock {
  const state: Clock = {
    now: new Date(START),
    advanceDays(days) {
      state.now = new Date(state.now.getTime() + days * DAY_MS);
    },
  };
  return state;
}

export function lifecycleOver(
  store: GrantStore,
  time: Clock,
  activation: GrantActivation = { enabled: true, o04ApprovalRef: 'O04-test' },
  newId: () => string = () => `grant-${(grantCounter += 1)}`,
) {
  return createGrantLifecycle({
    store,
    activation,
    now: () => time.now,
    newId,
    policyRevision: 'policy-r1',
  });
}

export type StoreCase = { readonly name: string; make(): GrantStore };

/**
 * Both stores behind one port. Postgres runs against a disposable database and is emptied before
 * each test. Returns the cases plus the raw connection for Postgres-only assertions.
 */
export function useStores(): { cases: readonly StoreCase[]; sql(): Sql } {
  let sql: Sql | undefined;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const database = await startDisposablePostgres();
    sql = openSql(database.url);
    await applyStandingGrantMigration(sql);
    close = async () => {
      await sql?.end({ timeout: 1 });
      await database.stop();
    };
  }, 60_000);
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    if (sql === undefined) throw new Error('postgres');
    await sql`truncate table tw_standing_grants, tw_standing_grant_audit`;
  });
  const connection = (): Sql => {
    if (sql === undefined) throw new Error('postgres');
    return sql;
  };
  return {
    cases: [
      { name: 'memory', make: createMemoryGrantStore },
      { name: 'postgres', make: () => createPostgresGrantStore(connection()) },
    ],
    sql: connection,
  };
}
