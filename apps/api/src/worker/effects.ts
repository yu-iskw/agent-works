import { workerReady } from './migration.js';
import { EffectKeyConflict, EffectNotApplied, StaleWorker } from './types.js';

import type { Claim } from './types.js';
import type { Tx } from '../ports/schedule-row-claim-store.js';
import type postgres from 'postgres';

export type EffectSpec = {
  /** Stable per logical effect: the same key on every retry, redelivery and takeover. */
  readonly key: string;
  readonly payloadDigest: string;
  readonly target: string;
};

export type EffectProvider = {
  /**
   * The provider write. Throw `EffectNotApplied` only when the provider definitely did not apply
   * it. Any other throw (timeout, lost response, 5xx) is treated as possibly applied.
   */
  write(): Promise<{ readonly resultRef: string | null }>;
  /** Optional provider read of whether the write took effect. Anything inconclusive stays uncertain. */
  readBack?(): Promise<'applied' | 'not-applied' | 'unknown'>;
};

export type EffectOutcome =
  | { readonly kind: 'done'; readonly source: 'written' | 'recorded' | 'read-back' }
  | { readonly kind: 'uncertain' };

/** Recheck of current grant, suspension and approval before each effect. Throws EffectDenied or a retryable failure. */
export type EffectGate = {
  check(executionId: string, effect: EffectSpec): Promise<void>;
};

type EffectRow = {
  execution_id: string;
  payload_digest: string;
  provider_target: string;
  state: 'pending' | 'succeeded' | 'uncertain' | 'reconciled' | 'failed';
  resolution: 'applied' | 'not-applied' | null;
};

type Begin = 'write' | 'recorded' | 'unresolved';

async function begin(tx: Tx, claim: Claim, spec: EffectSpec, now: string): Promise<Begin> {
  const held = await tx`select 1 from worker_executions
    where execution_id = ${claim.executionId} and fence = ${claim.fence} and state = 'running' for share`;
  if (held.length === 0) throw new StaleWorker(claim.executionId);
  const rows = await tx<
    EffectRow[]
  >`select execution_id, payload_digest, provider_target, state, resolution
    from execution_effects where effect_key = ${spec.key} for update`;
  if (rows.length === 0) {
    await tx`insert into execution_effects(effect_key, execution_id, payload_digest, provider_target, state, created_at, updated_at)
      values(${spec.key}, ${claim.executionId}, ${spec.payloadDigest}, ${spec.target}, 'pending', ${now}, ${now})`;
    return 'write';
  }
  const row = rows[0];
  if (
    row.execution_id !== claim.executionId ||
    row.payload_digest !== spec.payloadDigest ||
    row.provider_target !== spec.target
  ) {
    throw new EffectKeyConflict(spec.key);
  }
  if (row.state === 'succeeded' || (row.state === 'reconciled' && row.resolution === 'applied')) {
    return 'recorded';
  }
  if (row.state === 'failed' || row.state === 'reconciled') {
    await tx`update execution_effects set state = 'pending', resolution = null, writes = writes + 1, updated_at = ${now}
      where effect_key = ${spec.key}`;
    return 'write';
  }
  // A leftover pending row means a previous worker may have issued the write and died.
  if (row.state === 'pending') {
    await tx`update execution_effects set state = 'uncertain', updated_at = ${now} where effect_key = ${spec.key}`;
  }
  return 'unresolved';
}

async function settle(
  sql: postgres.Sql,
  key: string,
  patch: { state: 'succeeded' | 'uncertain' | 'failed'; resultRef?: string | null; now: string },
): Promise<void> {
  await sql`update execution_effects set state = ${patch.state}, result_ref = ${patch.resultRef ?? null}, updated_at = ${patch.now}
    where effect_key = ${key} and state = 'pending'`;
}

async function reconcileByReadBack(
  sql: postgres.Sql,
  key: string,
  resolution: 'applied' | 'not-applied',
  now: string,
): Promise<void> {
  await sql`update execution_effects set state = 'reconciled', resolution = ${resolution},
      resolved_by = 'read-back', updated_at = ${now}
    where effect_key = ${key} and state = 'uncertain'`;
}

/**
 * Runs one external effect with the ledger around it. Order: gate recheck, fenced begin (row
 * committed as `pending` before the call), provider write with no transaction open, outcome.
 * A write whose response is lost is `uncertain`, and an uncertain or orphaned-pending effect
 * is never written again: only read-back or `resolveEffect` releases it. The outcome is
 * recorded even if the fence was lost meanwhile, because it is evidence about the provider.
 */
export function createEffectRunner(
  sql: postgres.Sql,
  gate: EffectGate,
  now: () => string,
): (claim: Claim, spec: EffectSpec, provider: EffectProvider) => Promise<EffectOutcome> {
  async function attempt(
    claim: Claim,
    spec: EffectSpec,
    provider: EffectProvider,
    allowReadBack: boolean,
  ): Promise<EffectOutcome> {
    await workerReady(sql);
    await gate.check(claim.executionId, spec);
    const step = await sql.begin((tx) => begin(tx, claim, spec, now()));
    if (step === 'recorded') return { kind: 'done', source: 'recorded' };
    if (step === 'unresolved') {
      if (!allowReadBack || provider.readBack === undefined) return { kind: 'uncertain' };
      const seen = await provider.readBack().catch(() => 'unknown' as const);
      if (seen === 'unknown') return { kind: 'uncertain' };
      await reconcileByReadBack(sql, spec.key, seen, now());
      if (seen === 'applied') return { kind: 'done', source: 'read-back' };
      return attempt(claim, spec, provider, false);
    }
    try {
      const written = await provider.write();
      await settle(sql, spec.key, { state: 'succeeded', resultRef: written.resultRef, now: now() });
      return { kind: 'done', source: 'written' };
    } catch (error) {
      if (error instanceof EffectNotApplied) {
        await settle(sql, spec.key, { state: 'failed', now: now() });
        throw error;
      }
      await settle(sql, spec.key, { state: 'uncertain', now: now() });
      return { kind: 'uncertain' };
    }
  }
  return (claim, spec, provider) => attempt(claim, spec, provider, true);
}

/**
 * Manual or read-back resolution of an uncertain effect. When the execution was parked for it
 * and nothing else is uncertain, the execution is requeued with one extra attempt of headroom.
 */
export async function resolveEffect(
  sql: postgres.Sql,
  input: {
    effectKey: string;
    resolution: 'applied' | 'not-applied';
    resolvedBy: string;
    evidenceRef: string | null;
    now: string;
  },
): Promise<'resolved' | 'not-uncertain'> {
  await workerReady(sql);
  return sql.begin(async (tx) => {
    const rows = await tx<
      { execution_id: string }[]
    >`select execution_id from execution_effects where effect_key = ${input.effectKey} and state = 'uncertain' for update`;
    if (rows.length === 0) return 'not-uncertain';
    const executionId = rows[0].execution_id;
    await tx`update execution_effects set state = 'reconciled', resolution = ${input.resolution},
        resolved_by = ${input.resolvedBy}, evidence_ref = ${input.evidenceRef}, updated_at = ${input.now}
      where effect_key = ${input.effectKey}`;
    await tx`update worker_executions set state = 'queued', next_attempt_at = ${input.now},
        max_attempts = greatest(max_attempts, attempts + 1), updated_at = ${input.now}
      where execution_id = ${executionId} and state = 'awaiting-reconciliation'
        and not exists (select 1 from execution_effects where execution_id = ${executionId} and state = 'uncertain')`;
    return 'resolved';
  });
}
