import { dropOutboxSchema } from '../outbox/outbox.testkit.js';

import { EffectNotApplied } from './types.js';

import type { EffectGate, EffectProvider } from './effects.js';
import type { WorkerBudget } from './types.js';
import type { Sql } from 'postgres';

export const T0 = '2026-10-14T10:00:00.000Z';
export const T1 = '2026-10-14T10:01:00.000Z';
export const at = (ms: number): string => new Date(Date.parse(T1) + ms).toISOString();

export const budget: WorkerBudget = {
  retry: {
    maxAttempts: 4,
    minBackoffSeconds: 10,
    maxBackoffSeconds: 80,
    maxDoublings: 3,
    maxRetryDurationSeconds: 3600,
  },
  leaseMs: 30_000,
  random: () => 0.5,
};

export const digest = (n: number): string => n.toString(16).padStart(64, '0');
export const allowAll: EffectGate = { check: () => Promise.resolve() };

export async function dropWorkerSchema(sql: Sql): Promise<void> {
  await sql`drop table if exists delivery_rejections, execution_effects, execution_attempts, worker_executions cascade`;
  await sql`drop function if exists worker_executions_terminal_guard()`;
  await dropOutboxSchema(sql);
}

/** A provider whose remote state is observable, so tests can count writes that really happened. */
export function fakeProvider(
  mode: 'ok' | 'ack-lost' | 'rejected' = 'ok',
  readBack?: EffectProvider['readBack'],
) {
  const remote = { applied: 0, calls: 0 };
  const provider: EffectProvider = {
    write() {
      remote.calls += 1;
      if (mode === 'rejected')
        return Promise.reject(new EffectNotApplied('provider-rejected', true));
      remote.applied += 1;
      if (mode === 'ack-lost')
        return Promise.reject(new Error('deadline exceeded after remote commit'));
      return Promise.resolve({ resultRef: `ref-${remote.applied}` });
    },
    ...(readBack === undefined ? {} : { readBack }),
  };
  return { remote, provider };
}
