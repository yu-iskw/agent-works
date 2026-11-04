// OPS-04 load and fault harness. Synthetic workers only: no model call, no network beyond a
// local disposable Postgres container. Requires `pnpm build` (imports apps/api/dist).
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { startRestartablePostgres } from './lib/docker-pg.mjs';
import { computeMetrics } from './lib/metrics.mjs';

const RESULT_SCHEMA_VERSION = 1;
const LABEL = 'local-synthetic';

const dist = (path) => import(new URL(`../../apps/api/dist/${path}`, import.meta.url).href);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const nowIso = (ms) => new Date(ms).toISOString();

async function loadPostgres() {
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  return (await import(pathToFileURL(require.resolve('postgres')).href)).default;
}

export function validateSpec(spec) {
  const need = (cond, message) => {
    if (!cond) throw new Error(`invalid workload spec: ${message}`);
  };
  need(Number.isInteger(spec.schedules) && spec.schedules > 0, 'schedules');
  need(spec.burst.slots <= spec.schedules, 'burst.slots exceeds schedules');
  need(spec.executionsPerDay > 0 && spec.durationMs > 0 && spec.speed >= 1, 'rates');
  need(spec.activeSteps >= 1 && spec.stepsPerExecution >= 1, 'workers and steps');
  need(spec.timing.stepMs < spec.timing.leaseMs, 'stepMs must be below leaseMs');
  return spec;
}

/** Deterministic schedule population: a burst group due at one instant plus a staggered base. */
export function planSchedules(spec, vbaseMs) {
  const staggered = spec.schedules - spec.burst.slots;
  const periodSeconds = Math.max(
    60,
    Math.round(((staggered > 0 ? staggered : 1) * 86400) / spec.executionsPerDay),
  );
  const plan = [];
  for (let i = 0; i < spec.schedules; i += 1) {
    const burst = i < spec.burst.slots;
    const anchorMs = burst
      ? vbaseMs + spec.burst.atMs
      : vbaseMs +
        60_000 +
        Math.floor(((i - spec.burst.slots) / Math.max(1, staggered)) * periodSeconds * 1000);
    plan.push({
      burst,
      anchorMs,
      periodSeconds: burst ? Math.max(periodSeconds, 86400) : periodSeconds,
    });
  }
  return { plan, periodSeconds };
}

function expectedSlots(plan, vbaseMs, endMs) {
  let total = 0;
  for (const p of plan) {
    if (p.anchorMs > endMs) continue;
    total += Math.floor((endMs - p.anchorMs) / (p.periodSeconds * 1000)) + 1;
  }
  return total;
}

