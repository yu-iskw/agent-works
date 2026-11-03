// SCH-00 benchmark runner. Starts a disposable Postgres through the harness test and writes the
// raw trials plus machine shape to JSON, then prints the medians and ranges.
//   node scripts/sch-00/run-bench.mjs [out.json]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve(
  process.argv[2] ?? 'docs/plans/enterprise-production-v1/sch-00/bench-results.json',
);
const run = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', 'src/scheduling/sch-00/bench-harness.test.ts'],
  { cwd: 'apps/api', stdio: 'inherit', env: { ...process.env, SCH00_BENCH_OUT: out } },
);
if (run.status !== 0) process.exit(run.status ?? 1);

const report = JSON.parse(readFileSync(out, 'utf8'));
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const group = (trials) => {
  const map = new Map();
  for (const t of trials) {
    const key = `${t.side} S=${t.schedules} N=${t.dispatchers}`;
    map.set(key, [...(map.get(key) ?? []), t]);
  }
  return map;
};
for (const [key, ts] of group([...report.trials, ...report.large])) {
  const tp = ts.map((t) => t.throughputPerSec);
  console.log(
    `${key}  n=${ts.length}  throughput/s median=${median(tp).toFixed(1)} range=${Math.min(...tp).toFixed(1)}..${Math.max(...tp).toFixed(1)}  ` +
      `p95ms=${median(ts.map((t) => t.opLatencyMs.p95)).toFixed(1)}  lockWaiters.mean=${median(ts.map((t) => t.lockWaiters.mean)).toFixed(2)}  ` +
      `dup=${ts.reduce((a, t) => a + t.duplicates, 0)} missing=${ts.reduce((a, t) => a + t.missing, 0)}`,
  );
}
for (const [key, ts] of group(report.scaling))
  console.log(
    `${key}  n=${ts.length}  op p50 ms median=${median(ts.map((t) => t.opLatencyMs.p50)).toFixed(1)}`,
  );
