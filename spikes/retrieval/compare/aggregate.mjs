// @ts-check
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { compareArms, proposedThresholds } from './evaluate.mjs';
import { baseline, bindEvidence } from './fixture-tools.mjs';
import { offlineStage, parseEvidence } from './schema.mjs';

/** Aggregates operator-provided arm observations (sealed #98 C-04 envelopes) into one verdict.
 * An absent arm is UNTESTED and defers. Offline results labeled live are refused, not scored. */
export class AggregateRefused extends Error {
  /** @param {'offline-labeled-live' | 'invalid-evidence' | 'arm-mismatch'} code */
  constructor(code) {
    super(`aggregate refused: ${code}`);
    this.name = 'AggregateRefused';
    this.code = code;
  }
}
const leakCodes = new Set(['leak', 'unknown-source', 'provenance']);
const thresholdsSchema = z.strictObject({
  status: z.enum(['proposed', 'approved']),
  approvedBy: z.string().nullable(),
  minimumRecall: z.number().min(0).max(1),
  maximumP95LatencyMs: z.number().positive(),
  maximumRevocationLagMs: z.number().nonnegative(),
});

/**
 * @param {unknown} input
 * @returns {boolean}
 */
function claimsLiveButIsOffline(input) {
  const parsed = z
    .object({
      evidence: z.object({
        provenance: z.string(),
        configuration: z.object({ featureStage: z.string() }),
      }),
      transcript: z
        .object({
          transcript: z.object({
            id: z.string(),
            provenance: z.object({ kind: z.string() }),
            response: z.object({
              observations: z.array(z.object({ name: z.string(), value: z.unknown() })),
            }),
          }),
        })
        .nullable(),
    })
    .safeParse(input);
  if (!parsed.success || parsed.data.evidence.provenance !== 'observed') return false;
  const { evidence } = parsed.data;
  const transcript = parsed.data.transcript?.transcript;
  if (evidence.configuration.featureStage === offlineStage) return true;
  if (!transcript) return false;
  const live = transcript.response.observations.filter((item) => item.name === 'live-probed');
  return (
    transcript.id.endsWith('.offline') ||
    transcript.provenance.kind !== 'observed' ||
    live.length !== 1 ||
    live[0].value !== true
  );
}

/**
 * @param {'A' | 'B'} arm
 * @param {unknown} input
 */
function admit(arm, input) {
  if (input === null || input === undefined) {
    // No trial or access recorded is not an unavailability finding, so it cannot unlock arm B.
    const absent = { ...baseline(arm), verdict: 'UNVERIFIED', availability: 'not-probed' };
    return { envelope: bindEvidence(absent), supplied: false };
  }
  if (claimsLiveButIsOffline(input)) throw new AggregateRefused('offline-labeled-live');
  try {
    if (parseEvidence(input).arm !== arm) throw new AggregateRefused('arm-mismatch');
    return { envelope: input, supplied: true };
  } catch (error) {
    if (error instanceof AggregateRefused) throw error;
    throw new AggregateRefused('invalid-evidence');
  }
}

/**
 * @param {{ managed?: unknown; drive?: unknown; thresholds?: import('./evaluate.mjs').Thresholds }} inputs
 */
export function aggregate({ managed = null, drive = null, thresholds = proposedThresholds }) {
  const a = admit('A', managed);
  const b = admit('B', drive);
  const comparison = compareArms(a.envelope, b.envelope, thresholds);
  const arms = comparison.arms.map((result, index) => {
    const supplied = index === 0 ? a.supplied : b.supplied;
    const observed = result.evidenceProvenance === 'observed';
    const findings = result.findings;
    const leakFindings = findings.filter((item) => leakCodes.has(item.code));
    const controlFailed = findings.some((item) => item.code === 'positive-control');
    return {
      arm: result.arm,
      status: supplied && observed ? 'OBSERVED' : 'UNTESTED',
      verdict: result.verdict,
      leakFindings,
      positiveControl: !observed ? 'UNTESTED' : controlFailed ? 'FAILED' : 'MET',
      revocationLagMs: result.measurements.revocationLagMs,
      deletionLagMs: result.measurements.deletionLagMs,
      findings,
    };
  });
  const anyLeak = arms.some((item) => item.leakFindings.length > 0 || item.verdict === 'NO-GO');
  return {
    schemaId: 'agent-works.retrieval.aggregate',
    schemaVersion: 1,
    verdict: anyLeak ? 'NO-GO' : comparison.outcome,
    comparisonOutcome: comparison.outcome,
    anyLeak,
    arms,
    relativeLatencyBOverA: comparison.relativeLatencyBOverA,
    thresholds: comparison.thresholds,
    blocksIssues: comparison.blocksIssues,
  };
}

/**
 * @param {string | undefined} path
 * @returns {unknown}
 */
function readOptional(path) {
  // Explicit operator-local evidence path in this read-only CLI.
  return path ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * @param {readonly string[]} args
 */
export function runAggregate(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--managed', '--drive', '--thresholds'].includes(name) || !args[index + 1])
      throw new Error('usage');
    flags.set(name, args[index + 1]);
  }
  const rawThresholds = readOptional(flags.get('--thresholds'));
  return aggregate({
    managed: readOptional(flags.get('--managed')),
    drive: readOptional(flags.get('--drive')),
    thresholds: rawThresholds ? thresholdsSchema.parse(rawThresholds) : proposedThresholds,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(runAggregate(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      error instanceof AggregateRefused
        ? `${error.message}\n`
        : 'aggregate refused: invalid evidence or arguments\n' +
            'usage: node spikes/retrieval/compare/aggregate.mjs [--managed a.json] [--drive b.json] [--thresholds t.json]\n',
    );
    process.exitCode = 1;
  }
}