function machineShape(pgVersion, maxConnections) {
  const cpus = os.cpus();
  const git = (args) => {
    try {
      return execFileSync('git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const dockerVersion = (() => {
    try {
      return execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  })();
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? null,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    node: process.version,
    dockerServer: dockerVersion,
    postgres: pgVersion,
    postgresMaxConnections: maxConnections,
    loadavgAtStart: os.loadavg(),
    sourceSha: git(['rev-parse', 'HEAD']),
    sourceDirty: git(['status', '--porcelain']) !== '',
  };
}

async function runWorkload(spec, ctx) {
  const { sql, pg, mods, startedPerf } = ctx;
  const { timing, faults } = spec;
  const speed = spec.speed;
  const vbaseMs = Math.floor(Date.now() / 60_000) * 60_000;
  const vnow = () => vbaseMs + (performance.now() - startedPerf.value) * speed;
  const vnowIso = () => nowIso(vnow());
  const sleepV = (ms) => delay(Math.max(1, ms / speed));
  const sleepUntilV = (offsetMs) => delay(Math.max(0, (vbaseMs + offsetMs - vnow()) / speed));

  const budget = {
    retry: spec.retry,
    leaseMs: timing.leaseMs,
    random: Math.random,
  };
  const errors = {};
  const note = (where, error) => {
    const key = `${where}:${error?.code ?? error?.name ?? 'error'}:${String(error?.message).slice(0, 60)}`;
    errors[key] = (errors[key] ?? 0) + 1;
  };
  const guarded = async (where, fn) => {
    try {
      return await fn();
    } catch (error) {
      note(where, error);
      return undefined;
    }
  };

  const state = {
    stopClaims: false,
    stopAll: false,
    queue: { kind: 'ok', dropRate: 0 },
    provider: 'ok',
    lastDispatchOkPerf: 0,
  };
  const remote = {};
  const deaths = [];
  const revocations = [];
  const faultLog = [];
  const accepted = new Set();
  let claimedRuns = 0;
  let publishedMessages = 0;
  let droppedMessages = 0;
  let duplicateDeliveries = 0;

  const { claimDueWithOutbox } = mods.claim;
  const { createOutboxPublisher, QueuePublishError } = mods.publisher;
  const { handoff, cancelExecution } = mods.store;
  const { createExecutionWorker } = mods.runner;
  const { EffectDenied, EffectNotApplied } = mods.types;

  // Schedules are created before the virtual clock starts.
  const { plan, periodSeconds } = planSchedules(spec, vbaseMs);
  const port = mods.rowClaim.createRowClaimSchedulePort(sql);
  let cursor = 0;
  const createdAt = nowIso(vbaseMs);
  const expiresAt = nowIso(vbaseMs + 400 * 86_400_000);
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (cursor < plan.length) {
        const p = plan[cursor];
        cursor += 1;
        await port.create(
          mods.fixtures.scheduleFixture({
            id: randomUUID(),
            timing: { kind: 'interval', everySeconds: p.periodSeconds, anchor: nowIso(p.anchorMs) },
            expiresAt,
          }),
          'alice',
          createdAt,
        );
      }
    }),
  );
  startedPerf.value = performance.now();

  const delivery = async (message, tries = 0) => {
    if (state.stopAll) return;
    const executionId = JSON.parse(message.body).executionId;
    try {
      await handoff(sql, { executionId, now: vnowIso(), budget });
    } catch (error) {
      note('delivery', error);
      if (tries < 5 && !state.stopAll) setTimeout(() => void delivery(message, tries + 1), 1000);
    }
  };
  const queue = {
    publish(message) {
      if (state.queue.kind === 'unavailable')
        return Promise.reject(new QueuePublishError('queue-unavailable', true));
      if (accepted.has(message.transportName)) return Promise.resolve('exists');
      accepted.add(message.transportName);
      publishedMessages += 1;
      if (state.queue.kind === 'drop' && Math.random() < state.queue.dropRate) {
        droppedMessages += 1;
        return Promise.resolve('created');
      }
      setTimeout(() => void delivery(message), timing.queueDelayRealMs);
      if (Math.random() < (faults.duplicateDeliveryRate ?? 0)) {
        duplicateDeliveries += 1;
        setTimeout(() => void delivery(message), timing.queueDelayRealMs * 2);
      }
      return Promise.resolve('created');
    },
  };
  const publisher = createOutboxPublisher(sql, queue, {
    owner: 'publisher-1',
    leaseMs: 30_000,
    maxAttempts: 8,
    baseBackoffMs: 5000,
    maxBackoffMs: 60_000,
  });

  const gate = {
    async check(executionId) {
      const rows = await sql`select 1 from ops04_revocations where execution_id = ${executionId}`;
      if (rows.length === 0) return;
      const rev = revocations.find((r) => r.executionId === executionId && r.observedMs === null);
      if (rev) rev.observedMs = vnow();
      throw new EffectDenied('revoked');
    },
  };

  const workers = [];
  let workerSeq = 0;
  function spawnWorker(slot) {
    workerSeq += 1;
    const w = { id: `w${slot}-${workerSeq}`, busy: false, dieNext: null, dead: false };
    let onDeath;
    const deathSignal = new Promise((resolve) => {
      onDeath = resolve;
    });
    const die = async (claim) => {
      w.dieNext = null;
      let leaseUntilMs = vnow() + timing.leaseMs;
      const row = await guarded(
        'death-lease-read',
        () =>
          sql`select extract(epoch from lease_until) * 1000 as ms from worker_executions where execution_id = ${claim.executionId}`,
      );
      if (row?.[0]?.ms) leaseUntilMs = Number(row[0].ms);
      deaths.push({
        executionId: claim.executionId,
        attempt: claim.attempt,
        phase: w.deathPhase,
        diedMs: vnow(),
        leaseUntilMs,
        releasedMs: null,
        resumedMs: null,
      });
      w.dead = true;
      onDeath();
      await new Promise(() => {});
    };
    const handler = async ({ claim, checkpoint, renew, saveCheckpoint, effect }) => {
      w.busy = true;
      const first = checkpoint.ref === null ? 0 : Number(checkpoint.ref);
      for (let i = first; i < spec.stepsPerExecution; i += 1) {
        await sleepV(timing.stepMs);
        if (w.dieNext === 'between-steps') await die(claim);
        await renew();
        const key = `ops04:${sha(claim.executionId).slice(0, 40)}:s${i}`;
        await effect(
          { key, payloadDigest: sha(key), target: 'synthetic-provider' },
          {
            async write() {
              if (w.dieNext === 'in-effect') {
                if (Math.random() < 0.5) remote[key] = (remote[key] ?? 0) + 1;
                await die(claim);
              }
              if (state.provider === 'unavailable')
                throw new EffectNotApplied('provider-unavailable', true);
              remote[key] = (remote[key] ?? 0) + 1;
              if (state.provider === 'ack-lost') throw new Error('ack lost after remote commit');
              return { resultRef: 'ok' };
            },
          },
        );
        await saveCheckpoint(String(i + 1));
      }
      return { resultDigest: sha(claim.executionId) };
    };
    const worker = createExecutionWorker({ sql, owner: w.id, budget, gate, handler, now: vnowIso });
    w.loop = (async () => {
      while (!state.stopAll && !w.dead) {
        const outcome = await Promise.race([
          worker.runOnce().then(
            (r) => r,
            (error) => {
              note('worker', error);
              return { kind: 'error' };
            },
          ),
          deathSignal.then(() => ({ kind: 'dead' })),
        ]);
        w.busy = false;
        if (outcome.kind === 'dead') break;
        if (outcome.kind === 'idle' || outcome.kind === 'error')
          await delay(timing.workerPollRealMs);
      }
      if (w.dead && !state.stopAll) {
        await sleepV(timing.workerColdStartMs);
        if (!state.stopAll) spawnWorker(slot);
      }
    })();
    workers.push(w);
    return w;
  }
  for (let slot = 0; slot < spec.activeSteps; slot += 1) spawnWorker(slot);

  const background = [];
  if (process.env.OPS04_PROGRESS === '1') {
    const timer = setInterval(() => {
      process.stderr.write(
        `[ops-04] virtual=${vnowIso()} claimed=${claimedRuns} errors=${JSON.stringify(errors)}\n`,
      );
    }, 5000);
    timer.unref();
  }
  const every = (where, realMs, fn, isClaim = false) =>
    background.push(
      (async () => {
        while (!state.stopAll && !(isClaim && state.stopClaims)) {
          await guarded(where, fn);
          await delay(realMs);
        }
      })(),
    );
  every(
    'dispatcher',
    timing.dispatchTickRealMs,
    async () => {
      for (;;) {
        const runs = await claimDueWithOutbox(
          sql,
          {},
          {
            now: vnowIso(),
            limit: 500,
            owner: 'dispatcher-1',
            leaseMs: Math.min(timing.leaseMs, 300_000),
          },
        );
        claimedRuns += runs.length;
        state.lastDispatchOkPerf = performance.now();
        if (runs.length < 500) break;
      }
    },
    true,
  );
  every('publisher', timing.dispatchTickRealMs, async () => {
    for (;;) {
      const r = await publisher.publishBatch({ now: vnowIso(), limit: 100 });
      if (r.published + r.retried + r.abandoned + r.superseded < 100) break;
    }
  });
  every('sweeper', Math.max(20, timing.sweepEveryMs / speed), () =>
    mods.sweeper.sweep(sql, {
      now: vnowIso(),
      budget,
      redriveAfterMs: timing.redriveAfterMs,
      maxRedrives: timing.maxRedrives,
      limit: 500,
    }),
  );
  every('reconciler', Math.max(20, timing.reconcileEveryMs / speed), async () => {
    const rows =
      await sql`select effect_key from execution_effects where state = 'uncertain' limit 200`;
    for (const { effect_key: key } of rows) {
      await mods.effects.resolveEffect(sql, {
        effectKey: key,
        resolution: (remote[key] ?? 0) > 0 ? 'applied' : 'not-applied',
        resolvedBy: 'ops-04-harness-ground-truth',
        evidenceRef: 'harness-remote-ledger',
        now: vnowIso(),
      });
    }
  });
  every('control', Math.max(20, timing.controlPollMs / speed), async () => {
    const rows = await sql`select r.execution_id from ops04_revocations r
      join worker_executions w on w.execution_id = r.execution_id where w.state = 'queued'`;
    for (const { execution_id: id } of rows) {
      const res = await cancelExecution(sql, { executionId: id, now: vnowIso(), budget });
      const rev = revocations.find((r) => r.executionId === id && r.observedMs === null);
      if (res === 'cancelled' && rev) rev.observedMs = vnow();
    }
  });

  // Fault injectors, each scheduled on the virtual clock.
  const injectors = [];
  const dc = faults.workerDeaths;
  if (dc) {
    injectors.push(
      (async () => {
        for (let k = 0; k < dc.count && !state.stopAll; k += 1) {
          await sleepUntilV(dc.startMs + ((dc.endMs - dc.startMs) * k) / dc.count);
          for (let tries = 0; tries < 200 && !state.stopAll; tries += 1) {
            const target = workers.find((w) => w.busy && !w.dead && w.dieNext === null);
            if (target) {
              target.deathPhase = k % 2 === 0 ? 'in-effect' : 'between-steps';
              target.dieNext = target.deathPhase;
              break;
            }
            await delay(50);
          }
        }
      })(),
    );
  }
  for (const w of faults.queueWindows ?? []) {
    injectors.push(
      (async () => {
        await sleepUntilV(w.atMs);
        state.queue = { kind: w.mode, dropRate: w.dropRate ?? 1 };
        faultLog.push({
          kind: `queue-${w.mode}`,
          startedMs: vnow(),
          plannedDurationMs: w.durationMs,
        });
        await sleepV(w.durationMs);
        state.queue = { kind: 'ok', dropRate: 0 };
        faultLog.at(-1).endedMs = vnow();
      })(),
    );
  }
  for (const w of faults.providerOutages ?? []) {
    injectors.push(
      (async () => {
        await sleepUntilV(w.atMs);
        state.provider = w.mode;
        faultLog.push({
          kind: `provider-${w.mode}`,
          startedMs: vnow(),
          plannedDurationMs: w.durationMs,
        });
        await sleepV(w.durationMs);
        state.provider = 'ok';
        faultLog.at(-1).endedMs = vnow();
      })(),
    );
  }
  for (const r of faults.dbRestarts ?? []) {
    injectors.push(
      (async () => {
        await sleepUntilV(r.atMs);
        const startedMs = vnow();
        const t0 = performance.now();
        const entry = { kind: 'db-crash-restart', startedMs, downRealMs: r.downRealMs };
        faultLog.push(entry);
        await pg.crashAndRestart(r.downRealMs);
        entry.databaseAnswersAfterRealMs = Math.round(performance.now() - t0);
        const resumeFrom = performance.now();
        while (state.lastDispatchOkPerf < resumeFrom && !state.stopAll) await delay(25);
        entry.dispatcherRecoveredAfterRealMs = Math.round(performance.now() - t0);
        entry.endedMs = vnow();
      })(),
    );
  }
  const rc = faults.revocations;
  if (rc) {
    injectors.push(
      (async () => {
        for (let k = 0; k < rc.count && !state.stopAll; k += 1) {
          await sleepUntilV(rc.startMs + ((rc.endMs - rc.startMs) * k) / rc.count);
          await guarded('revoke', async () => {
            const [row] = await sql`select execution_id, state from worker_executions
              where state in ('queued','running')
              and not exists (select 1 from ops04_revocations v where v.execution_id = worker_executions.execution_id)
            order by random() limit 1`;
            if (!row) return;
            const committedMs = vnow();
            await sql`insert into ops04_revocations(execution_id, committed_at, kind)
              values(${row.execution_id}, ${nowIso(committedMs)}, ${row.state})`;
            revocations.push({
              executionId: row.execution_id,
              kind: row.state,
              committedMs,
              observedMs: null,
            });
          });
        }
      })(),
    );
  }

  // Soak, then stop new claims and drain until nothing is in flight.
  await sleepUntilV(spec.durationMs);
  state.stopClaims = true;
  await Promise.all(injectors);
  const drainDeadline = vnow() + timing.drainMaxMs;
  let drained = false;
  while (vnow() < drainDeadline) {
    const rows = await guarded(
      'drain',
      () =>
        sql`select
        (select count(*) from worker_executions where state in ('queued','running','awaiting-reconciliation'))::int
        + (select count(*) from schedule_runs r where r.status not in ('denied','cancelled','completed')
            and not exists (select 1 from worker_executions w where w.execution_id = r.id))::int as open`,
    );
    if (rows?.[0]?.open === 0) {
      drained = true;
      break;
    }
    await delay(250);
  }
  const endedVirtualMs = vnow();
  state.stopAll = true;
  await Promise.all(background);
  await Promise.all(workers.filter((w) => !w.dead).map((w) => w.loop));
  await delay(300);

  return {
    vbaseMs,
    plan,
    periodSeconds,
    errors,
    deaths,
    revocations,
    faultLog,
    remote,
    drained,
    endedVirtualMs,
    counters: { claimedRuns, publishedMessages, droppedMessages, duplicateDeliveries },
  };
}

