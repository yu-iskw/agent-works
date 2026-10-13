import { corpus, forbiddenDocuments, matrix, matrixCase } from './matrix.ts';
import { parseEvidence } from './schema.ts';

import type { EvidenceCase, EvidenceHit, RetrievalEvidence } from './schema.ts';

const unknownSource = 'unknown-source';

export type Thresholds = {
  readonly status: 'proposed' | 'approved';
  readonly approvedBy: string | null;
  readonly minimumRecall: number;
  readonly maximumP95LatencyMs: number;
  readonly maximumRevocationLagMs: number;
};
/** Proposal only; the owner must set approval before an arm can be selected. */
export const proposedThresholds: Thresholds = {
  status: 'proposed',
  approvedBy: null,
  minimumRecall: 0.9,
  maximumP95LatencyMs: 5000,
  maximumRevocationLagMs: 60_000,
};
export type Finding = {
  readonly caseId: string;
  readonly code:
    | 'leak'
    | typeof unknownSource
    | 'provenance'
    | 'missing-case'
    | 'unavailable'
    | 'timing'
    | 'recall'
    | 'latency';
  readonly surface: string | null;
};
export type ArmResult = {
  readonly arm: 'A' | 'B';
  readonly eligible: boolean;
  readonly evidenceProvenance: 'synthetic' | 'observed';
  readonly capturedAt: string;
  readonly featureScope: string;
  readonly availability: RetrievalEvidence['availability'];
  readonly accessIsolation: 'UNVERIFIED' | 'OBSERVED' | 'NO-GO';
  readonly sourceProvenance: 'UNVERIFIED' | 'OBSERVED' | 'NO-GO';
  readonly verdict: 'GO' | 'NO-GO' | 'DEFER' | 'neither';
  readonly findings: readonly Finding[];
  readonly measurements: {
    readonly recall: number | null;
    readonly p95LatencyMs: number | null;
    readonly revocationLagMs: number | null;
    readonly deletionLagMs: number | null;
    readonly costUsd: number | null;
  };
};

function visibleSurfaces(entry: EvidenceCase): readonly { surface: string; text: string }[] {
  return [
    { surface: 'response', text: entry.responseText },
    ...entry.hits.flatMap((hit) => [
      { surface: 'title', text: hit.title },
      { surface: 'snippet', text: hit.snippet },
      { surface: 'content', text: hit.content },
      { surface: 'identifier', text: hit.sourceObjectId },
      { surface: 'provenance', text: JSON.stringify(hit.provenance) },
    ]),
  ];
}

function leaks(entry: EvidenceCase): Finding[] {
  const findings: Finding[] = [];
  const forbidden = forbiddenDocuments(entry.id);
  for (const visible of visibleSurfaces(entry)) {
    const text = visible.text.toLowerCase();
    for (const document of forbidden) {
      // IDs and URIs also reveal existence. Canary detection covers title-only,
      // generated-answer, error-body and cross-document contamination.
      if (
        [document.id, ...Object.values(document.canaries)].some((value) =>
          text.includes(value.toLowerCase()),
        )
      ) {
        findings.push({ caseId: entry.id, code: 'leak', surface: visible.surface });
      }
    }
  }
  return findings;
}

function validProvenance(hit: EvidenceHit, entry: EvidenceCase, capturedAt: string) {
  const provenance = hit.provenance;
  if (!provenance || !provenance.sourceAccessChecked || provenance.subject !== entry.subject)
    return false;
  if (Date.parse(provenance.retrievedAt) > Date.parse(capturedAt)) return false;
  if (entry.checkedAt && Date.parse(provenance.retrievedAt) > Date.parse(entry.checkedAt))
    return false;
  const path = new URL(provenance.sourceUri).pathname.split('/');
  return path.includes(hit.sourceObjectId);
}

