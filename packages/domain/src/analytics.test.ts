import { describe, expect, it } from 'vitest';

import {
  analyticsAuditSchema,
  analyticsDatasetSchema,
  analyticsMetricSchema,
  analyticsQuerySchema,
  analyticsRerunSchema,
  analyticsSaveSchema,
} from './analytics.js';
const dataset = {
  name: 'approved.sales',
  owner: 'finance',
  partitionColumn: 'day',
  maxBytes: 100000,
  columns: [
    { name: 'day', classification: 'PUBLIC' },
    { name: 'amount', classification: 'CONFIDENTIAL' },
  ],
};
const metric = {
  name: 'revenue',
  owner: 'finance',
  dataset: 'approved.sales',
  sqlTemplate:
    'SELECT SUM(amount) AS revenue FROM approved.sales WHERE {{filters}} LIMIT {{limit}}',
  dimensions: ['day'],
  grain: 'day',
  classification: 'CONFIDENTIAL',
};
const query = {
  kind: 'metric',
  metric: 'revenue',
  dimensions: [],
  filters: [{ column: 'day', op: '>=', value: '2026-10-01' }],
  maxBytes: 100000,
  limit: 20,
};
describe('analytics strict domain contracts', () => {
  it('accepts an approved dataset and metric', () => {
    expect(analyticsDatasetSchema.parse(dataset).name).toBe('approved.sales');
    expect(analyticsMetricSchema.parse(metric).name).toBe('revenue');
  });
  it.each([
    'project.approved.sales',
    'approved.*',
    '`approved.sales`',
    'APPROVED.sales',
    'approved.sales;drop',
    'approved.sales@1',
  ])('rejects dataset name %s', (name) =>
    expect(analyticsDatasetSchema.safeParse({ ...dataset, name }).success).toBe(false),
  );
  it('requires an allowlisted partition column', () =>
    expect(
      analyticsDatasetSchema.safeParse({ ...dataset, partitionColumn: 'missing' }).success,
    ).toBe(false));
  it('rejects duplicate column names', () =>
    expect(
      analyticsDatasetSchema.safeParse({
        ...dataset,
        columns: [...dataset.columns, dataset.columns[0]],
      }).success,
    ).toBe(false));
  it('rejects duplicate metric dimensions', () =>
    expect(analyticsMetricSchema.safeParse({ ...metric, dimensions: ['day', 'day'] }).success).toBe(
      false,
    ));
  it.each([0, -1, 1001, Infinity, 1.5])('rejects row limit %s', (limit) =>
    expect(analyticsQuerySchema.safeParse({ ...query, limit }).success).toBe(false),
  );
  it.each([0, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects byte cap %s', (maxBytes) =>
    expect(analyticsQuerySchema.safeParse({ ...query, maxBytes }).success).toBe(false),
  );
  it('rejects unrestricted filter operators', () =>
    expect(
      analyticsQuerySchema.safeParse({
        ...query,
        filters: [{ column: 'day', op: 'OR', value: 'x' }],
      }).success,
    ).toBe(false));
  it('rejects mixed metric and free SQL inputs', () =>
    expect(analyticsQuerySchema.safeParse({ ...query, sql: 'SELECT 1' }).success).toBe(false));
  it('requires a human validated immutable save', () =>
    expect(
      analyticsSaveSchema.safeParse({
        reportId: '14700000-0000-4000-8000-000000000001',
        title: 'Report',
        humanValidated: false,
        query,
      }).success,
    ).toBe(false));
  it('rejects invalid report version identity', () =>
    expect(analyticsRerunSchema.safeParse({ versionId: 'latest', maxBytes: 100 }).success).toBe(
      false,
    ));
  it('rejects nested parameter structures', () =>
    expect(
      analyticsQuerySchema.safeParse({
        kind: 'sql',
        sql: 'SELECT 1',
        params: { start: { raw: 'x' } },
        limit: 1,
        maxBytes: 100,
      }).success,
    ).toBe(false));
});

describe('analytics evidence schema', () => {
  const event = {
    id: '14700000-0000-4000-8000-000000000002',
    subjectHash: 'a'.repeat(64),
    queryHash: 'b'.repeat(64),
    paramsHash: 'c'.repeat(64),
    at: '2026-10-14T10:00:00.000Z',
    outcome: 'denied',
    reason: 'BYTE_CAP_EXCEEDED',
    vetted: true,
    estimatedBytes: 100001,
    columns: {},
    rows: [],
  };
  it('accepts bounded denial evidence', () => {
    expect(analyticsAuditSchema.parse(event)).toEqual(event);
  });
  it('does not permit raw SQL or parameter fields in evidence', () => {
    expect(analyticsAuditSchema.safeParse({ ...event, sql: 'SELECT private data' }).success).toBe(
      false,
    );
    expect(
      analyticsAuditSchema.safeParse({ ...event, params: { secret: 'private' } }).success,
    ).toBe(false);
  });
  it('rejects malformed identifiers and digest values', () => {
    expect(analyticsAuditSchema.safeParse({ ...event, id: 'not-a-uuid' }).success).toBe(false);
    expect(analyticsAuditSchema.safeParse({ ...event, subjectHash: 'alice' }).success).toBe(false);
  });
  it('rejects freeform reasons carrying provider messages', () => {
    expect(
      analyticsAuditSchema.safeParse({ ...event, reason: 'secret credential detail' }).success,
    ).toBe(false);
  });
  it('represents unavailable estimates with null', () => {
    expect(
      analyticsAuditSchema.parse({ ...event, estimatedBytes: null }).estimatedBytes,
    ).toBeNull();
    expect(analyticsAuditSchema.safeParse({ ...event, estimatedBytes: NaN }).success).toBe(false);
  });
});