async function collect(sql, run, spec) {
  const rows = await sql`select r.id, extract(epoch from r.fire_at) * 1000 as fire_ms,
      w.state, w.quarantine_reason,
      (select extract(epoch from min(a.started_at)) * 1000 from execution_attempts a
        where a.execution_id = r.id and a.attempt = 1) as first_start_ms,
      extract(epoch from w.updated_at) * 1000 as updated_ms,
      exists (select 1 from ops04_revocations v where v.execution_id = r.id) as revoked
    from schedule_runs r left join worker_executions w on w.execution_id = r.id`;
  const executions = rows.map((r) => ({
    id: r.id,
    fireMs: Number(r.fire_ms),
    firstStartMs: r.first_start_ms === null ? null : Number(r.first_start_ms),
    state: r.state,
    quarantineReason: r.quarantine_reason,
    doneMs: r.state === 'succeeded' ? Number(r.updated_ms) : null,
    revoked: r.revoked,
  }));
  const byId = new Map(executions.map((e) => [e.id, e]));
  for (const d of run.deaths) {
    const [rel] = await sql`select extract(epoch from ended_at) * 1000 as ms from execution_attempts
      where execution_id = ${d.executionId} and attempt = ${d.attempt} and outcome = 'lease-expired'`;
    const [next] =
      await sql`select extract(epoch from started_at) * 1000 as ms from execution_attempts
      where execution_id = ${d.executionId} and attempt > ${d.attempt} order by attempt limit 1`;
    d.releasedMs = rel ? Number(rel.ms) : null;
    d.resumedMs = next ? Number(next.ms) : null;
  }
  const revocations = run.revocations.filter((r) => {
    if (r.observedMs !== null) return true;
    const e = byId.get(r.executionId);
    const moot = e && ['succeeded', 'failed', 'quarantined'].includes(e.state);
    if (moot) r.moot = true;
    return !moot;
  });
  const mootRevocations = run.revocations.length - revocations.length;
  const effects = (
    await sql`select effect_key, state, resolution, writes from execution_effects`
  ).map((e) => ({ key: e.effect_key, state: e.state, resolution: e.resolution, writes: e.writes }));
  const [{ n: duplicateRuns }] = await sql`select count(*)::int as n from (
    select schedule_id, fire_at from schedule_runs group by 1, 2 having count(*) > 1) d`;
  const [outbox] = await sql`select count(*) filter (where state = 'pending')::int as pending,
    count(*) filter (where state = 'abandoned')::int as abandoned,
    count(*) filter (where state = 'published')::int as published from dispatch_outbox`;
  return {
    executions,
    effects,
    duplicateRuns,
    outbox,
    revocations,
    mootRevocations,
    obs: {
      speed: spec.speed,
      schedules: spec.schedules,
      stepsPerExecution: spec.stepsPerExecution,
      executions,
      deaths: run.deaths,
      revocations,
      remoteApplied: run.remote,
      effects,
      duplicateRuns,
    },
  };
}

