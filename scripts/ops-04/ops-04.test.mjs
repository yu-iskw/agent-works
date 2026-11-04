import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { dockerAvailable } from './lib/docker-pg.mjs';
import { computeMetrics } from './lib/metrics.mjs';
import { percentile } from './lib/stats.mjs';
import { planSchedules, validateSpec } from './harness.mjs';
import { loadResults, proposeThresholds } from './propose-thresholds.mjs';
import { runCampaign } from './run.mjs';

const spec = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const distBuilt = [
  '../../apps/api/dist/worker/sweeper.js',
  '../../agents/skills/incident-analysis/dist/deliver.js',
].every((path) => existsSync(new URL(path, import.meta.url)));

const exec = (id, over = {}) => ({
  id,
  fireMs: 0,
  firstStartMs: 5000,
  state: 'succeeded',
  doneMs: 60_000,
  revoked: false,
  quarantineReason: null,
  ...over,
});
const baseObs = (over = {}) => ({
  speed: 1,
  schedules: 3,
  stepsPerExecution: 2,
  executions: [exec('a'), exec('b'), exec('c')],
  deaths: [],
  revocations: [],
  remoteApplied: {},
  effects: [],
  duplicateRuns: 0,
  ...over,
});

describe('workload specs', () => {
  test('full-length spec carries the P01 shape', () => {
    const full = validateSpec(spec('workload-full.json'));
    expect(full.speed).toBe(1);
    expect(full.durationMs).toBe(86_400_000);
    expect(full.executionsPerDay).toBe(5000);
    expect(full.activeSteps).toBe(50);
    expect(full.burst.slots).toBe(500);
    expect(full.schedules - full.burst.slots).toBeGreaterThanOrEqual(10_000);
    expect(full.faults.workerDeaths.count).toBeGreaterThanOrEqual(100);
  });

  test('rejects a step longer than the lease and a burst larger than the population', () => {
    const bad = spec('workload-tiny.json');
    expect(() =>
      validateSpec({ ...bad, timing: { ...bad.timing, stepMs: bad.timing.leaseMs } }),
    ).toThrow(/stepMs/);
    expect(() => validateSpec({ ...bad, burst: { slots: 999, atMs: 0 } })).toThrow(/burst/);
  });

  test('burst schedules share one due instant and the base is staggered', () => {
    const tiny = spec('workload-tiny.json');
    const { plan, periodSeconds } = planSchedules(tiny, 1_000_000);
    const burst = plan.filter((p) => p.burst);
    expect(burst).toHaveLength(tiny.burst.slots);
    expect(new Set(burst.map((p) => p.anchorMs)).size).toBe(1);
    expect(new Set(plan.filter((p) => !p.burst).map((p) => p.anchorMs)).size).toBeGreaterThan(1);
    expect(periodSeconds).toBeGreaterThanOrEqual(60);
  });
});

describe('metrics (pure)', () => {
  test('nearest-rank percentile', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([], 50)).toBeNull();
  });

  test('a clean run reports no loss and no duplicates', () => {
    const { metrics } = computeMetrics(baseObs());
    expect(metrics.integrity.loss.total).toBe(0);
    expect(metrics.integrity.duplicateRemoteWrites).toBe(0);
    expect(metrics.P03.successRate).toBe(1);
  });

  test('detects a duplicate remote write, an unrecorded applied effect and lost work', () => {
    const { metrics } = computeMetrics(
      baseObs({
        executions: [
          exec('a'),
          exec('b', { state: null, firstStartMs: null, doneMs: null }),
          exec('c', { state: 'running', doneMs: null }),
        ],
        remoteApplied: { k1: 2, k2: 1 },
        effects: [{ key: 'k1', state: 'succeeded', resolution: null, writes: 1 }],
      }),
    );
    expect(metrics.integrity.duplicateRemoteWrites).toBe(1);
    expect(metrics.integrity.appliedButUnrecorded).toBe(1);
    expect(metrics.integrity.loss).toEqual({ noWorkerRow: 1, stuckQueuedOrRunning: 1, total: 2 });
    expect(metrics.P02.droppedNeverStarted).toBe(1);
  });

  test('P04 reports the worst case and flags an unreleased lease', () => {
    const deaths = [
      {
        executionId: 'a',
        attempt: 1,
        diedMs: 0,
        leaseUntilMs: 1000,
        releasedMs: 2000,
        resumedMs: 9000,
      },
      {
        executionId: 'b',
        attempt: 1,
        diedMs: 0,
        leaseUntilMs: 1000,
        releasedMs: 301_000,
        resumedMs: null,
      },
      {
        executionId: 'c',
        attempt: 1,
        diedMs: 0,
        leaseUntilMs: 1000,
        releasedMs: null,
        resumedMs: null,
      },
    ];
    const { metrics, evaluation } = computeMetrics(baseObs({ deaths }));
    expect(metrics.P04.leaseExpiryToRelease.virtualMs.p50).toBe(1000);
    expect(metrics.P04.worstCaseLeaseExpiryToReleaseVirtualMs).toBe(300_000);
    expect(metrics.P04.unreleased).toBe(1);
    expect(evaluation.P04.verdict).toBe('exceeds-provisional-target');
  });

  test('excludes intentional revocations from P03 but counts other denials as failures to deliver', () => {
    const { metrics } = computeMetrics(
      baseObs({
        executions: [
          exec('a'),
          exec('b', { state: 'denied', revoked: true, doneMs: null }),
          exec('c', { state: 'denied', doneMs: null }),
        ],
      }),
    );
    expect(metrics.P03.excludedIntentional).toBe(1);
    expect(metrics.P03.eligibleExecutions).toBe(2);
    expect(metrics.P03.successRate).toBe(0.5);
  });

  test('small samples are never judged against a target', () => {
    const { evaluation } = computeMetrics(baseObs());
    expect(evaluation.P02.verdict).toBe('insufficient-sample');
    expect(evaluation.P03.verdict).toBe('insufficient-sample');
    expect(evaluation.P06.verdict).toBe('AWAITING_OPERATOR');
  });

  test('compressed time is never comparable to live targets', () => {
    expect(computeMetrics(baseObs({ speed: 60 })).evaluation.comparableToLiveTargets).toBe(false);
  });
});

