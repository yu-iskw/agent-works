import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { computePoolBudget } from './db-pool-budget.js';

import type { PoolBudgetInput } from './db-pool-budget.js';

const base: PoolBudgetInput = {
  maxConnections: 100,
  superuserReserved: 3,
  platformReserved: 5,
  migrationReserve: 3,
  operatorReserve: 5,
  workloads: [
    { name: 'api', maxInstances: 8, poolSize: 4 },
    { name: 'worker', maxInstances: 4, poolSize: 3 },
  ],
};

describe('db pool budget', () => {
  it('sums max instances times pool size plus every reserve', () => {
    const result = computePoolBudget(base);
    expect(result.applicationConnections).toBe(8 * 4 + 4 * 3);
    expect(result.reservedConnections).toBe(3 + 5 + 3 + 5);
    expect(result.totalDemand).toBe(44 + 16);
    expect(result.headroom).toBe(40);
    expect(result.ok).toBe(true);
  });

  it('accepts demand exactly at the limit and rejects one connection more', () => {
    const exact = computePoolBudget({ ...base, maxConnections: 60 });
    expect(exact.ok).toBe(true);
    expect(exact.headroom).toBe(0);
    expect(computePoolBudget({ ...base, maxConnections: 59 }).ok).toBe(false);
  });

  it('fails when scaling max instances alone breaks the limit', () => {
    const scaled = computePoolBudget({
      ...base,
      workloads: [{ name: 'api', maxInstances: 100, poolSize: 4 }],
    });
    expect(scaled.ok).toBe(false);
    expect(scaled.headroom).toBeLessThan(0);
  });

  it('counts the migration and operator reserves', () => {
    const without = computePoolBudget({ ...base, maxConnections: 60 });
    const withLargerReserve = computePoolBudget({
      ...base,
      maxConnections: 60,
      operatorReserve: 6,
    });
    expect(without.ok).toBe(true);
    expect(withLargerReserve.ok).toBe(false);
  });

  it.each([
    ['unbounded instances', { name: 'api', maxInstances: Infinity, poolSize: 4 }],
    ['fractional pool', { name: 'api', maxInstances: 2, poolSize: 1.5 }],
    ['zero instances', { name: 'api', maxInstances: 0, poolSize: 4 }],
    ['zero pool', { name: 'api', maxInstances: 2, poolSize: 0 }],
  ])('rejects %s instead of treating it as zero demand', (_label, workload) => {
    expect(() => computePoolBudget({ ...base, workloads: [workload] })).toThrow();
  });

  it('rejects a missing reserve and duplicate workloads', () => {
    expect(() => computePoolBudget({ ...base, migrationReserve: 0 })).toThrow();
    expect(() =>
      computePoolBudget({
        ...base,
        workloads: [
          { name: 'api', maxInstances: 1, poolSize: 1 },
          { name: 'api', maxInstances: 1, poolSize: 1 },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('keeps the committed FND-03 worksheet within the Cloud SQL limit', () => {
    const path = fileURLToPath(
      new URL(
        '../../../docs/plans/enterprise-production-v1/fnd-03/pool-budget.json',
        import.meta.url,
      ),
    );
    const worksheet = JSON.parse(readFileSync(path, 'utf8')) as PoolBudgetInput;
    const result = computePoolBudget(worksheet);
    expect(result.ok).toBe(true);
    expect(result.perWorkload.get('api')).toBe(32);
  });
});
