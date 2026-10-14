import * as z from 'zod';

import { modelIdentitySchema, modelKey } from './model-policy.js';

import type { ModelIdentity } from './model-policy.js';
const qualityMetrics = [
  'citationPrecision',
  'groundingCoverage',
  'abstentionAccuracy',
  'toolCallCorrectness',
  'deniedCallRate',
  'searchPrecision',
  'searchRecall',
  'freshnessAccuracy',
  'workflowSuccess',
] as const;
const metric = z.strictObject({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  value: z.number().min(0).max(1).nullable(),
});
/** Extends a tools/evals scoreDataset result; raw case content is deliberately not persisted here. */
const benchmarkReportSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  evidence: z.literal('offline-fakes-only'),
  realServicesGatePassed: z.literal(false),
  caseCount: z.number().int().positive(),
  deferredCount: z.number().int().nonnegative(),
  metrics: z.record(z.enum(qualityMetrics), metric),
  byAclGroup: z.record(z.string(), z.record(z.enum(qualityMetrics), metric)),
  security: z.strictObject({ leaks: z.literal(0), unauthorizedExecutions: z.literal(0) }),
  cases: z.array(
    z.object({
      caseId: z.string().min(1),
      split: z.enum(['dev', 'adversarial']),
      aclGroup: z.string(),
      metrics: z.record(z.enum(qualityMetrics), metric),
    }),
  ),
  dataset: z.strictObject({
    version: z.literal('1.0.0'),
    splits: z.array(z.enum(['dev', 'adversarial'])),
    fingerprints: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  }),
  routingEvidence: z.strictObject({ model: modelIdentitySchema, taskClass: z.string().min(1) }),
});
type BenchmarkReport = z.infer<typeof benchmarkReportSchema>;
function consistent(report: BenchmarkReport): boolean {
  if (report.cases.length !== report.caseCount || report.deferredCount >= report.caseCount)
    return false;
  if (new Set(report.cases.map((row) => row.caseId)).size !== report.caseCount) return false;
  const metrics = [
    ...Object.values(report.metrics),
    ...Object.values(report.byAclGroup).flatMap((group) => Object.values(group)),
    ...report.cases.flatMap((row) => Object.values(row.metrics)),
  ];
  return metrics.every(
    (row) =>
      row.numerator <= row.denominator &&
      row.value === (row.denominator === 0 ? null : row.numerator / row.denominator),
  );
}
function nonInferior(left: BenchmarkReport['metrics'], right: BenchmarkReport['metrics']): boolean {
  return qualityMetrics.every((name) => {
    const baseline = new Map(Object.entries(left)).get(name)!;
    const candidate = new Map(Object.entries(right)).get(name)!;
    return (
      baseline.denominator === candidate.denominator && baseline.numerator <= candidate.numerator
    );
  });
}
/** No user or model supplied "passed" boolean can substitute for measured values. */
export function benchmarkPasses(
  baselineInput: unknown,
  candidateInput: unknown,
  target: ModelIdentity,
  taskClass: string,
): boolean {
  const b = benchmarkReportSchema.safeParse(baselineInput);
  const c = benchmarkReportSchema.safeParse(candidateInput);
  if (!b.success || !c.success) return false;
  const baseline = b.data;
  const candidate = c.data;
  if (!consistent(baseline) || !consistent(candidate)) return false;
  if (
    modelKey(candidate.routingEvidence.model) !== modelKey(target) ||
    candidate.routingEvidence.taskClass !== taskClass
  )
    return false;
  if (baseline.routingEvidence.taskClass !== taskClass) return false;
  if (JSON.stringify(baseline.dataset) !== JSON.stringify(candidate.dataset)) return false;
  if (
    JSON.stringify(baseline.cases.map((row) => [row.caseId, row.split, row.aclGroup])) !==
    JSON.stringify(candidate.cases.map((row) => [row.caseId, row.split, row.aclGroup]))
  )
    return false;
  if (!nonInferior(baseline.metrics, candidate.metrics)) return false;
  return (
    Object.entries(baseline.byAclGroup).every(([group, metrics]) => {
      const other = new Map(Object.entries(candidate.byAclGroup)).get(group);
      return other !== undefined && nonInferior(metrics, other);
    }) &&
    baseline.cases.every((row, index) =>
      nonInferior(row.metrics, candidate.cases.at(index)!.metrics),
    )
  );
}
