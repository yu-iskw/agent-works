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
export type PoolBudgetInput = z.input<typeof poolBudgetSchema>;

export type PoolBudgetResult = {
  readonly ok: boolean;
  readonly applicationConnections: number;
  readonly reservedConnections: number;
  readonly totalDemand: number;
  readonly limit: number;
  readonly headroom: number;
  readonly perWorkload: ReadonlyMap<string, number>;
};

/**
 * Worst case: every workload at its max instance count with every pooled slot in use,
 * plus the migration and operator reserves, plus what the server withholds.
 * Throws on a malformed worksheet so an unbounded or fractional input cannot pass as zero.
 */
export function computePoolBudget(input: PoolBudgetInput): PoolBudgetResult {
  const budget = poolBudgetSchema.parse(input);
  const perWorkload = new Map<string, number>();
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
