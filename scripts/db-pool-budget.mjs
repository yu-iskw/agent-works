import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { z } from 'zod';

const count = z.number().int().nonnegative().finite();
const positive = z.number().int().positive().finite();

const poolBudgetSchema = z.object({
  /** Operator-confirmed `SHOW max_connections` for the instance. */
  maxConnections: positive,
  /** `superuser_reserved_connections`; unavailable to ordinary roles. */
  superuserReserved: count,
  /** Connections Cloud SQL's own agents may hold; an operator-confirmed assumption. */
  platformReserved: count,
  /** Serialized migration step: one runner at a time, so this is its pool size. */
  migrationReserve: positive,
  /** Break-glass and restore-verification sessions. */
  operatorReserve: positive,
  workloads: z
    .array(
      z.object({
        name: z.string().min(1),
        maxInstances: positive,
        poolSize: positive,
      }),
    )
    .min(1),
});

/** @typedef {z.input<typeof poolBudgetSchema>} PoolBudgetInput */

/**
 * Worst case: every workload at its max instance count with every pooled slot in use,
 * plus the migration and operator reserves, plus what the server withholds.
 * Throws on a malformed worksheet so an unbounded or fractional input cannot pass as zero.
 * @param {PoolBudgetInput} input
 */
export function computePoolBudget(input) {
  const budget = poolBudgetSchema.parse(input);
  const perWorkload = new Map();
  for (const workload of budget.workloads) {
    if (perWorkload.has(workload.name)) throw new Error(`duplicate workload ${workload.name}`);
    perWorkload.set(workload.name, workload.maxInstances * workload.poolSize);
  }
  const applicationConnections = [...perWorkload.values()].reduce((a, b) => a + b, 0);
  const reservedConnections =
    budget.migrationReserve +
    budget.operatorReserve +
    budget.superuserReserved +
    budget.platformReserved;
  const totalDemand = applicationConnections + reservedConnections;
  return {
    ok: totalDemand <= budget.maxConnections,
    applicationConnections,
    reservedConnections,
    totalDemand,
    limit: budget.maxConnections,
    headroom: budget.maxConnections - totalDemand,
    perWorkload,
  };
}

/** The `max` the `postgres` driver uses when a caller sets none. Read from the installed driver. */
export const clientDefaultPoolSize = postgres('postgres://budget@localhost/budget').options.max;

const worksheetPath = fileURLToPath(
  new URL('../docs/plans/enterprise-production-v1/fnd-03/pool-budget.json', import.meta.url),
);

export function readWorksheet(path = worksheetPath) {
  return poolBudgetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Same worksheet with every workload on the driver default pool size, as the code runs today. */
export function withClientDefaults(worksheet) {
  return {
    ...worksheet,
    workloads: worksheet.workloads.map((w) => ({ ...w, poolSize: clientDefaultPoolSize })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const worksheet = readWorksheet();
  for (const [label, input] of [
    ['proposed pool sizes', worksheet],
    [`driver default pool size (${clientDefaultPoolSize})`, withClientDefaults(worksheet)],
  ]) {
    const r = computePoolBudget(input);
    console.log(
      `${label}: demand ${r.totalDemand} (app ${r.applicationConnections} + reserved ${r.reservedConnections}) vs limit ${r.limit}, headroom ${r.headroom}, ${r.ok ? 'OK' : 'FAIL'}`,
    );
  }
}
