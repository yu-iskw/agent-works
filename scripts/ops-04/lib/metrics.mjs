import { summarize } from './stats.mjs';

/** Provisional targets copied from ACCEPTANCE P02..P05. They are proposals, not approved values. */
export const PROVISIONAL_TARGETS = Object.freeze({
  P02: { p95Ms: 120_000, p99Ms: 300_000 },
  P03: { minSuccessRate: 0.99, withinMs: 600_000, minSteps: 5000 },
  P04: { maxRecoveryMs: 120_000, minDeaths: 100 },
  P05: { maxObservationMs: 60_000 },
});

const TERMINAL_FAILURE = new Set(['failed', 'quarantined']);

const toReal = (valuesMs, speed) => valuesMs.map((v) => v / speed);

/** Distribution in virtual ms (what the schedule semantics saw) and real ms (wall clock). */
function dual(valuesMs, speed) {
  return { virtualMs: summarize(valuesMs), realMs: summarize(toReal(valuesMs, speed)) };
}

function dueToStart(executions, speed) {
  const started = executions.filter((e) => e.firstStartMs !== null);
  const latencies = started.map((e) => Math.max(0, e.firstStartMs - e.fireMs));
  const cancelledBeforeStart = executions.filter(
    (e) => e.firstStartMs === null && (e.state === 'cancelled' || e.state === 'denied'),
  ).length;
  const droppedNeverStarted = executions.filter(
    (e) => e.firstStartMs === null && e.state !== 'cancelled' && e.state !== 'denied',
  ).length;
  return { ...dual(latencies, speed), cancelledBeforeStart, droppedNeverStarted };
}

function terminalSuccess(executions, stepsPerExecution) {
  const intentional = executions.filter(
    (e) => e.revoked && (e.state === 'denied' || e.state === 'cancelled'),
  );
  const eligible = executions.filter((e) => !intentional.includes(e));
  const ok = eligible.filter(
    (e) => e.state === 'succeeded' && e.doneMs !== null && e.doneMs - e.fireMs <= 600_000,
  );
  return {
    eligibleExecutions: eligible.length,
    eligibleSteps: eligible.length * stepsPerExecution,
    succeededWithin10Min: ok.length,
    successRate: eligible.length === 0 ? null : ok.length / eligible.length,
    excludedIntentional: intentional.length,
    failedOrQuarantined: eligible.filter((e) => TERMINAL_FAILURE.has(e.state)).length,
    notTerminalAtEnd: eligible.filter(
      (e) => !['succeeded', 'failed', 'quarantined', 'denied', 'cancelled'].includes(e.state),
    ).length,
  };
}

function workerDeaths(deaths, speed) {
  const released = deaths.filter((d) => d.releasedMs !== null);
  const fromLease = released.map((d) => Math.max(0, d.releasedMs - d.leaseUntilMs));
  const fromDeath = released.map((d) => Math.max(0, d.releasedMs - d.diedMs));
  const resumed = deaths.filter((d) => d.resumedMs !== null);
  return {
    injected: deaths.length,
    releasedCount: released.length,
    unreleased: deaths.length - released.length,
    leaseExpiryToRelease: dual(fromLease, speed),
    deathToRelease: dual(fromDeath, speed),
    deathToResume: dual(
      resumed.map((d) => Math.max(0, d.resumedMs - d.diedMs)),
      speed,
    ),
    worstCaseLeaseExpiryToReleaseVirtualMs: fromLease.length === 0 ? null : Math.max(...fromLease),
  };
}

function stopRevoke(revocations, speed) {
  const group = (kind) => {
    const rows = revocations.filter((r) => r.kind === kind);
    const seen = rows.filter((r) => r.observedMs !== null);
    return {
      committed: rows.length,
      observed: seen.length,
      unobserved: rows.length - seen.length,
      ...dual(
        seen.map((r) => Math.max(0, r.observedMs - r.committedMs)),
        speed,
      ),
    };
  };
  return { queued: group('queued'), running: group('running') };
}