function caseFindings(entry: EvidenceCase, capturedAt: string): Finding[] {
  const findings = leaks(entry);
  if (entry.revocationChecks.some((check) => !check.denied)) {
    findings.push({ caseId: entry.id, code: 'leak', surface: 'revocation-recheck' });
  }
  const known = new Set<string>(corpus.map((document) => document.id));
  for (const hit of entry.hits) {
    if (!known.has(hit.sourceObjectId))
      findings.push({ caseId: entry.id, code: unknownSource, surface: 'identifier' });
    if (!validProvenance(hit, entry, capturedAt))
      findings.push({ caseId: entry.id, code: 'provenance', surface: null });
  }
  if (entry.status !== 'ok' || entry.httpStatus !== 200)
    findings.push({ caseId: entry.id, code: 'unavailable', surface: null });
  if (
    (entry.id === 'revoked-member' || entry.id === 'source-deletion') &&
    (!entry.changedAt || !entry.checkedAt || entry.revocationLagMs === null)
  ) {
    findings.push({ caseId: entry.id, code: 'timing', surface: null });
  }
  return findings;
}

export function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function measurements(evidence: RetrievalEvidence): ArmResult['measurements'] {
  if (evidence.provenance !== 'observed' || evidence.cases.length !== matrix.length) {
    return {
      recall: null,
      p95LatencyMs: null,
      revocationLagMs: null,
      deletionLagMs: null,
      costUsd: null,
    };
  }
  let found = 0;
  let expected = 0;
  for (const entry of evidence.cases) {
    const wanted = new Set<string>(matrixCase(entry.id).expected);
    const ids = new Set(entry.hits.map((hit) => hit.sourceObjectId));
    expected += wanted.size;
    found += [...wanted].filter((id) => ids.has(id)).length;
  }
  const latencies = evidence.cases.flatMap((entry) =>
    entry.latencyMs === null ? [] : [entry.latencyMs],
  );
  return {
    recall: found / expected,
    p95LatencyMs: latencies.length === matrix.length ? percentile95(latencies) : null,
    revocationLagMs:
      evidence.cases.find((entry) => entry.id === 'revoked-member')?.revocationLagMs ?? null,
    deletionLagMs:
      evidence.cases.find((entry) => entry.id === 'source-deletion')?.revocationLagMs ?? null,
    costUsd: evidence.costUsd,
  };
}

export function evaluateArm(
  input: unknown,
  thresholds: Thresholds = proposedThresholds,
): ArmResult {
  validateThresholds(thresholds);
  const evidence = parseEvidence(input);
  const findings = evidence.cases.flatMap((entry) => caseFindings(entry, evidence.capturedAt));
  for (const entry of matrix) {
    if (!evidence.cases.some((item) => item.id === entry.id)) {
      findings.push({ caseId: entry.id, code: 'missing-case', surface: null });
    }
  }
  const measured = measurements(evidence);
  const metadata = reportMetadata(evidence, findings);
  // A recorded disclosure is disqualifying even in an incomplete/deferred run.
  const authorizationFailure = findings.some(
    (item) => item.code === 'leak' || item.code === unknownSource || item.code === 'provenance',
  );
  if (authorizationFailure || evidence.verdict === 'NO-GO') {
    return {
      arm: evidence.arm,
      ...metadata,
      eligible: false,
      verdict: 'NO-GO',
      findings,
      measurements: measured,
    };
  }
  if (mustDefer(evidence, findings, measured, thresholds)) {
    return {
      arm: evidence.arm,
      ...metadata,
      eligible: false,
      verdict: 'DEFER',
      findings,
      measurements: measured,
    };
  }
  if (
    measured.revocationLagMs! > thresholds.maximumRevocationLagMs ||
    measured.deletionLagMs! > thresholds.maximumRevocationLagMs
  ) {
    findings.push({ caseId: 'revocation', code: 'timing', surface: null });
    return {
      arm: evidence.arm,
      ...metadata,
      eligible: false,
      verdict: 'NO-GO',
      findings,
      measurements: measured,
    };
  }
  if (measured.recall! < thresholds.minimumRecall)
    findings.push({ caseId: 'matrix', code: 'recall', surface: null });
  if (measured.p95LatencyMs! > thresholds.maximumP95LatencyMs)
    findings.push({ caseId: 'matrix', code: 'latency', surface: null });
  const eligible = findings.length === 0;
  return {
    arm: evidence.arm,
    ...metadata,
    eligible,
    verdict: eligible ? 'GO' : 'neither',
    findings,
    measurements: measured,
  };
}

