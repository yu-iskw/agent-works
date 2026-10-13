export type RevocationCheck = {
  readonly checkedAt: string;
  readonly sourceObjectId: string;
  readonly denied: boolean;
};
export type RevocationObservation = {
  readonly changedAt: string;
  readonly checks: readonly RevocationCheck[];
  readonly revocationLagMs: number | null;
  readonly stable: boolean;
};

/** First of at least two consecutive denied samples. This is a sampled upper bound,
 * not the exact propagation time; callers must keep the polling interval with evidence.
 * An allow after a denial resets stability. Any disclosure remains independently NO-GO. */
export function summarizeRevocation(
  changedAt: string,
  checks: readonly RevocationCheck[],
): RevocationObservation {
  const changed = Date.parse(changedAt);
  if (!Number.isFinite(changed)) throw new Error('invalid change timestamp');
  let previous = changed;
  let firstDenial: number | null = null;
  let deniedCount = 0;
  for (const check of checks) {
    const at = Date.parse(check.checkedAt);
    if (!Number.isFinite(at) || at < previous) throw new Error('invalid polling order');
    previous = at;
    if (check.denied) {
      firstDenial ??= at;
      deniedCount += 1;
    } else {
      firstDenial = null;
      deniedCount = 0;
    }
  }
  const stable = deniedCount >= 2;
  return {
    changedAt,
    checks: [...checks],
    stable,
    revocationLagMs: stable && firstDenial !== null ? firstDenial - changed : null,
  };
}
