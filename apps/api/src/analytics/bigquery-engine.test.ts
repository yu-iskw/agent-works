import { describe, expect, it, vi } from 'vitest';

import { createBigQueryEngine } from './bigquery-engine.js';
import { compileMetric } from './compiler.js';
import {
  analyticsDatasets,
  analyticsLimits,
  analyticsMetrics,
  analyticsPrincipal,
  revenueQuery,
} from './fixtures.js';
import { guardSql } from './sql-guard.js';

import type { BigQueryRequest } from './bigquery-engine.js';
const plan = compileMetric(revenueQuery(), analyticsMetrics);
const query = {
  plan,
  guarded: guardSql(plan.sql, plan.params, analyticsDatasets, analyticsPrincipal, analyticsLimits),
  maxBytes: 100000,
};
function transport(bytes = '512') {
  return {
    dryRun: vi.fn((_request: BigQueryRequest) => Promise.resolve({ totalBytesProcessed: bytes })),
    query: vi.fn((_request: BigQueryRequest) => Promise.resolve([{ region: 'east', revenue: 40 }])),
  };
}
describe('typed BigQuery transport (offline fake)', () => {
  it('passes exact frozen SQL, bound values, region and billing cap', async () => {
    const fake = transport();
    const engine = createBigQueryEngine(fake, { enabled: true, location: 'asia-northeast1' });
    expect(await engine.dryRun(query)).toEqual({ bytes: 512 });
    expect(fake.dryRun).toHaveBeenCalledWith({
      query: plan.sql,
      params: plan.params,
      dryRun: true,
      useLegacySql: false,
      maximumBytesBilled: '100000',
      location: 'asia-northeast1',
    });
    expect(await engine.execute(query)).toEqual([{ region: 'east', revenue: 40 }]);
    expect(fake.query.mock.calls[0][0]).toMatchObject({ dryRun: false });
  });
  it('gates a real transport behind an explicit flag', async () => {
    const fake = transport();
    const engine = createBigQueryEngine(fake, { enabled: false, location: 'asia-northeast1' });
    await expect(engine.dryRun(query)).rejects.toThrow('BIGQUERY_DISABLED');
    expect(fake.dryRun).not.toHaveBeenCalled();
  });
  it('rejects a different inference location', async () => {
    const fake = transport();
    await expect(
      createBigQueryEngine(fake, { enabled: true, location: 'us' }).dryRun(query),
    ).rejects.toThrow('BIGQUERY_LOCATION');
    expect(fake.dryRun).not.toHaveBeenCalled();
  });
  it.each(['-1', 'NaN', 'Infinity', '1.5', '10000000000000000000', '512 bytes', ''])(
    'rejects malformed dry-run estimate %j',
    async (bytes) => {
      await expect(
        createBigQueryEngine(transport(bytes), {
          enabled: true,
          location: 'asia-northeast1',
        }).dryRun(query),
      ).rejects.toThrow('INVALID_ESTIMATE');
    },
  );
  it('propagates cancellation and deadline to both transport operations', async () => {
    const fake = transport();
    const engine = createBigQueryEngine(fake, { enabled: true, location: 'asia-northeast1' });
    const execution = { signal: new AbortController().signal, deadline: Date.now() + 60000 };
    await engine.dryRun({ ...query, execution });
    await engine.execute({ ...query, execution });
    expect(fake.dryRun.mock.calls[0][0]).toMatchObject(execution);
    expect(fake.query.mock.calls[0][0]).toMatchObject(execution);
  });
  it('does not start a transport operation after cancellation or deadline', async () => {
    const fake = transport();
    const engine = createBigQueryEngine(fake, { enabled: true, location: 'asia-northeast1' });
    await expect(
      engine.dryRun({ ...query, execution: { signal: AbortSignal.abort() } }),
    ).rejects.toThrow('ANALYST_CANCELLED');
    expect(() => engine.execute({ ...query, execution: { deadline: Date.now() - 1 } })).toThrow(
      'ANALYST_TIMEOUT',
    );
    expect(fake.dryRun).not.toHaveBeenCalled();
    expect(fake.query).not.toHaveBeenCalled();
  });
});