function mustDefer(
  evidence: RetrievalEvidence,
  findings: readonly Finding[],
  measured: ArmResult['measurements'],
  thresholds: Thresholds,
) {
  const incomplete = findings.some((item) =>
    ['missing-case', 'unavailable', 'timing'].includes(item.code),
  );
  const missingMetrics = [
    measured.recall,
    measured.p95LatencyMs,
    measured.revocationLagMs,
    measured.deletionLagMs,
  ].includes(null);
  return (
    evidence.provenance !== 'observed' ||
    evidence.verdict !== 'GO' ||
    evidence.availability !== 'available' ||
    incomplete ||
    missingMetrics ||
    thresholds.status !== 'approved'
  );
}

function validateThresholds(thresholds: Thresholds) {
  if (
    !Number.isFinite(thresholds.minimumRecall) ||
    thresholds.minimumRecall < 0 ||
    thresholds.minimumRecall > 1 ||
    !Number.isFinite(thresholds.maximumP95LatencyMs) ||
    thresholds.maximumP95LatencyMs <= 0 ||
    !Number.isFinite(thresholds.maximumRevocationLagMs) ||
    thresholds.maximumRevocationLagMs < 0 ||
    (thresholds.status === 'approved' && !thresholds.approvedBy?.trim())
  ) {
    throw new Error('invalid or unsigned thresholds');
  }
}

export function compareArms(
  managed: unknown,
  drive: unknown,
  thresholds: Thresholds = proposedThresholds,
) {
  const a = evaluateArm(managed, thresholds);
  const b = evaluateArm(drive, thresholds);
  if (a.arm !== 'A' || b.arm !== 'B') throw new Error('comparison requires A then B');
  const outcome = chooseOutcome(a, b);
  const aLatency = a.measurements.p95LatencyMs;
  const bLatency = b.measurements.p95LatencyMs;
  return {
    schemaId: 'agent-works.retrieval.comparison',
    schemaVersion: 1,
    matrixId: 'bundle-b-acl-v1',
    outcome,
    thresholds,
    arms: [a, b],
    relativeLatencyBOverA: relativeLatency(aLatency, bLatency),
    blocksIssues: outcome === 'A' || outcome === 'B' ? [] : [23, 24],
    observed: aLatency !== null || bLatency !== null,
  };
}

function chooseOutcome(a: ArmResult, b: ArmResult): 'A' | 'B' | 'NO-GO' | 'DEFER' | 'neither' {
  // RFC-001 prefers managed search. ADR-0003 explicitly permits B when A defers.
  if (a.eligible) return 'A';
  if (b.eligible) return 'B';
  if (a.verdict === 'NO-GO' && b.verdict === 'NO-GO') return 'NO-GO';
  if (a.verdict === 'DEFER' || b.verdict === 'DEFER') return 'DEFER';
  return 'neither';
}

function relativeLatency(a: number | null, b: number | null) {
  if (a === null || a <= 0 || b === null) return null;
  return b / a;
}

function reportMetadata(evidence: RetrievalEvidence, findings: readonly Finding[]) {
  const complete =
    evidence.provenance === 'observed' &&
    evidence.cases.length === matrix.length &&
    evidence.cases.every((entry) => entry.status === 'ok' && entry.httpStatus === 200);
  const accessIsolation = findings.some(
    (item) => item.code === 'leak' || item.code === unknownSource,
  )
    ? 'NO-GO'
    : complete
      ? 'OBSERVED'
      : 'UNVERIFIED';
  const sourceProvenance = findings.some((item) => item.code === 'provenance')
    ? 'NO-GO'
    : complete
      ? 'OBSERVED'
      : 'UNVERIFIED';
  return {
    evidenceProvenance: evidence.provenance,
    capturedAt: evidence.capturedAt,
    featureScope: evidence.featureScope,
    availability: evidence.availability,
    accessIsolation,
    sourceProvenance,
  } as const;
}
