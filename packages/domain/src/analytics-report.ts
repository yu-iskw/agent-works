import { createHash } from 'node:crypto';

import * as z from 'zod';

import { analyticsClassification, analyticsParams } from './analytics.js';

import type { AnalyticsPlan } from './analytics.js';
export function analyticsHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export const analyticsReportSchema = z.strictObject({
  id: z.uuid(),
  reportId: z.uuid(),
  version: z.number().int().positive(),
  title: z.string().min(1).max(256),
  owner: z.string().min(1).max(256),
  validatedBy: z.string().min(1).max(256),
  validatedAt: z.iso.datetime(),
  sql: z.string().min(1).max(16384),
  params: analyticsParams,
  vetted: z.boolean(),
  metric: z.string().nullable(),
  classification: analyticsClassification,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AnalyticsReport = z.infer<typeof analyticsReportSchema>;
export function analyticsPlanHash(plan: AnalyticsPlan): string {
  return analyticsHash({
    sql: plan.sql,
    params: plan.params,
    vetted: plan.vetted,
    metric: plan.metric,
    classification: plan.classification,
  });
}
