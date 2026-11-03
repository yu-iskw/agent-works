// node scripts/ops-04/propose-thresholds.mjs [resultsDir] [--out dir]
// Reads result files and PROPOSES target values. It never approves: every output carries
// approved=false and names the human approval it still needs. Results and earlier proposals
// are kept; each run writes a new proposal file.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVISIONAL_TARGETS } from './lib/metrics.mjs';

const HEADROOM = 1.5;

export function loadResults(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('ops04-') && f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

const worst = (values) => (values.length === 0 ? null : Math.max(...values));
const roundUp = (ms, step) => Math.ceil(ms / step) * step;

function lineFor(id, label, unit, provisional, usable, observedOf, sampleOf, sampleNeeded) {
  if (usable.length === 0)
    return {
      id,
      status: 'NO_COMPARABLE_EVIDENCE',
      provisional,
      proposed: provisional,
      rationale: `No uncompressed (speed 1) result with the required sample. Keep the provisional ${label} until one exists.`,
    };
  const observed = worst(usable.map(observedOf));
  const samples = usable.map(sampleOf).reduce((a, b) => a + b, 0);
  const target = Object.values(provisional)[0];
  const within = unit === 'ratio' ? observed >= target : observed <= target;
  return {
    id,
    status: within ? 'PROPOSE_KEEP' : 'PROPOSE_REVIEW',
    provisional,
    observedWorstAcrossRuns: observed,
    samples,
    sampleNeeded,
    runIds: usable.map((r) => r.runId),
    proposed: provisional,
    ...(within
      ? {
          headroom: unit === 'ratio' ? null : Number((target / (observed || 1)).toFixed(2)),
          rationale: `Worst observed ${observed} meets the provisional ${label} across ${usable.length} usable run(s). Single-machine local-synthetic evidence only.`,
        }
      : {
          candidateRelaxed:
            unit === 'ms' ? roundUp(observed * HEADROOM, 10_000) : Number(observed.toFixed(4)),
          rationale: `Worst observed ${observed} misses the provisional ${label}. Investigate the limiter before relaxing; the candidate value is a conversation starter, not a target.`,
        }),
  };
}

export function proposeThresholds(results, now = new Date().toISOString()) {
  const synthetic = results.filter((r) => r.label === 'local-synthetic' && r.schemaVersion === 1);
  const uncompressed = synthetic.filter((r) => r.spec.speed === 1);
  const t = PROVISIONAL_TARGETS;
  const ok = (r, key, min) => r.evaluation[key].sampleSize >= min;
  const lines = [
    lineFor(
      'P02-p95',
      'due-to-start p95',
      'ms',
      { p95Ms: t.P02.p95Ms },
      uncompressed.filter((r) => ok(r, 'P02', 100)),
      (r) => r.evaluation.P02.observedP95Ms,
      (r) => r.evaluation.P02.sampleSize,
      100,
    ),
    lineFor(
      'P02-p99',
      'due-to-start p99',
      'ms',
      { p99Ms: t.P02.p99Ms },
      uncompressed.filter((r) => ok(r, 'P02', 100)),
      (r) => r.evaluation.P02.observedP99Ms,
      (r) => r.evaluation.P02.sampleSize,
      100,
    ),
    lineFor(
      'P03',
      'terminal-success rate',
      'ratio',
      { minSuccessRate: t.P03.minSuccessRate },
      uncompressed.filter((r) => r.evaluation.P03.sampleSteps >= t.P03.minSteps),
      (r) => r.evaluation.P03.observedRate,
      (r) => r.evaluation.P03.sampleSteps,
      t.P03.minSteps,
    ),
    lineFor(
      'P04',
      'lease recovery worst case',
      'ms',
      { maxRecoveryMs: t.P04.maxRecoveryMs },
      uncompressed.filter((r) => r.evaluation.P04.sampleSize >= t.P04.minDeaths),
      (r) => r.evaluation.P04.observedWorstCaseMs,
      (r) => r.evaluation.P04.sampleSize,
      t.P04.minDeaths,
    ),
    lineFor(
      'P05',
      'stop/revoke observation',
      'ms',
      { maxObservationMs: t.P05.maxObservationMs },
      uncompressed.filter((r) => r.evaluation.P05.sampleSize >= 30),
      (r) => r.evaluation.P05.observedWorstCaseMs,
      (r) => r.evaluation.P05.sampleSize,
      30,
    ),
  ];
  return {
    schemaVersion: 1,
    kind: 'threshold-proposal',
    generatedAt: now,
    approved: false,
    approvalRequired:
      'A named human owner approves target values (templates/operator-approval.md and stage gate). This file approves nothing.',
    basis: 'local-synthetic results only; no live evidence',
    resultsConsidered: synthetic.map((r) => ({
      runId: r.runId,
      spec: r.specName,
      speed: r.spec.speed,
      finishedAt: r.finishedAt,
    })),
    resultsIgnored: results.length - synthetic.length,
    lines,
    notApplicable: {
      P06: 'RTO/RPO need the live operator restore drill.',
      P07: 'Monthly availability needs a live observation window.',
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const dir = resolve(
    args.find((a, i) => !a.startsWith('--') && i !== outIndex + 1) ??
      'docs/plans/enterprise-production-v1/ops-04/results',
  );
  const outDir = resolve(outIndex >= 0 ? args[outIndex + 1] : join(dir, '..', 'proposals'));
  const proposal = proposeThresholds(loadResults(dir));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `proposal-${proposal.generatedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(
    `${file}\n` + proposal.lines.map((l) => `${l.id} ${l.status}`).join('\n') + '\n',
  );
}
