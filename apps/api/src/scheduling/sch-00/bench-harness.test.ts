import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { startDisposablePostgres } from '../../ledger/disposable-postgres.js';

import { machineShape, runBenchmark, runScaling, summarize } from './bench-harness.js';

import type { DisposablePostgres } from '../../ledger/disposable-postgres.js';

function available(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
const live = available();
const fullOut = process.env.SCH00_BENCH_OUT;
let database: DisposablePostgres;
beforeAll(async () => {
  if (live) database = await startDisposablePostgres();
}, 60000);
afterAll(async () => {
  if (live) await database.stop();
});

describe('benchmark harness arithmetic', () => {
  test('summarize reports median and range', () => {
    expect(summarize([3, 1, 2, 10])).toEqual({ n: 4, median: 2.5, min: 1, max: 10 });
    expect(summarize([5])).toEqual({ n: 1, median: 5, min: 5, max: 5 });
  });
});

describe.skipIf(!live)('smoke: both stores drain every due schedule exactly once', () => {
  test.skipIf(fullOut !== undefined)(
    'N=1,2,4 with no duplicates and no missing occurrences',
    async () => {
      const trials = await runBenchmark({
        databaseUrl: database.url,
        schedules: 12,
        dispatchers: [1, 2, 4],
        repetitions: 1,
        batch: 5,
      });
      expect(trials).toHaveLength(6);
      for (const t of trials) {
        expect(t).toMatchObject({ duplicates: 0, missing: 0, occurrencesWon: 12 });
        expect(t.throughputPerSec).toBeGreaterThan(0);
      }
      const proto = trials.filter((t) => t.side === 'rowclaim');
      expect(proto.every((t) => t.outboxRows === 12)).toBe(true);
    },
    120000,
  );

  test.skipIf(fullOut === undefined)(
    'full run writes machine shape and trials',
    async () => {
      const schedules = Number(process.env.SCH00_BENCH_SCHEDULES ?? 200);
      const repetitions = Number(process.env.SCH00_BENCH_REPS ?? 5);
      const shape = await machineShape(database.url);
      const startedAt = new Date().toISOString();
      const trials = await runBenchmark({
        databaseUrl: database.url,
        schedules,
        dispatchers: [1, 2, 4],
        repetitions,
        batch: 10,
      });
      const large = await runBenchmark({
        databaseUrl: database.url,
        schedules: 10000,
        dispatchers: [1, 2, 4],
        repetitions: 3,
        batch: 50,
        sides: ['rowclaim'],
      });
      const scaling = await runScaling(database.url, [50, 100, 200, 400], 3);
      const report = {
        startedAt,
        finishedAt: new Date().toISOString(),
        shape,
        trials,
        large,
        scaling,
      };
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-chosen output path from SCH00_BENCH_OUT, test-only
      mkdirSync(dirname(fullOut!), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- same operator-chosen SCH00_BENCH_OUT path
      writeFileSync(fullOut!, JSON.stringify(report, null, 2));
      expect(
        [...trials, ...large, ...scaling].every((t) => t.duplicates === 0 && t.missing === 0),
      ).toBe(true);
    },
    3_600_000,
  );
});