describe('threshold proposals', () => {
  const result = (over) => ({
    schemaVersion: 1,
    label: 'local-synthetic',
    runId: 'r1',
    specName: 's',
    finishedAt: 'x',
    spec: { speed: 1 },
    evaluation: {
      P02: { sampleSize: 500, observedP95Ms: 30_000, observedP99Ms: 60_000 },
      P03: { sampleSteps: 6000, observedRate: 0.995 },
      P04: { sampleSize: 120, observedWorstCaseMs: 40_000 },
      P05: { sampleSize: 40, observedWorstCaseMs: 90_000 },
    },
    ...over,
  });

  test('never approves and keeps provisional values without comparable evidence', () => {
    const p = proposeThresholds([result({ spec: { speed: 480 } })]);
    expect(p.approved).toBe(false);
    expect(p.lines.every((l) => l.status === 'NO_COMPARABLE_EVIDENCE')).toBe(true);
    expect(p.lines.find((l) => l.id === 'P04').proposed).toEqual({ maxRecoveryMs: 120_000 });
  });

  test('proposes keep when met, review when missed, and ignores unlabeled results', () => {
    const p = proposeThresholds([result({}), result({ label: 'live', runId: 'x' })]);
    expect(p.resultsConsidered).toHaveLength(1);
    expect(p.resultsIgnored).toBe(1);
    const by = Object.fromEntries(p.lines.map((l) => [l.id, l]));
    expect(by['P02-p95'].status).toBe('PROPOSE_KEEP');
    expect(by.P03.status).toBe('PROPOSE_KEEP');
    expect(by.P05.status).toBe('PROPOSE_REVIEW');
    expect(by.P05.proposed).toEqual({ maxObservationMs: 60_000 });
    expect(by.P05.candidateRelaxed).toBe(140_000);
    expect(p.approved).toBe(false);
  });

  test('loadResults reads only ops04 result files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops04-res-'));
    writeFileSync(join(dir, 'ops04-a.json'), JSON.stringify(result({})));
    writeFileSync(join(dir, 'notes.json'), '{}');
    expect(loadResults(dir)).toHaveLength(1);
  });
});

describe.skipIf(!dockerAvailable() || !distBuilt)(
  'harness against local disposable Postgres (tiny scale)',
  () => {
    test('injects every fault and loses nothing', async () => {
      const out = mkdtempSync(join(tmpdir(), 'ops04-run-'));
      const tiny = fileURLToPath(new URL('workload-tiny.json', import.meta.url));
      const { result, file } = await runCampaign([tiny, '--out', out]);
      expect(JSON.parse(readFileSync(file, 'utf8')).runId).toBe(result.runId);
      expect(result.label).toBe('local-synthetic');
      expect(result.modelCalls).toBe(0);
      expect(result.schemaVersion).toBe(1);
      expect(result.machine.cpuCount).toBeGreaterThan(0);
      expect(result.config.drained).toBe(true);

      const i = result.metrics.integrity;
      expect(i.loss.total).toBe(0);
      expect(i.duplicateRemoteWrites).toBe(0);
      expect(i.duplicateRuns).toBe(0);
      expect(i.appliedButUnrecorded).toBe(0);
      expect(i.uncertainEffectsUnresolvedAtEnd).toBe(0);
      expect(result.outbox.pending).toBe(0);

      expect(result.metrics.P04.injected).toBe(3);
      expect(result.metrics.P04.unreleased).toBe(0);
      expect(result.metrics.P02.virtualMs.n).toBeGreaterThan(50);
      expect(result.metrics.P05.queued.unobserved + result.metrics.P05.running.unobserved).toBe(0);
      expect(result.counters.droppedMessages).toBeGreaterThan(0);
      expect(result.counters.duplicateDeliveries).toBeGreaterThan(0);
      expect(result.faults.map((f) => f.kind).sort()).toEqual([
        'db-crash-restart',
        'provider-ack-lost',
        'queue-drop',
      ]);
      expect(result.evaluation.comparableToLiveTargets).toBe(false);
      expect(result.explain.dueToStart.limiter).toMatch(/redriveAfterMs/);
    }, 240_000);
  },
);