function explain(spec, run, metrics) {
  const t = spec.timing;
  const floorReal =
    t.dispatchTickRealMs + t.dispatchTickRealMs + t.queueDelayRealMs + t.workerPollRealMs;
  const workerExecPerSecVirtual = spec.activeSteps / ((spec.stepsPerExecution * t.stepMs) / 1000);
  return {
    dueToStart: {
      pipelineFloorRealMs: floorReal,
      pipelineFloorVirtualMs: floorReal * spec.speed,
      limiter:
        `Median is bounded below by dispatcher tick + publisher tick + queue delay + worker poll (${floorReal} ms real, ` +
        `${floorReal * spec.speed} ms virtual at ${spec.speed}x). The tail is bounded by worker capacity during the ` +
        `${spec.burst.slots}-slot burst (about ${(spec.burst.slots / workerExecPerSecVirtual).toFixed(0)} s to drain at ` +
        `${workerExecPerSecVirtual.toFixed(1)} executions/s virtual), by redriveAfterMs=${t.redriveAfterMs} ms for lost queue messages, ` +
        `and by fault windows (DB crash, provider and queue outages).`,
    },
    workerDeathRecovery: {
      limiter:
        `Lease expiry to release is bounded by sweepEveryMs=${t.sweepEveryMs} ms virtual plus the real sweep transaction cost times ${spec.speed}. ` +
        `Resume additionally waits for retry backoff (${spec.retry.minBackoffSeconds}-${spec.retry.maxBackoffSeconds} s) and, for in-effect deaths, reconciliation every ${t.reconcileEveryMs} ms.`,
    },
    stopRevoke: {
      limiter: `Queued observation is bounded by controlPollMs=${t.controlPollMs} ms. Running observation is bounded by the next gate check, one step (${t.stepMs} ms) away at most.`,
    },
    terminalSuccess: {
      limiter: `Failures come from retry exhaustion or time budget (retry maxAttempts=${spec.retry.maxAttempts}) during outages; unreconciled effects are counted separately, not as success.`,
    },
    compression: {
      speed: spec.speed,
      note: 'Virtual time = real elapsed time times speed. Real costs that do not shrink with the schedule are inflated by this factor in virtual-ms numbers.',
    },
    integrityCounts: metrics.metrics.integrity.loss,
  };
}

