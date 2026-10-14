import * as z from 'zod';

const analyticsIdentifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .refine((value) => !['constructor', 'prototype'].includes(value));
export const analyticsClassification = z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
const analyticsValue = z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]);
export const analyticsParams = z
  .record(analyticsIdentifier, analyticsValue)
  .refine((v) => Object.keys(v).length <= 64);
export const analyticsDatasetSchema = z
  .strictObject({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
      .max(129),
    owner: z.string().min(1).max(256),
    partitionColumn: analyticsIdentifier,
    columns: z
      .array(z.strictObject({ name: analyticsIdentifier, classification: analyticsClassification }))
      .min(1)
      .max(128),
    maxBytes: z.number().int().positive().safe(),
  })
  .refine(
    (v) =>
      new Set(v.columns.map((c) => c.name)).size === v.columns.length &&
      v.columns.some((c) => c.name === v.partitionColumn),
  );
export const analyticsMetricSchema = z
  .strictObject({
    name: analyticsIdentifier,
    owner: z.string().min(1).max(256),
    sqlTemplate: z.string().min(1).max(16384),
    dimensions: z.array(analyticsIdentifier).max(32),
    grain: analyticsIdentifier,
    classification: analyticsClassification,
    dataset: analyticsDatasetSchema.shape.name,
  })
  .refine((v) => new Set(v.dimensions).size === v.dimensions.length);
const filters = z
  .array(
    z.strictObject({
      column: analyticsIdentifier,
      op: z.enum(['=', '>=', '<=', '>', '<']),
      value: analyticsValue,
    }),
  )
  .max(32);
const bounds = {
  limit: z.number().int().positive().max(1000),
  maxBytes: z.number().int().positive().safe(),
};
export const analyticsQuerySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('metric'),
    metric: analyticsIdentifier,
    dimensions: z.array(analyticsIdentifier).max(32),
    filters,
    ...bounds,
  }),
  z.strictObject({
    kind: z.literal('sql'),
    sql: z.string().min(1).max(16384),
    params: analyticsParams,
    ...bounds,
  }),
]);
export const analyticsSaveSchema = z.strictObject({
  reportId: z.uuid(),
  title: z.string().min(1).max(256),
  humanValidated: z.literal(true),
  query: analyticsQuerySchema,
});
export const analyticsRerunSchema = z.strictObject({
  versionId: z.uuid(),
  maxBytes: bounds.maxBytes,
});
export type AnalyticsClassification = z.infer<typeof analyticsClassification>;
export type AnalyticsDataset = z.infer<typeof analyticsDatasetSchema>;
export type AnalyticsMetric = z.infer<typeof analyticsMetricSchema>;
export type AnalyticsParams = z.infer<typeof analyticsParams>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type AnalyticsSave = z.infer<typeof analyticsSaveSchema>;
export type AnalyticsValue = z.infer<typeof analyticsValue>;
export type AnalyticsRow = Readonly<Record<string, AnalyticsValue>>;
export type AnalyticsPrincipal = {
  readonly subject: string;
  readonly roles: readonly string[];
  readonly datasets: readonly string[];
};
export type AnalyticsPlan = {
  readonly sql: string;
  readonly params: AnalyticsParams;
  readonly vetted: boolean;
  readonly metric: string | null;
  readonly classification: AnalyticsClassification;
};
export type AnalyticsResult = {
  readonly queryId: string;
  readonly sql: string;
  readonly paramsHash: string;
  readonly vetted: boolean;
  readonly estimatedBytes: number;
  readonly columns: Readonly<Record<string, AnalyticsClassification>>;
  readonly rows: readonly AnalyticsRow[];
};

/** Engine output and persisted evidence are validated at their boundaries. */
export const analyticsRowsSchema = z.array(z.record(analyticsIdentifier, analyticsValue)).max(1000);
export const analyticsAuditSchema = z.strictObject({
  id: z.uuid(),
  subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  paramsHash: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.iso.datetime(),
  outcome: z.enum(['allowed', 'denied', 'failed']),
  reason: z
    .string()
    .regex(/^[A-Z_]{1,128}$/)
    .nullable(),
  vetted: z.boolean(),
  estimatedBytes: z.number().int().nonnegative().safe().nullable(),
  columns: z.record(analyticsIdentifier, analyticsClassification),
  rows: analyticsRowsSchema,
});
export type AnalyticsAudit = z.infer<typeof analyticsAuditSchema>;
