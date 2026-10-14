import { analyticsQuerySchema } from './domain.js';
import { reject } from './errors.js';
import { parseSelect } from './parser.js';

import type { AnalyticsMetric, AnalyticsPlan, AnalyticsQuery } from './domain.js';
export function compileMetric(
  query: AnalyticsQuery,
  metrics: readonly AnalyticsMetric[],
): AnalyticsPlan {
  analyticsQuerySchema.parse(query);
  if (query.kind === 'sql')
    return {
      sql: query.sql,
      params: query.params,
      vetted: false,
      metric: null,
      classification: 'PUBLIC',
    };
  const metric = metrics.find((m) => m.name === query.metric);
  if (metric === undefined) reject('METRIC_NOT_FOUND', 404);
  if (
    new Set(query.dimensions).size !== query.dimensions.length ||
    query.dimensions.some((d) => !metric.dimensions.includes(d))
  )
    reject('METRIC_DIMENSION');
  const params = Object.fromEntries(query.filters.map((f, i) => [`filter_${i}`, f.value]));
  const filters = query.filters.map((f, i) => `${f.column} ${f.op} @filter_${i}`).join(' AND ');
  if (!metric.sqlTemplate.includes('{{filters}}') || !metric.sqlTemplate.includes('{{limit}}'))
    reject('METRIC_TEMPLATE');
  const sql = metric.sqlTemplate
    .replaceAll(
      '{{dimensions}}',
      query.dimensions.length === 0 ? '' : `${query.dimensions.join(', ')}, `,
    )
    .replaceAll('{{filters}}', filters.length === 0 ? reject('METRIC_FILTER_REQUIRED') : filters)
    .replaceAll(
      '{{groupBy}}',
      query.dimensions.length === 0 ? '' : `GROUP BY ${query.dimensions.join(', ')}`,
    )
    .replaceAll('{{limit}}', String(query.limit));
  if (sql.includes('{{')) reject('METRIC_TEMPLATE');
  validateTemplate(sql, metric);
  return { sql, params, vetted: true, metric: metric.name, classification: metric.classification };
}

function validateTemplate(sql: string, metric: AnalyticsMetric): void {
  const ast = parseSelect(sql);
  if (
    ast.tables.length !== 1 ||
    ast.tables[0].name !== metric.dataset ||
    !ast.projections.some((p) => p.expression.kind === 'aggregate')
  )
    reject('METRIC_DATASET');
}
