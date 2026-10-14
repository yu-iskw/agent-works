import * as z from 'zod';

const usageRowSchema = z.strictObject({
  taskId: z.string().min(1),
  sponsor: z.string().min(1),
  estimatedCostMicros: z.number().int().nonnegative().safe(),
  providerUsageMicros: z.number().int().nonnegative().safe(),
  approval: z.literal('PLACEHOLDER'),
});
export type ProviderUsageRow = z.infer<typeof usageRowSchema>;
/** No assertion that an estimate is a bill. A variance remains evidence for operator review. */
export function reconcileProviderUsage(input: readonly ProviderUsageRow[]) {
  const seen = new Set<string>();
  const rows = input
    .map((value) => {
      const row = usageRowSchema.parse(value);
      if (seen.has(row.taskId)) throw new Error('duplicate provider task');
      seen.add(row.taskId);
      return { ...row, varianceMicros: row.providerUsageMicros - row.estimatedCostMicros };
    })
    .sort((a, b) => a.taskId.localeCompare(b.taskId, 'en'));
  const estimateMicros = rows.reduce((sum, row) => sum + row.estimatedCostMicros, 0);
  const providerMicros = rows.reduce((sum, row) => sum + row.providerUsageMicros, 0);
  if (!Number.isSafeInteger(estimateMicros) || !Number.isSafeInteger(providerMicros))
    throw new RangeError('provider usage overflow');
  return {
    approval: 'PLACEHOLDER',
    rows,
    estimateMicros,
    providerMicros,
    varianceMicros: providerMicros - estimateMicros,
  };
}