function integrity(obs) {
  const keys = Object.entries(obs.remoteApplied);
  const duplicateRemoteWrites = keys.filter(([, n]) => n > 1).length;
  const byKey = new Map(obs.effects.map((e) => [e.key, e]));
  const appliedButUnrecorded = keys.filter(([key, n]) => {
    if (n === 0) return false;
    const row = byKey.get(key);
    return !(
      row !== undefined &&
      (row.state === 'succeeded' || (row.state === 'reconciled' && row.resolution === 'applied'))
    );
  }).length;
  const settled = obs.effects.filter((e) => e.state === 'reconciled').length;
  const unresolved = obs.effects.filter((e) => e.state === 'uncertain').length;
  const stuck = obs.executions.filter((e) => e.state === 'queued' || e.state === 'running').length;
  const noWorkerRow = obs.executions.filter((e) => e.state === null).length;
  return {
    duplicateRemoteWrites,
    duplicateRuns: obs.duplicateRuns,
    replayedWrites: obs.effects.filter((e) => e.writes > 1).length,
    appliedButUnrecorded,
    uncertainEffectsEver: settled + unresolved,
    uncertainEffectsReconciled: settled,
    uncertainEffectsUnresolvedAtEnd: unresolved,
    loss: { noWorkerRow, stuckQueuedOrRunning: stuck, total: noWorkerRow + stuck },
    visibleNotLost: {
      quarantined: obs.executions.filter((e) => e.state === 'quarantined').length,
      awaitingReconciliation: obs.executions.filter((e) => e.state === 'awaiting-reconciliation')
        .length,
    },
  };
}

function judge(observed, ok, sampleOk) {
  if (!sampleOk) return 'insufficient-sample';
  if (observed === null) return 'no-data';
  return ok ? 'within-provisional-target' : 'exceeds-provisional-target';
}

function evaluate(m, targets, speed, sizes) {
  const comparable = speed === 1;
  const p02 = m.P02;
  const p03 = m.P03;
  const p04 = m.P04;
  const p05 = m.P05;
  const lease = p04.leaseExpiryToRelease.virtualMs;
  const stop = [p05.queued.virtualMs, p05.running.virtualMs];
  const stopMax = Math.max(...stop.map((s) => s.max ?? 0));
  const stopN = stop.reduce((a, s) => a + s.n, 0);
  return {
    comparableToLiveTargets: comparable,
    note: comparable
      ? 'Time is uncompressed, but this is still one local machine: not a live or production result.'
      : `Time compressed ${speed}x: fixed real costs (DB round trips, poll ticks) are inflated ${speed}x in virtual time, so latency numbers are indicative only.`,
    P02: {
      target: targets.P02,
      observedP95Ms: p02.virtualMs.p95,
      observedP99Ms: p02.virtualMs.p99,
      sampleSize: p02.virtualMs.n,
      verdict: judge(
        p02.virtualMs.p95,
        p02.virtualMs.p95 <= targets.P02.p95Ms && (p02.virtualMs.p99 ?? 0) <= targets.P02.p99Ms,
        p02.virtualMs.n >= 100,
      ),
    },
    P03: {
      target: targets.P03,
      observedRate: p03.successRate,
      sampleSteps: p03.eligibleSteps,
      verdict: judge(
        p03.successRate,
        (p03.successRate ?? 0) >= targets.P03.minSuccessRate,
        p03.eligibleSteps >= targets.P03.minSteps,
      ),
    },
    P04: {
      target: targets.P04,
      observedWorstCaseMs: lease.max,
      observedMedianMs: lease.p50,
      sampleSize: p04.injected,
      unreleased: p04.unreleased,
      verdict:
        p04.unreleased > 0
          ? 'exceeds-provisional-target'
          : judge(
              lease.max,
              (lease.max ?? 0) <= targets.P04.maxRecoveryMs,
              p04.injected >= targets.P04.minDeaths,
            ),
    },
    P05: {
      target: targets.P05,
      observedWorstCaseMs: stopMax,
      sampleSize: stopN,
      unobserved: p05.queued.unobserved + p05.running.unobserved,
      verdict:
        p05.queued.unobserved + p05.running.unobserved > 0
          ? 'exceeds-provisional-target'
          : judge(stopMax, stopMax <= targets.P05.maxObservationMs, stopN >= 30),
    },
    P01: {
      sizes,
      note: 'Workload shape is recorded in spec and sizes; P01 is a load profile, not a pass/fail value.',
    },
    P06: { verdict: 'AWAITING_OPERATOR', note: 'Restore RTO/RPO need the live operator drill.' },
    P07: { verdict: 'AWAITING_OPERATOR', note: 'A soak cannot establish monthly availability.' },
  };
}

/** Pure: turns observations into the reported metrics. No clocks, no I/O. */
export function computeMetrics(obs, targets = PROVISIONAL_TARGETS) {
  const { speed, executions } = obs;
  const metrics = {
    P02: dueToStart(executions, speed),
    P03: terminalSuccess(executions, obs.stepsPerExecution),
    P04: workerDeaths(obs.deaths, speed),
    P05: stopRevoke(obs.revocations, speed),
    integrity: integrity(obs),
  };
  const sizes = {
    schedules: obs.schedules,
    executions: executions.length,
    steps: executions.length * obs.stepsPerExecution,
    workerDeaths: obs.deaths.length,
    revocations: obs.revocations.length,
  };
  return { metrics, evaluation: evaluate(metrics, targets, speed, sizes), sizes };
}
