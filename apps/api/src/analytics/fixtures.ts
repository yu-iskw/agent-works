import { createMemoryBudgetPort } from '../finops/memory-budget.js';
import { createMemoryAnalyticsPort } from '../ports/memory/analytics.js';

import { createFixtureEngine } from './fixture-engine.js';
import { createAnalyticsService } from './service.js';

import type {
  AnalyticsDataset,
  AnalyticsMetric,
  AnalyticsPrincipal,
  AnalyticsQuery,
  AnalyticsRow,
} from './domain.js';
import type { AnalyticsPort } from '../ports/analytics.js';
const sales = 'approved.sales';
const customers = 'approved.customers';
const east = 'east';
const firstDay = '2026-10-01';
export const analyticsAt = '2026-10-14T10:00:00.000Z';
export const analyticsReportId = '14700000-0000-4000-8000-000000000001';
export const analyticsPrincipal: AnalyticsPrincipal = {
  subject: 'alice',
  roles: ['analyst'],
  datasets: [sales, customers],
};
export const analyticsDatasets: readonly AnalyticsDataset[] = [
  {
    name: sales,
    owner: 'finance',
    partitionColumn: 'day',
    maxBytes: 100000,
    columns: [
      { name: 'day', classification: 'PUBLIC' },
      { name: 'region', classification: 'INTERNAL' },
      { name: 'amount', classification: 'CONFIDENTIAL' },
      { name: 'customer_id', classification: 'RESTRICTED' },
    ],
  },
  {
    name: customers,
    owner: 'privacy',
    partitionColumn: 'day',
    maxBytes: 100000,
    columns: [
      { name: 'day', classification: 'PUBLIC' },
      { name: 'customer_id', classification: 'RESTRICTED' },
      { name: 'email', classification: 'RESTRICTED' },
    ],
  },
];
export const analyticsMetrics: readonly AnalyticsMetric[] = [
  {
    name: 'revenue',
    owner: 'finance',
    dataset: sales,
    sqlTemplate:
      'SELECT {{dimensions}}SUM(amount) AS revenue FROM approved.sales WHERE {{filters}} {{groupBy}} ORDER BY revenue DESC LIMIT {{limit}}',
    dimensions: ['region', 'day'],
    grain: 'day',
    classification: 'CONFIDENTIAL',
  },
  {
    name: 'mean_sale',
    owner: 'finance',
    dataset: sales,
    sqlTemplate:
      'SELECT {{dimensions}}AVG(amount) AS mean_sale FROM approved.sales WHERE {{filters}} {{groupBy}} ORDER BY mean_sale DESC LIMIT {{limit}}',
    dimensions: ['region', 'day'],
    grain: 'day',
    classification: 'CONFIDENTIAL',
  },
  {
    name: 'sale_count',
    owner: 'finance',
    dataset: sales,
    sqlTemplate:
      'SELECT {{dimensions}}COUNT(amount) AS sale_count FROM approved.sales WHERE {{filters}} {{groupBy}} ORDER BY sale_count DESC LIMIT {{limit}}',
    dimensions: ['region', 'day'],
    grain: 'day',
    classification: 'CONFIDENTIAL',
  },
];
export const analyticsRows: Readonly<Record<string, readonly AnalyticsRow[]>> = {
  [sales]: [
    { day: firstDay, region: east, amount: 10, customer_id: 'c1' },
    { day: '2026-10-02', region: 'west', amount: 20, customer_id: 'c2' },
    { day: '2026-10-03', region: east, amount: 30, customer_id: 'c1' },
    { day: '2026-09-01', region: 'west', amount: 100, customer_id: 'c3' },
  ],
  [customers]: [
    { day: firstDay, customer_id: 'c1', email: 'alice@example.invalid' },
    { day: '2026-10-02', customer_id: 'c2', email: 'bob@example.invalid' },
  ],
};
export const analyticsLimits = { maxRows: 1000, maxJoins: 2, maxBytes: 100000 };
export function revenueQuery(): AnalyticsQuery {
  return {
    kind: 'metric',
    metric: 'revenue',
    dimensions: ['region'],
    filters: [{ column: 'day', op: '>=', value: firstDay }],
    limit: 20,
    maxBytes: 100000,
  };
}
export const analyticsBudgetPolicy = {
  task: {
    approval: 'PLACEHOLDER' as const,
    estimatedCostMicros: 10000,
    inferenceSteps: 10,
    parallelism: 4,
  },
  user: {
    approval: 'PLACEHOLDER' as const,
    estimatedCostMicros: 100000,
    inferenceSteps: 100,
    parallelism: 20,
  },
  mode: 'observe' as const,
};
async function seedAnalytics(port: AnalyticsPort): Promise<void> {
  for (const dataset of analyticsDatasets) await port.putDataset(dataset);
  for (const metric of analyticsMetrics) await port.putMetric(metric);
}
export async function analyticsFixture(port: AnalyticsPort = createMemoryAnalyticsPort()) {
  await seedAnalytics(port);
  const engine = createFixtureEngine(analyticsRows);
  const budget = {
    port: createMemoryBudgetPort(),
    policy: analyticsBudgetPolicy,
    microsPerMillionBytes: 1000,
  };
  const deps = { port, engine, budget, limits: analyticsLimits, now: () => new Date(analyticsAt) };
  return { ...deps, service: createAnalyticsService(deps) };
}