/** Runs one campaign locally and returns the versioned result object. */
export async function runHarness(spec, options = {}) {
  validateSpec(spec);
  const postgres = await loadPostgres();
  const open = (url) =>
    postgres(url, {
      max: spec.dbPoolMax ?? 20,
      connect_timeout: 3,
      ssl: false,
      fetch_types: false,
      onnotice: () => {},
    });
  const mods = {
    claim: await dist('outbox/claim-with-outbox.js'),
    publisher: await dist('outbox/publisher.js'),
    store: await dist('worker/store.js'),
    runner: await dist('worker/runner.js'),
    types: await dist('worker/types.js'),
    sweeper: await dist('worker/sweeper.js'),
    effects: await dist('worker/effects.js'),
    rowClaim: await dist('ports/schedule-row-claim.js'),
    cutover: await dist('ports/schedule-row-claim-cutover.js'),
    migration: await dist('worker/migration.js'),
    fixtures: await dist('scheduling/test-fixtures.js'),
  };
  const startedAt = new Date().toISOString();
  const pg = await startRestartablePostgres(open);
  const sql = open(pg.url);
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  try {
    await mods.cutover.rowClaimReady(sql);
    await mods.cutover.switchSchedulerOwner(sql, 'legacy', 'rowclaim');
    await mods.migration.workerReady(sql);
    await sql`create table ops04_revocations (
      execution_id text primary key, committed_at timestamptz not null, kind text not null)`;
    const [{ version }] = await sql`select version()`;
    const [{ max_connections: maxConnections }] = await sql`show max_connections`;
    const machine = machineShape(version, Number(maxConnections));
    const cpuBefore = process.cpuUsage();
    histogram.enable();
    const run = await runWorkload(spec, {
      sql,
      pg,
      mods,
      startedPerf: { value: 0 },
    });
    histogram.disable();
    const cpu = process.cpuUsage(cpuBefore);
    const data = await collect(sql, run, spec);
    const computed = computeMetrics(data.obs);
    const states = {};
    for (const e of data.executions)
      states[e.state ?? 'no-worker-row'] = (states[e.state ?? 'no-worker-row'] ?? 0) + 1;
    const slots = expectedSlots(run.plan, run.vbaseMs, run.vbaseMs + spec.durationMs);
    return {
      schemaVersion: RESULT_SCHEMA_VERSION,
      label: LABEL,
      claim: 'Local synthetic harness result. Not a live, cloud, or model-backed measurement.',
      modelCalls: 0,
      runId: options.runId ?? `ops04-${startedAt.replace(/[:.]/g, '-')}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      specName: spec.name,
      spec,
      machine,
      config: {
        scheduleIntervalSeconds: run.periodSeconds,
        workers: spec.activeSteps,
        dbPoolMax: spec.dbPoolMax ?? 20,
        virtualBaseIso: nowIso(run.vbaseMs),
        virtualEndIso: nowIso(run.endedVirtualMs),
        drained: run.drained,
      },
      sampleSizes: computed.sizes,
      executionStates: states,
      slots: { expectedByFormula: slots, claimedRuns: data.executions.length },
      metrics: computed.metrics,
      evaluation: computed.evaluation,
      outbox: data.outbox,
      revocationsMoot: data.mootRevocations,
      faults: run.faultLog,
      counters: run.counters,
      checks: {
        loopErrors: run.errors,
        remoteWritesTotal: Object.values(run.remote).reduce((a, b) => a + b, 0),
        executionsReachedSucceeded: states.succeeded ?? 0,
        runCount: 1,
        repeatability:
          'Single run; no run-to-run range. Repeat before treating any number as stable.',
      },
      harnessProcess: {
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        eventLoopDelayP99Ms: Math.round(histogram.percentile(99) / 1e6),
        note: 'The harness runs workers, dispatcher and fault injection in one Node process; high event-loop delay means the load generator, not the system, set the number.',
      },
      explain: explain(spec, run, computed),
    };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
    await pg.stop();
  }
}
