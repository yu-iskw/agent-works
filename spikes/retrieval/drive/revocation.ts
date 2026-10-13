import { summarizeRevocation } from '../compare/revocation.ts';

import type { RevocationCheck } from '../compare/revocation.ts';

export type PollOptions = {
  readonly changedAt: string;
  readonly sourceObjectId: string;
  readonly attempts: number;
  readonly intervalMs: number;
  /** True only after a successful source access recheck denies the targeted object.
   * Network error, timeout, invalid identity and empty unrelated query are not denial. */
  readonly recheckDenied: (sourceObjectId: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
};

/** Operator-only source revoke/delete polling. No live runner is executed by CI. */
export async function pollRevocation(options: PollOptions) {
  if (
    !Number.isInteger(options.attempts) ||
    options.attempts < 2 ||
    options.attempts > 120 ||
    !Number.isFinite(options.intervalMs) ||
    options.intervalMs < 1 ||
    options.intervalMs > 60_000
  ) {
    throw new Error('invalid polling budget');
  }
  const now = options.now ?? Date.now;
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const checks: RevocationCheck[] = [];
  for (let index = 0; index < options.attempts; index += 1) {
    if (index > 0) await wait(options.intervalMs);
    const denied = await options.recheckDenied(options.sourceObjectId);
    checks.push({
      checkedAt: new Date(now()).toISOString(),
      denied,
      sourceObjectId: options.sourceObjectId,
    });
  }
  return { ...summarizeRevocation(options.changedAt, checks), intervalMs: options.intervalMs };
}
