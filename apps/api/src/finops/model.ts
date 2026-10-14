import * as z from 'zod';

export const priceTableSchema = z.strictObject({
  approval: z.literal('PLACEHOLDER'),
  currency: z.literal('USD'),
  inputTokenMicros: z.number().nonnegative().finite(),
  outputTokenMicros: z.number().nonnegative().finite(),
  cachedTokenMicros: z.number().nonnegative().finite(),
  groundingCallMicros: z.number().nonnegative().finite(),
  computeSecondMicros: z.number().nonnegative().finite(),
  searchCallMicros: z.number().nonnegative().finite(),
  orchestrationTaskMicros: z.number().nonnegative().finite(),
  sqlStorageLoggingTaskMicros: z.number().nonnegative().finite(),
  networkGiBMicros: z.number().nonnegative().finite(),
  thirdPartyTaskMicros: z.number().nonnegative().finite(),
  licenseSeatMonthlyMicros: z.number().nonnegative().finite(),
  securityTaskMicros: z.number().nonnegative().finite(),
  engineeringHourMicros: z.number().nonnegative().finite(),
  sreHourMicros: z.number().nonnegative().finite(),
  securityReviewHourMicros: z.number().nonnegative().finite(),
  approvalHourMicros: z.number().nonnegative().finite(),
});
export type PriceTable = z.infer<typeof priceTableSchema>;
export const trafficSchema = z.strictObject({
  approval: z.literal('PLACEHOLDER'),
  dailyActiveUsers: z.number().int().positive(),
  tasksPerUserPerDay: z.number().nonnegative().finite(),
  days: z.number().int().positive(),
  retrievalRatio: z.number().min(0).max(1),
  turnsPerTask: z.number().nonnegative().finite(),
  inputTokensPerTurn: z.number().int().nonnegative(),
  outputTokensPerTurn: z.number().int().nonnegative(),
  cacheRatio: z.number().min(0).max(1),
  toolCallsPerTask: z.number().nonnegative().finite(),
  groundingCallsPerTask: z.number().nonnegative().finite(),
  runtimeSeconds: z.number().nonnegative().finite(),
  peakFactor: z.number().min(1).finite(),
  completionRatio: z.number().min(0).max(1),
  acceptanceRatio: z.number().min(0).max(1),
  approvalRatio: z.number().min(0).max(1),
  approvalMinutes: z.number().nonnegative().finite(),
  egressGiBPerTask: z.number().nonnegative().finite(),
  indexDocuments: z.number().int().nonnegative(),
  indexChurnRatio: z.number().min(0).max(1),
  indexDocumentMicros: z.number().nonnegative().finite(),
  artifactGiBPerTask: z.number().nonnegative().finite(),
  artifactGiBMicros: z.number().nonnegative().finite(),
  engineeringHours: z.number().nonnegative().finite(),
  sreHours: z.number().nonnegative().finite(),
  securityReviewHours: z.number().nonnegative().finite(),
});
export type Traffic = z.infer<typeof trafficSchema>;
export type CostReport = {
  readonly approval: 'PLACEHOLDER';
  readonly currency: 'USD';
  readonly accepted: number;
  readonly completed: number;
  readonly submitted: number;
  readonly direct: readonly { component: string; estimatedMicros: number }[];
  readonly labor: readonly { component: string; estimatedMicros: number }[];
  readonly directMicros: number;
  readonly laborMicros: number;
  readonly totalMicros: number;
  readonly perCompletedMicros: number | null;
  readonly perAcceptedMicros: number | null;
  readonly capacity: {
    averageConcurrentJobs: number;
    peakConcurrentJobs: number;
    toolCallsPerSecond: number;
    modelTurnsPerSecond: number;
    changedIndexDocuments: number;
    artifactGiB: number;
  };
};
function micros(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || rounded < 0) throw new RangeError('cost overflow');
  return rounded;
}
export function costReport(trafficInput: Traffic, priceInput: PriceTable): CostReport {
  const t = trafficSchema.parse(trafficInput);
  const p = priceTableSchema.parse(priceInput);
  const submitted = t.dailyActiveUsers * t.tasksPerUserPerDay * t.days;
  const completed = submitted * t.completionRatio;
  const accepted = completed * t.acceptanceRatio;
  const turns = submitted * t.turnsPerTask;
  const direct = [
    {
      component: 'model_input',
      estimatedMicros: micros(
        turns * t.inputTokensPerTurn * (1 - t.cacheRatio) * p.inputTokenMicros,
      ),
    },
    {
      component: 'model_output',
      estimatedMicros: micros(turns * t.outputTokensPerTurn * p.outputTokenMicros),
    },
    {
      component: 'model_cache',
      estimatedMicros: micros(turns * t.inputTokensPerTurn * t.cacheRatio * p.cachedTokenMicros),
    },
    {
      component: 'grounding',
      estimatedMicros: micros(submitted * t.groundingCallsPerTask * p.groundingCallMicros),
    },
    {
      component: 'runtime_sandbox',
      estimatedMicros: micros(submitted * t.runtimeSeconds * p.computeSecondMicros),
    },
    {
      component: 'search',
      estimatedMicros: micros(
        submitted * t.retrievalRatio * t.toolCallsPerTask * p.searchCallMicros,
      ),
    },
    {
      component: 'index_ingestion',
      estimatedMicros: micros(
        t.indexDocuments * t.indexChurnRatio * t.days * t.indexDocumentMicros,
      ),
    },
    { component: 'orchestration', estimatedMicros: micros(submitted * p.orchestrationTaskMicros) },
    {
      component: 'sql_storage_kms_logging',
      estimatedMicros: micros(submitted * p.sqlStorageLoggingTaskMicros),
    },
    {
      component: 'artifacts',
      estimatedMicros: micros(submitted * t.artifactGiBPerTask * t.artifactGiBMicros),
    },
    {
      component: 'network',
      estimatedMicros: micros(submitted * t.egressGiBPerTask * p.networkGiBMicros),
    },
    { component: 'third_party', estimatedMicros: micros(submitted * p.thirdPartyTaskMicros) },
    {
      component: 'licensing',
      estimatedMicros: micros((t.dailyActiveUsers * p.licenseSeatMonthlyMicros * t.days) / 30),
    },
    {
      component: 'security_observability',
      estimatedMicros: micros(submitted * p.securityTaskMicros),
    },
  ];
  const labor = [
    {
      component: 'engineering',
      estimatedMicros: micros(t.engineeringHours * p.engineeringHourMicros),
    },
    { component: 'sre', estimatedMicros: micros(t.sreHours * p.sreHourMicros) },
    {
      component: 'security_review',
      estimatedMicros: micros(t.securityReviewHours * p.securityReviewHourMicros),
    },
    {
      component: 'human_approval',
      estimatedMicros: micros(
        ((submitted * t.approvalRatio * t.approvalMinutes) / 60) * p.approvalHourMicros,
      ),
    },
  ];
  const directMicros = micros(direct.reduce((sum, row) => sum + row.estimatedMicros, 0));
  const laborMicros = micros(labor.reduce((sum, row) => sum + row.estimatedMicros, 0));
  const totalMicros = micros(directMicros + laborMicros);
  const perSecond = submitted / (t.days * 86400);
  const averageConcurrentJobs = perSecond * t.runtimeSeconds;
  return {
    approval: 'PLACEHOLDER',
    currency: 'USD',
    submitted,
    completed,
    accepted,
    direct,
    labor,
    directMicros,
    laborMicros,
    totalMicros,
    perCompletedMicros: completed === 0 ? null : micros(totalMicros / completed),
    perAcceptedMicros: accepted === 0 ? null : micros(totalMicros / accepted),
    capacity: {
      averageConcurrentJobs,
      peakConcurrentJobs: Math.ceil(averageConcurrentJobs * t.peakFactor),
      toolCallsPerSecond: perSecond * t.toolCallsPerTask * t.peakFactor,
      modelTurnsPerSecond: perSecond * t.turnsPerTask * t.peakFactor,
      changedIndexDocuments: t.indexDocuments * t.indexChurnRatio * t.days,
      artifactGiB: submitted * t.artifactGiBPerTask,
    },
  };
}
