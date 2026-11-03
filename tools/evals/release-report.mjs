import { requiredInvariants } from './invariant-check.mjs';

const statuses = new Set(['PASS', 'FAIL', 'UNTESTED', 'DEFER']);
const labelProvenance = { offline: 'offline-fixture', live: 'live-observed' };
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export class ReportRefused extends Error {
  /** @param {'offline-labeled-live' | 'label-provenance-mismatch' | 'invalid-result' | 'invalid-binding'} code */
  constructor(code) {
    super(`release report refused: ${code}`);
    this.name = 'ReportRefused';
    this.code = code;
  }
}

function admitResult(result) {
  if (!result || typeof result.id !== 'string' || !statuses.has(result.status))
    throw new ReportRefused('invalid-result');
  if (!Object.hasOwn(labelProvenance, result.label)) throw new ReportRefused('invalid-result');
  if (result.label === 'live' && result.provenance === 'offline-fixture')
    throw new ReportRefused('offline-labeled-live');
  if (labelProvenance[result.label] !== result.provenance)
    throw new ReportRefused('label-provenance-mismatch');
  if (result.status === 'DEFER' && (!result.optional || !result.deferReason))
    throw new ReportRefused('invalid-result');
  return {
    id: result.id,
    kind: result.kind ?? 'evidence',
    invariant: result.invariant ?? null,
    label: result.label,
    provenance: result.provenance,
    status: result.status,
    optional: result.optional === true,
    deferReason: result.deferReason ?? null,
    ref: result.ref ?? null,
    owner: result.owner ?? null,
  };
}

const untested = (id, kind, invariant, label) => ({
  id,
  kind,
  invariant,
  label,
  provenance: labelProvenance[label],
  status: 'UNTESTED',
  optional: false,
  deferReason: null,
  ref: null,
  owner: null,
});

/**
 * Builds a binding record. Every required invariant gets an explicit deterministic
 * and live row; absent evidence is written as UNTESTED, never omitted.
 */
export function buildReport({
  model = null,
  dataset,
  judge = null,
  sourceSha,
  imageDigests = [],
  results = [],
}) {
  if (!dataset?.version || !dataset.fingerprints) throw new ReportRefused('invalid-binding');
  if (typeof sourceSha !== 'string' || !shaPattern.test(sourceSha))
    throw new ReportRefused('invalid-binding');
  if (!Array.isArray(imageDigests) || imageDigests.some((item) => !digestPattern.test(item)))
    throw new ReportRefused('invalid-binding');
  const admitted = results.map(admitResult);
  const ids = new Set(admitted.map((item) => item.id));
  if (ids.size !== admitted.length) throw new ReportRefused('invalid-result');
  for (const invariant of requiredInvariants) {
    const deterministic = `${invariant}:deterministic`;
    const live = `${invariant}:live`;
    if (!ids.has(deterministic))
      admitted.push(untested(deterministic, 'security', invariant, 'offline'));
    if (!ids.has(live)) admitted.push(untested(live, 'security', invariant, 'live'));
  }
  return {
    schemaVersion: '1.0.0',
    model,
    dataset,
    judge,
    sourceSha,
    imageDigests,
    missingBindings: [
      ...(model ? [] : ['model']),
      ...(judge ? [] : ['judge']),
      ...(imageDigests.length > 0 ? [] : ['imageDigests']),
    ],
    results: admitted,
  };
}

/** Deterministic invariant status from per-file test run outcomes; absent files are UNTESTED. */
export function invariantResultsFromRuns(map, runs) {
  return map.invariants.map((item) => {
    const outcomes = item.deterministic.map(({ file }) => runs[file] ?? 'UNTESTED');
    const status = outcomes.includes('FAIL')
      ? 'FAIL'
      : outcomes.every((outcome) => outcome === 'PASS')
        ? 'PASS'
        : 'UNTESTED';
    return {
      id: `${item.id}:deterministic`,
      kind: 'security',
      invariant: item.id,
      label: 'offline',
      provenance: 'offline-fixture',
      status,
      ref: item.deterministic.map(({ file }) => file).join(', '),
    };
  });
}
